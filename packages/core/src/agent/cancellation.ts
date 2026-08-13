/**
 * Cancellation primitives (spec §33, development rule 14).
 *
 * Every asynchronous operation in the agent is cancellable, and cancellation
 * must be *immediate* from the user's point of view — the emergency stop exists
 * because automation is driving their mouse and keyboard.
 *
 * `AbortController` is the standard mechanism and is what tools receive. The
 * additions here are the two things it lacks for our purposes: a recorded reason
 * (so the UI and audit trail can say *why* something stopped) and composition
 * with timeouts.
 */

export type CancelReason = 'user' | 'emergency-stop' | 'timeout' | 'shutdown' | 'superseded';

export class CancellationToken {
  private readonly controller = new AbortController();
  private cancelReason: CancelReason | undefined;
  private cancelDetail = '';

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  get reason(): CancelReason | undefined {
    return this.cancelReason;
  }

  get detail(): string {
    return this.cancelDetail;
  }

  cancel(reason: CancelReason, detail = ''): void {
    // Idempotent: the first cancellation wins, so a timeout firing after a user
    // stop cannot rewrite the reason the user sees.
    if (this.controller.signal.aborted) return;
    this.cancelReason = reason;
    this.cancelDetail = detail;
    this.controller.abort(new DOMException(detail || reason, 'AbortError'));
  }

  /** Throws if cancellation has already happened. Call at step boundaries. */
  throwIfCancelled(): void {
    if (this.cancelled) {
      throw new DOMException(this.cancelDetail || this.cancelReason || 'Cancelled', 'AbortError');
    }
  }
}

/**
 * Race a promise against a timeout and a cancellation signal.
 *
 * Development rule 15 requires timeouts on every external operation. Rather than
 * trusting each tool to implement its own, the executor wraps every invocation
 * in this — so a tool that ignores its `AbortSignal` and hangs still cannot wedge
 * the agent.
 *
 * Note the deliberate limitation, which is a property of the platform and not a
 * bug here: this stops *waiting* for the operation, it cannot force the
 * underlying work to stop. Tools that hold real resources must also honour the
 * signal. Tools are reviewed for this.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  token: CancellationToken,
  label: string,
): Promise<T> {
  const local = new AbortController();
  const forwardCancel = (): void => local.abort(token.signal.reason);
  if (token.cancelled) forwardCancel();
  else token.signal.addEventListener('abort', forwardCancel, { once: true });

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} exceeded its ${timeoutMs}ms budget`);
      error.name = 'TimeoutError';
      local.abort(error);
      reject(error);
    }, timeoutMs);
    // Never let a pending timer keep the process alive on shutdown.
    timer.unref?.();
  });

  try {
    return await Promise.race([operation(local.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    token.signal.removeEventListener('abort', forwardCancel);
  }
}

/** Cancellable sleep. Used by retry backoff; never blocks shutdown. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
