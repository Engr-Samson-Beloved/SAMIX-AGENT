import { createInterface } from 'node:readline';
import {
  IpcRequestFrameSchema,
  parseRequest,
  type AgentEvent,
  type IpcOutboundFrame,
} from '@samix/shared';
import type { RpcRouter } from '../rpc/router.js';
import type { Runtime } from '../runtime.js';

/**
 * Production transport: newline-delimited JSON over stdin/stdout.
 *
 * ## The stdout rule
 *
 * stdout carries the protocol and NOTHING else. Not a `console.log`, not a
 * dependency's startup banner, not a warning. One stray line corrupts the frame
 * stream and the host sees a hung or lying agent.
 *
 * Two things enforce this rather than hoping:
 *   1. The logger physically cannot target stdout (see logger.ts).
 *   2. `console.log`/`console.info` are rebound to stderr on install, so a
 *      third-party package that prints cannot break the channel.
 *
 * ## Why NDJSON over stdio rather than a socket
 *
 * The sidecar is a child of the Tauri host. Pipes give us lifecycle coupling for
 * free — if the host dies the pipe closes and the agent exits, so a crashed UI
 * can never leave automation running headless on the user's machine. A TCP
 * socket would need its own liveness protocol and would be reachable by other
 * local processes.
 */

export interface StdioTransportOptions {
  readonly runtime: Runtime;
  readonly router: RpcRouter;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  /**
   * Invoked when the host closes the pipe. The transport does NOT tear the
   * process down itself: other transports may also be running (the development
   * bridge), and only the entrypoint knows the full set to stop. Without this,
   * closing stdin left the dev bridge serving requests against a shut-down
   * runtime.
   */
  readonly onDisconnect?: () => void;
}

export class StdioTransport {
  private readonly runtime: Runtime;
  private readonly router: RpcRouter;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly onDisconnect: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;

  constructor(options: StdioTransportOptions) {
    this.runtime = options.runtime;
    this.router = options.router;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.onDisconnect = options.onDisconnect;
  }

  start(): void {
    this.protectStdout();

    this.unsubscribe = this.runtime.bus.onAny((event) => this.sendEvent(event));

    const lines = createInterface({ input: this.input, crlfDelay: Infinity });
    lines.on('line', (line) => void this.onLine(line));
    lines.on('close', () => {
      // Host closed the pipe: shut down rather than linger as an orphan with
      // the ability to drive the user's desktop.
      this.runtime.log.info('stdin closed; shutting down core');
      this.close();
      if (this.onDisconnect) this.onDisconnect();
      else this.runtime.shutdown();
    });

    this.runtime.log.info('stdio transport ready');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async onLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed === '') return;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      this.runtime.log.warn('discarded unparseable IPC frame');
      return;
    }

    const frame = IpcRequestFrameSchema.safeParse(raw);
    if (!frame.success) {
      this.runtime.log.warn('discarded malformed IPC frame');
      return;
    }

    const parsed = parseRequest(frame.data);
    if (!parsed.ok) {
      this.write({ kind: 'response', id: frame.data.id, ok: false, error: parsed.error });
      return;
    }

    const outcome = await this.router.handle(parsed.request);
    this.write(
      outcome.ok
        ? { kind: 'response', id: frame.data.id, ok: true, result: outcome.result }
        : { kind: 'response', id: frame.data.id, ok: false, error: outcome.error },
    );
  }

  private sendEvent(event: AgentEvent): void {
    this.write({ kind: 'event', event });
  }

  private write(frame: IpcOutboundFrame): void {
    if (this.closed) return;
    try {
      this.output.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      process.stderr.write(`[stdio] write failed: ${String(error)}\n`);
    }
  }

  /**
   * Redirect console output to stderr so no dependency can write to the
   * protocol channel. `console.error`/`warn` already target stderr.
   */
  private protectStdout(): void {
    const toStderr =
      (prefix: string) =>
      (...args: unknown[]): void => {
        process.stderr.write(
          `${prefix} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`,
        );
      };
    console.log = toStderr('[console.log]');
    console.info = toStderr('[console.info]');
    console.debug = toStderr('[console.debug]');
  }
}
