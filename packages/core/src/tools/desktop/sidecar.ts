import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { DesktopAutomationConfig, ToolLogger } from '@samix/shared';
import {
  HandshakeSchema,
  SIDECAR_PROTOCOL_VERSION,
  SidecarError,
  parseFrame,
  type Handshake,
} from './protocol.js';
import { pythonCandidates, sidecarArgs, sidecarRoot, type PythonSource } from './python.js';

/**
 * Client for the Python desktop sidecar (Phase 7 §2, §3).
 *
 * ## Lazy, and mortal
 *
 * Nothing spawns at agent boot. The first desktop tool call starts the process;
 * `idleShutdownMs` of quiet ends it. Warm start is ~400ms measured, which is
 * cheap enough that keeping a process alive "just in case" would be trading a
 * real, permanent resident on the user's machine — one that can move their
 * mouse — for a delay they will not notice.
 *
 * ## One request in flight
 *
 * The sidecar is single-threaded and COM-apartment-bound, so concurrency has to
 * be resolved somewhere. It is resolved here, in a queue, rather than there with
 * a thread pool that UI Automation would not permit anyway.
 *
 * Control ops (`cancel`, `stop`) deliberately bypass that queue and are written
 * straight to stdin, because a cancel that waits behind the operation it is
 * cancelling is not a cancel. Replies are routed by id, so a control reply
 * arriving while a snapshot is still running goes to the right caller.
 *
 * ## Degradation is the designed outcome, not the error path
 *
 * Python may be missing. The dependencies may not be installed. COM may refuse.
 * None of those is allowed to stop the agent starting or to break window
 * management: after `maxRespawns` failures this object goes `degraded` and stays
 * there, every call fails fast with a non-recoverable error, and the caller
 * falls back to the PowerShell implementation and says so in `/status`.
 */

export type SidecarState = 'stopped' | 'starting' | 'ready' | 'degraded';

export interface SidecarStatus {
  readonly state: SidecarState;
  /** Plain-language account for `/status`. Never a bare error string. */
  readonly detail: string;
  readonly handshake: Handshake | undefined;
  /** Unexpected exits recovered from. At the ceiling, the state is `degraded`. */
  readonly respawns: number;
  readonly source: PythonSource | undefined;
}

export interface DesktopSidecarOptions {
  readonly config: () => DesktopAutomationConfig;
  readonly logger: ToolLogger;
  /**
   * Processes whose windows must never be targeted — the agent and its host.
   * Passed on every call rather than computed inside the sidecar, so the rule is
   * visible in the code that owns it (§5: an action targeting the agent's own
   * console window is refused).
   */
  readonly ownPids?: () => readonly number[];
  /** Injected in tests so no Python is required to exercise the protocol. */
  readonly spawnFn?: typeof spawn;
  readonly maxRespawns?: number;
}

interface Pending {
  readonly op: string;
  resolve(value: unknown): void;
  reject(error: SidecarError): void;
  timer: NodeJS.Timeout | undefined;
}

/** Ceiling on unexpected exits before giving up for the session (§3). */
const DEFAULT_MAX_RESPAWNS = 3;

