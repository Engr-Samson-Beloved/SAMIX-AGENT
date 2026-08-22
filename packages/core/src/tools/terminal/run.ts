import { spawn } from 'node:child_process';

/**
 * Shared child-process runner for `terminal.execute` and the `git.*` tools
 * (spec §22, §40) — "how a process is run safely" has exactly one answer.
 *
 * Always `shell: false` and an argv array, never a command string: there is
 * no shell to reinterpret `;`, `&&`, backticks or `$()` in an argument, so
 * they reach the target program literally rather than as a second command.
 * Callers are the ones who decide *which* executable may run at all
 * (`CommandPolicy` for `terminal.execute`; a fixed `git` for the git tools).
 */

export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Output past this many UTF-8 bytes is dropped, not buffered further. */
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
}

export interface RunOutcome {
  /** `null` when the process was killed (timeout or cancellation) rather than exiting normally. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncatedStdout: boolean;
  readonly truncatedStderr: boolean;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /** Set when the process could not even be spawned — e.g. it does not exist. */
  readonly spawnError?: string;
}

export function run(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunOutcome> {
  const started = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncatedStdout = false;
    let truncatedStderr = false;
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    timer.unref?.();

    const onAbort = (): void => {
      cancelled = true;
      child.kill();
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length >= options.maxOutputBytes) {
        truncatedStdout = true;
        return;
      }
      stdout += chunk.toString('utf8');
      if (stdout.length > options.maxOutputBytes) {
        stdout = stdout.slice(0, options.maxOutputBytes);
        truncatedStdout = true;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= options.maxOutputBytes) {
        truncatedStderr = true;
        return;
      }
      stderr += chunk.toString('utf8');
      if (stderr.length > options.maxOutputBytes) {
        stderr = stderr.slice(0, options.maxOutputBytes);
        truncatedStderr = true;
      }
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode: null,
        stdout,
        stderr,
        truncatedStdout,
        truncatedStderr,
        durationMs: Date.now() - started,
        timedOut,
        cancelled,
        spawnError: error.message,
      });
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode: code,
        stdout,
        stderr,
        truncatedStdout,
        truncatedStderr,
        durationMs: Date.now() - started,
        timedOut,
        cancelled,
      });
    });
  });
}
