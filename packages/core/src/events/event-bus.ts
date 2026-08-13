import type { AgentEvent, AgentEventType, EventOf } from '@samix/shared';

/**
 * Typed in-process event bus (spec §46).
 *
 * Why not node:events — `EventEmitter` is stringly-typed, so a typo in an event
 * name is a silent no-op that surfaces as "the UI never updates". Here the
 * subscription key is constrained to `AgentEventType` and the handler receives
 * the exact narrowed variant, so a rename breaks the build instead of the
 * product.
 *
 * Delivery guarantees, and the reasoning behind them:
 *   - **Synchronous.** The publisher's `emit` returns after all handlers have
 *     been invoked, which keeps event ordering identical to causal ordering.
 *     The state machine relies on this: a `state.changed` observed by the
 *     transport must reflect the state the machine is actually in.
 *   - **Isolated.** A throwing handler cannot break the publisher or starve
 *     other handlers. Observers must never be able to fail the agent.
 *   - **Snapshot iteration.** Handlers may subscribe/unsubscribe during
 *     dispatch without corrupting the current dispatch.
 */

export type EventHandler<T extends AgentEventType> = (event: EventOf<T>) => void;
export type AnyEventHandler = (event: AgentEvent) => void;
export type Unsubscribe = () => void;

/** Reports a handler that threw, so it can be logged by the owner. */
export type BusErrorHandler = (error: unknown, event: AgentEvent) => void;

export class EventBus {
  private readonly handlers = new Map<AgentEventType, Set<AnyEventHandler>>();
  private readonly wildcards = new Set<AnyEventHandler>();
  private onError: BusErrorHandler | undefined;

  /** Subscribe to one event type. */
  on<T extends AgentEventType>(type: T, handler: EventHandler<T>): Unsubscribe {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const erased = handler as AnyEventHandler;
    set.add(erased);
    return () => {
      set?.delete(erased);
    };
  }

  /** Subscribe once; auto-unsubscribes after the first matching event. */
  once<T extends AgentEventType>(type: T, handler: EventHandler<T>): Unsubscribe {
    const off = this.on(type, ((event: EventOf<T>) => {
      off();
      handler(event);
    }) as EventHandler<T>);
    return off;
  }

  /**
   * Subscribe to every event. Used by the transport (which forwards all events
   * to the UI) and by the audit bridge. Not for feature code — prefer `on`.
   */
  onAny(handler: AnyEventHandler): Unsubscribe {
    this.wildcards.add(handler);
    return () => {
      this.wildcards.delete(handler);
    };
  }

  setErrorHandler(handler: BusErrorHandler | undefined): void {
    this.onError = handler;
  }

  emit(event: AgentEvent): void {
    // Snapshot: a handler may mutate the sets while we dispatch.
    const specific = this.handlers.get(event.type);
    if (specific) {
      for (const handler of [...specific]) this.dispatch(handler, event);
    }
    for (const handler of [...this.wildcards]) this.dispatch(handler, event);
  }

  /**
   * Wait for the next event of a type, with timeout. Used by tests and by the
   * confirmation flow. Always resolves or rejects — never hangs — because an
   * unbounded await inside the agent loop would violate development rule 15.
   */
  waitFor<T extends AgentEventType>(
    type: T,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<EventOf<T>> {
    return new Promise<EventOf<T>>((resolve, reject) => {
      const cleanup = (): void => {
        off();
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        cleanup();
        const error = new Error(`Timed out after ${timeoutMs}ms waiting for "${type}"`);
        error.name = 'TimeoutError';
        reject(error);
      }, timeoutMs);
      const off = this.on(type, (event) => {
        cleanup();
        resolve(event);
      });

      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Handler counts, for diagnostics and leak assertions in tests. */
  stats(): { types: number; handlers: number; wildcards: number } {
    let handlers = 0;
    for (const set of this.handlers.values()) handlers += set.size;
    return { types: this.handlers.size, handlers, wildcards: this.wildcards.size };
  }

  removeAll(): void {
    this.handlers.clear();
    this.wildcards.clear();
  }

  private dispatch(handler: AnyEventHandler, event: AgentEvent): void {
    try {
      handler(event);
    } catch (error) {
      // An observer must never be able to fail the thing it observes.
      try {
        this.onError?.(error, event);
      } catch {
        // Error handler also threw; nothing left to do but not crash.
      }
    }
  }
}

/**
 * Distributive `Omit`. A plain `Omit<Union, K>` collapses the union into a
 * single object type with only the keys common to every member — which for
 * AgentEvent means losing every payload field. Wrapping in a conditional makes
 * the omit apply to each member separately, preserving the discrimination.
 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** Convenience: stamp `at` so publishers do not repeat the timestamp. */
export function publish(bus: EventBus, event: DistributiveOmit<AgentEvent, 'at'>): void {
  bus.emit({ ...event, at: new Date().toISOString() } as AgentEvent);
}