/** The handshake must not be able to hang startup behind a tool's own budget. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

export class DesktopSidecar {
  private readonly options: DesktopSidecarOptions;
  private readonly maxRespawns: number;
  private child: ChildProcess | undefined;
  private readonly pending = new Map<string, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private starting: Promise<void> | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private nextId = 1;
  private generation = 0;

  private state: SidecarState = 'stopped';
  private detail = 'not started';
  private handshake: Handshake | undefined;
  private source: PythonSource | undefined;
  private respawns = 0;
  private disposed = false;

  constructor(options: DesktopSidecarOptions) {
    this.options = options;
    this.maxRespawns = options.maxRespawns ?? DEFAULT_MAX_RESPAWNS;
  }

  status(): SidecarStatus {
    return {
      state: this.state,
      detail: this.detail,
      handshake: this.handshake,
      respawns: this.respawns,
      source: this.source,
    };
  }

  /** True when richer desktop tools can be offered at all. */
  isUsable(): boolean {
    return !this.disposed && this.state !== 'degraded';
  }

  // --- calling ------------------------------------------------------------

  /**
   * Run one operation. Queued behind any operation already in flight.
   *
   * `timeoutMs` is the caller's whole budget, including the wait for the queue —
   * a tool's timeout means "answer me within this", not "have this much time
   * once you start".
   */
  async call<T>(op: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const generation = this.generation;
    const deadline = Date.now() + timeoutMs;

    const run = async (): Promise<T> => {
      if (this.generation !== generation) {
        throw new SidecarError('USER_CANCELLED', 'Cancelled before it started.');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new SidecarError('TIMEOUT', `"${op}" waited past its ${timeoutMs}ms budget.`);
      }
      await this.ensureStarted();
      return (await this.send(op, this.withDefaults(op, params), remaining)) as T;
    };

    // The chain is what serialises calls. `catch` keeps one failure from
    // poisoning every later call: the chain must survive its own rejections.
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    try {
      return await result;
    } finally {
      this.scheduleIdleShutdown();
    }
  }

  /** Fill in the bounds every op honours, from config rather than from code. */
  private withDefaults(op: string, params: Record<string, unknown>): Record<string, unknown> {
    // Every op that looks at windows needs to know which of them are the
    // agent's own. It is a seed, not the answer: the sidecar walks up the
    // process tree from here, because the window the agent appears to live in is
    // usually several levels above the process that asked and none of the
    // processes in between own a window.
    const seedPids = [...(this.options.ownPids?.() ?? [])];
    if (op !== 'snapshot') return { seedPids, ...params };

    const config = this.options.config();
    return {
      seedPids,
      maxDepth: config.maxDepth,
      maxNodes: config.maxNodes,
      timeoutMs: config.snapshotTimeoutMs,
      includeOffscreen: config.includeOffscreen,
      ...params,
    };
  }

  /**
   * Interrupt the operation in flight. Does not clear the queue — that is
   * `emergencyStop`, and the difference is deliberate: "stop this step" and
   * "stop everything" are different instructions from the user.
   */
  cancel(): void {
    this.writeControl('cancel');
  }

  /**
   * Emergency stop (§5). Clears the pending queue rather than setting a flag
   * that something checks later.
   *
   * Both halves are needed. Bumping the generation rejects everything queued on
   * this side; the `stop` frame drains what the sidecar has already accepted.
   * Doing only the first leaves the sidecar working through a backlog nobody is
   * waiting for any more — still moving the mouse after the user asked it to
   * stop, which is the exact failure the key exists to prevent.
   */
  emergencyStop(): void {
    this.generation += 1;
    this.writeControl('stop');
    for (const [id, entry] of this.pending) {
      this.settle(id, entry, new SidecarError('USER_CANCELLED', 'Emergency stop.'));
    }
  }

  private writeControl(op: 'cancel' | 'stop'): void {
    const child = this.child;
    if (!child?.stdin?.writable) return;
    const id = `ctl_${this.nextId++}`;
    // Fire and forget: the reply is informational, and a control op must not be
    // able to fail or block.
    child.stdin.write(`${JSON.stringify({ id, op })}\n`, () => undefined);
  }

  // --- lifecycle ----------------------------------------------------------

  private async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new SidecarError('INTERNAL_ERROR', 'The desktop sidecar was shut down.', false);
    }
    if (this.state === 'degraded') {
      throw new SidecarError('UNSUPPORTED_PLATFORM', this.detail, false);
    }
    if (this.child && this.state === 'ready') return;
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    if (process.platform !== 'win32') {
      this.degrade('Desktop control is implemented for Windows only.');
      throw new SidecarError('UNSUPPORTED_PLATFORM', this.detail, false);
    }
    const config = this.options.config();
    if (!config.enabled) {
      this.degrade('Desktop control is switched off in settings.');
      throw new SidecarError('UNSUPPORTED_PLATFORM', this.detail, false);
    }

    this.state = 'starting';
    const candidates = pythonCandidates(config.pythonPath);
    const failures: string[] = [];

    for (const candidate of candidates) {
      try {
        const handshake = await this.spawnAndHandshake(candidate.command, [
          ...candidate.args,
          ...sidecarArgs(),
        ]);
        if (!handshake.uia) {
          // This interpreter runs but cannot reach UI Automation — almost always
          // because `uiautomation` is not installed in it.
          //
          // That is a fact about the INTERPRETER, not about the machine. An
          // earlier version treated it as the latter and degraded the whole
          // session on the spot, which meant one unsuitable Python on PATH could
          // permanently disable a sidecar that the bundled virtual environment
          // would have run perfectly. So: record it, kill it, try the next
          // candidate. Only when every candidate is unsuitable is that a fact
          // about the machine.
          throw new SidecarError(
            'UNSUPPORTED_PLATFORM',
            `UI Automation is unavailable: ${handshake.uiaDetail}`,
            true,
          );
        }
        this.handshake = handshake;
        this.source = candidate.source;
        this.state = 'ready';
        this.detail =
          `Python ${handshake.python} (${candidate.source}), ` +
          `DPI ${handshake.dpiAwareness}, COM ${handshake.com}`;
        this.options.logger.info('desktop sidecar ready', {
          source: candidate.source,
          python: handshake.python,
          dpi: handshake.dpiAwareness,
          architecture: handshake.architecture,
        });
        return;
      } catch (cause) {
        failures.push(`${candidate.source} (${candidate.command}): ${describe(cause)}`);
        this.killChild();
        // A recoverable failure means "this interpreter did not work" — a
        // missing python, a missing dependency — so the next candidate is worth
        // a try. A non-recoverable one is a fact about the machine, and trying
        // four more interpreters would just take four times as long to reach the
        // same answer.
        if (cause instanceof SidecarError && !cause.recoverable) {
          if (this.status().state !== 'degraded') this.degrade(describe(cause));
          throw cause;
        }
      }
    }

    this.degrade(
      `No working Python for the desktop sidecar. Tried: ${failures.join('; ')}. ` +
        `Run "pnpm setup:desktop" to create one.`,
    );
    throw new SidecarError('UNSUPPORTED_PLATFORM', this.detail, false);
  }

  private spawnAndHandshake(command: string, args: string[]): Promise<Handshake> {
    const spawnFn = this.options.spawnFn ?? spawn;
    const child = spawnFn(command, args, {
      cwd: sidecarRoot(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONPATH: sidecarRoot(), PYTHONIOENCODING: 'utf-8' },
    });
    this.child = child;
    this.attach(child);

    return this.send('ping', {}, HANDSHAKE_TIMEOUT_MS).then((data) => {
      const parsed = HandshakeSchema.safeParse(data);
      if (!parsed.success) {
        throw new SidecarError('INTERNAL_ERROR', 'The desktop sidecar sent a malformed handshake.', false);
      }
      if (parsed.data.protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
        // A version mismatch means a stale sidecar left over from an older
        // install. Guessing at compatibility across a protocol boundary is how
        // an agent ends up sending an action to something that interprets it
        // differently, so it degrades instead.
        this.degrade(
          `The desktop sidecar speaks protocol ${parsed.data.protocolVersion}; ` +
            `this build speaks ${SIDECAR_PROTOCOL_VERSION}.`,
        );
        throw new SidecarError('UNSUPPORTED_PLATFORM', this.detail, false);
      }
      return parsed.data;
    });
  }

  private attach(child: ChildProcess): void {
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => this.onLine(line));
    }
    if (child.stderr) {
      // The sidecar's stderr is diagnostics only; stdout is the protocol. Kept
      // at debug so a chatty traceback cannot flood the user's log.
      const errors = createInterface({ input: child.stderr, crlfDelay: Infinity });
      errors.on('line', (line) => {
        if (line.trim() !== '') this.options.logger.debug('desktop sidecar', { line });
      });
    }
    child.on('error', (error) => this.onExit(`could not be started: ${error.message}`));
    child.on('exit', (code, signal) =>
      this.onExit(signal ? `was killed (${signal})` : `exited with code ${code ?? 'unknown'}`),
    );
  }

  private onLine(line: string): void {
    const frame = parseFrame(line);
    if (!frame) {
      this.options.logger.warn('discarded an unreadable frame from the desktop sidecar');
      return;
    }
    const id = String(frame.id);
    const entry = this.pending.get(id);
    if (!entry) return; // A reply to a control op nobody is waiting on.
    if (frame.ok) {
      this.settle(id, entry, undefined, frame.data);
    } else {
      this.settle(
        id,
        entry,
        new SidecarError(
          frame.error.code,
          frame.error.message,
          frame.error.recoverable,
          frame.error.details,
        ),
      );
    }
  }

  private onExit(reason: string): void {
    const child = this.child;
    this.child = undefined;
    if (this.disposed || this.state === 'stopped') return;
    child?.removeAllListeners();

    const wasReady = this.state === 'ready';
    this.state = 'stopped';

    // Everything in flight failed, and each caller is told so explicitly rather
    // than being left on a promise that never settles. `recoverable: true`
    // because a respawn genuinely may fix it (§3).
    const error = new SidecarError('INTERNAL_ERROR', `The desktop sidecar ${reason}.`, true);
    for (const [id, entry] of this.pending) this.settle(id, entry, error);

    if (!wasReady) return;
    this.respawns += 1;
    this.options.logger.warn('desktop sidecar exited unexpectedly', {
      reason,
      respawns: this.respawns,
      ceiling: this.maxRespawns,
    });
    if (this.respawns >= this.maxRespawns) {
      this.degrade(
        `The desktop sidecar exited ${this.respawns} times this session (${reason}); ` +
          `falling back to the slower PowerShell path.`,
      );
    }
  }

  private degrade(detail: string): void {
    this.state = 'degraded';
    this.detail = detail;
    this.handshake = undefined;
    this.options.logger.warn('desktop sidecar unavailable', { detail });
  }

  // --- framing ------------------------------------------------------------

  private send(op: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin?.writable) {
      return Promise.reject(new SidecarError('INTERNAL_ERROR', 'The desktop sidecar is not running.'));
    }
    const id = String(this.nextId++);

    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { op, resolve, reject, timer: undefined };
      entry.timer = setTimeout(() => {
        // Tell the sidecar to stop walking before giving up on it. Without this
        // the process keeps working on an answer nobody will read, and the next
        // call queues behind it.
        this.cancel();
        this.settle(
          id,
          entry,
          new SidecarError('TIMEOUT', `"${op}" did not answer within ${timeoutMs}ms.`),
        );
      }, timeoutMs);
      entry.timer.unref?.();
      this.pending.set(id, entry);

      child.stdin?.write(`${JSON.stringify({ id, op, params })}\n`, (error) => {
        if (error) {
          this.settle(
            id,
            entry,
            new SidecarError('INTERNAL_ERROR', `Could not reach the desktop sidecar: ${error.message}`),
          );
        }
      });
    });
  }

  private settle(id: string, entry: Pending, error?: SidecarError, value?: unknown): void {
    if (!this.pending.delete(id)) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(value);
  }

  // --- idle ---------------------------------------------------------------

  private scheduleIdleShutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.disposed || !this.child) return;
    const after = this.options.config().idleShutdownMs;
    this.idleTimer = setTimeout(() => {
      if (this.pending.size > 0) return;
      this.options.logger.debug('desktop sidecar idle; shutting it down', { after });
      void this.shutdown();
    }, after);
    // Unreferenced on purpose: an idle-shutdown timer must never be the reason
    // the agent process stays alive.
    this.idleTimer.unref?.();
  }

  /** Ask the sidecar to exit cleanly, leaving this client able to start again. */
  private async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.state = 'stopped';
    this.child = undefined;
    child.removeAllListeners();
    try {
      child.stdin?.write(`${JSON.stringify({ id: 'bye', op: 'shutdown' })}\n`);
      child.stdin?.end();
    } catch {
      // Already gone; the kill below is the backstop.
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 2_000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private killChild(): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.removeAllListeners();
    child.kill();
  }

  /** Final teardown. After this the client cannot be restarted. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const error = new SidecarError('USER_CANCELLED', 'The agent is shutting down.', false);
    for (const [id, entry] of this.pending) this.settle(id, entry, error);
    await this.shutdown();
    this.state = 'stopped';
    this.detail = 'shut down';
  }
}

function describe(cause: unknown): string {
  if (cause instanceof SidecarError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
