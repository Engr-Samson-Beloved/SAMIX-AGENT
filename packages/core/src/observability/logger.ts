import fs from 'node:fs';
import path from 'node:path';
import { LOG_LEVEL_RANK, LOG_RING_CAPACITY, type LogEntry, type LogLevel } from '@samix/shared';
import { RingBuffer } from './ring-buffer.js';
import { redactFields, redactString } from './redact.js';

/**
 * Structured logger (spec §37, §92).
 *
 * Why hand-rolled rather than pino/winston (development rule 20 — no
 * unnecessary dependencies): this logger has three requirements that a general
 * library would need custom transports to satisfy anyway —
 *
 *   1. **stdout is forbidden.** stdout is the sidecar's IPC channel (ADR-0003).
 *      A single stray log line on stdout corrupts the protocol stream. This
 *      writer physically cannot target stdout.
 *   2. **Mandatory redaction on the write path** (see redact.ts).
 *   3. **Fan-out to three sinks** — file, in-memory ring for the UI, and the
 *      event bus for live streaming.
 *
 * Writes are synchronous appends. That is a deliberate trade: log volume is low
 * (human-paced actions, not request throughput) and synchronous writes mean a
 * crash cannot lose the lines explaining the crash. If volume ever grows this
 * becomes a batched async writer behind the same interface.
 */

export interface LoggerOptions {
  readonly logFile: string;
  readonly level: LogLevel;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  /** Mirror to stderr — never stdout. Useful in dev. */
  readonly stderr: boolean;
  readonly ringCapacity?: number;
}

/** Sink invoked for every entry, used to bridge logs onto the event bus. */
export type LogSink = (entry: LogEntry) => void;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Always written regardless of level threshold. */
  audit(message: string, fields?: Record<string, unknown>): void;
  /** Derive a logger with a narrower scope and/or bound taskId. */
  child(scope: string, bindings?: { taskId?: string }): Logger;
}

export class LoggerService {
  private readonly ring: RingBuffer<LogEntry>;
  private readonly sinks = new Set<LogSink>();
  private options: LoggerOptions;
  private stream: fs.WriteStream | undefined;
  private bytesWritten = 0;
  private closed = false;

  constructor(options: LoggerOptions) {
    this.options = options;
    this.ring = new RingBuffer<LogEntry>(options.ringCapacity ?? LOG_RING_CAPACITY);
    this.openStream();
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /** Root logger for a subsystem. */
  scoped(scope: string): Logger {
    return this.makeLogger(scope, {});
  }

  addSink(sink: LogSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  tail(limit: number, minLevel?: LogLevel): LogEntry[] {
    const entries = this.ring.toArray();
    const filtered =
      minLevel === undefined
        ? entries
        : entries.filter(
            // `audit` always passes the filter: it is a category, not a severity.
            (e) => e.level === 'audit' || LOG_LEVEL_RANK[e.level] >= LOG_LEVEL_RANK[minLevel],
          );
    return filtered.slice(Math.max(0, filtered.length - limit));
  }

  /** Applied when the user changes logging settings, without a restart. */
  setLevel(level: LogLevel): void {
    this.options = { ...this.options, level };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream?.end();
    this.stream = undefined;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private makeLogger(scope: string, bindings: { taskId?: string }): Logger {
    const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
      this.emit(level, scope, message, fields, bindings.taskId);
    };
    return {
      debug: (m, f) => write('debug', m, f),
      info: (m, f) => write('info', m, f),
      warn: (m, f) => write('warn', m, f),
      error: (m, f) => write('error', m, f),
      audit: (m, f) => write('audit', m, f),
      child: (childScope, childBindings) =>
        this.makeLogger(`${scope}.${childScope}`, { ...bindings, ...childBindings }),
    };
  }

  private shouldWrite(level: LogLevel): boolean {
    if (level === 'audit') return true; // never suppressed
    return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[this.options.level];
  }

  private emit(
    level: LogLevel,
    scope: string,
    message: string,
    fields: Record<string, unknown> | undefined,
    taskId: string | undefined,
  ): void {
    if (!this.shouldWrite(level)) return;

    const redactedFields = redactFields(fields);
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      scope,
      // Redact the message too — errors routinely interpolate values.
      message: redactString(message),
      ...(redactedFields && Object.keys(redactedFields).length > 0
        ? { fields: redactedFields }
        : {}),
      ...(taskId ? { taskId } : {}),
    };

    this.ring.push(entry);
    this.writeToFile(entry);

    if (this.options.stderr) {
      process.stderr.write(`${formatHuman(entry)}\n`);
    }

    for (const sink of this.sinks) {
      try {
        sink(entry);
      } catch {
        // A failing sink must never break logging or bubble into the caller.
        // Intentionally swallowed: reporting it here would recurse.
      }
    }
  }

  private openStream(): void {
    try {
      fs.mkdirSync(path.dirname(this.options.logFile), { recursive: true });
      this.bytesWritten = fs.existsSync(this.options.logFile)
        ? fs.statSync(this.options.logFile).size
        : 0;
      this.stream = fs.createWriteStream(this.options.logFile, { flags: 'a' });
      this.stream.on('error', (error) => {
        // Disk full, permissions, antivirus lock. Degrade to stderr rather than
        // taking the agent down: losing logs is bad, crashing mid-task is worse.
        process.stderr.write(`[logger] write stream error: ${String(error)}\n`);
        this.stream = undefined;
      });
    } catch (error) {
      process.stderr.write(`[logger] cannot open log file: ${String(error)}\n`);
      this.stream = undefined;
    }
  }

  private writeToFile(entry: LogEntry): void {
    if (!this.stream || this.closed) return;
    const line = `${JSON.stringify(entry)}\n`;
    const size = Buffer.byteLength(line);

    if (this.bytesWritten + size > this.options.maxFileBytes) {
      this.rotate();
    }

    this.stream?.write(line);
    this.bytesWritten += size;
  }

  /**
   * Size-based rotation: samix.log → samix.log.1 → … → samix.log.N, oldest
   * discarded. Kept simple and synchronous; there is exactly one writer process.
   */
  private rotate(): void {
    try {
      this.stream?.end();
      this.stream = undefined;

      const { logFile, maxFiles } = this.options;
      const oldest = `${logFile}.${maxFiles}`;
      if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });

      for (let i = maxFiles - 1; i >= 1; i -= 1) {
        const from = `${logFile}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${logFile}.${i + 1}`);
      }
      if (fs.existsSync(logFile)) fs.renameSync(logFile, `${logFile}.1`);
    } catch (error) {
      process.stderr.write(`[logger] rotation failed: ${String(error)}\n`);
    } finally {
      this.bytesWritten = 0;
      this.openStream();
    }
  }
}

/** Human-readable single line, matching the spec §92 log style. */
export function formatHuman(entry: LogEntry): string {
  const time = entry.timestamp.slice(11, 19);
  const level = entry.level.toUpperCase().padEnd(5);
  const task = entry.taskId ? ` (${entry.taskId})` : '';
  const fields =
    entry.fields && Object.keys(entry.fields).length > 0 ? ` ${JSON.stringify(entry.fields)}` : '';
  return `[${time}] ${level} ${entry.scope}${task} ${entry.message}${fields}`;
}

/**
 * Logger that discards everything. For unit tests of modules that require a
 * Logger but whose logging is not under test.
 */
export function nullLogger(): Logger {
  const self: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    audit: () => {},
    child: () => self,
  };
  return self;
}
