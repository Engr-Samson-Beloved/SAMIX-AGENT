import { AGENT_STATES, TERMINAL_STATES, type AgentState } from '@samix/shared';

/**
 * Agent state machine (spec §27).
 *
 * Spec §77 is explicit that the runtime must be "a robust state machine rather
 * than an uncontrolled recursive loop". So transitions are declared as data and
 * validated at runtime: an illegal transition is a programming error that throws
 * immediately, in development, at the point of the mistake — rather than leaving
 * the agent in an incoherent state where the UI shows "listening" while
 * automation is still driving the mouse.
 *
 * The table below is the authoritative answer to "what can the agent do next".
 */

/** Legal successors for each state. */
const TRANSITIONS: Readonly<Record<AgentState, readonly AgentState[]>> = {
  // At rest. Voice (Phase 2) moves to `listening`; typed input and the
  // scheduler go straight to `understanding`.
  idle: ['listening', 'transcribing', 'understanding', 'failed'],

  // Microphone open. `idle` covers the user cancelling before speaking.
  listening: ['transcribing', 'idle', 'cancelled', 'failed'],

  transcribing: ['understanding', 'idle', 'cancelled', 'failed'],

  // Intent resolution. May complete immediately for a conversational reply that
  // needs no tools at all ("what's the date?").
  understanding: ['planning', 'completed', 'cancelled', 'failed'],

  planning: ['executing', 'awaiting_confirmation', 'completed', 'cancelled', 'failed'],

  // Blocked on the human. Only the user's answer moves this forward, so there is
  // no timeout edge here by design (spec §94: "the system must pause").
  awaiting_confirmation: ['executing', 'cancelled', 'failed', 'completed'],

  executing: ['observing', 'verifying', 'awaiting_confirmation', 'recovering', 'cancelled', 'failed'],

  // Collect the post-action world state that verification will judge.
  observing: ['verifying', 'recovering', 'cancelled', 'failed'],

  // Verification decides: next step, re-plan, or done. Spec §29 makes this
  // unavoidable — there is no edge from `executing` straight to `completed`.
  verifying: ['executing', 'planning', 'recovering', 'completed', 'failed', 'cancelled'],

  // Bounded retry/re-plan (spec §30). Cannot reach `completed` directly: a
  // recovered task must be re-verified before it may claim success.
  recovering: ['planning', 'executing', 'failed', 'cancelled'],

  // Terminal states. Only `idle` follows, when the next task begins.
  completed: ['idle'],
  failed: ['idle'],
  cancelled: ['idle'],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: AgentState,
    readonly to: AgentState,
  ) {
    super(
      `Illegal agent transition ${from} → ${to}. Legal from "${from}": ${TRANSITIONS[from].join(', ') || '(none)'}.`,
    );
    this.name = 'IllegalTransitionError';
  }
}

export type TransitionListener = (from: AgentState, to: AgentState) => void;

export class AgentStateMachine {
  private current: AgentState;
  private readonly listeners = new Set<TransitionListener>();
  /** Bounded trail of recent transitions, for diagnostics and the timeline. */
  private readonly history: { from: AgentState; to: AgentState; at: string }[] = [];
  private static readonly HISTORY_LIMIT = 200;

  constructor(initial: AgentState = 'idle') {
    this.current = initial;
  }

  get state(): AgentState {
    return this.current;
  }

  get isTerminal(): boolean {
    return (TERMINAL_STATES as readonly AgentState[]).includes(this.current);
  }

  /** Is this transition permitted right now? */
  can(to: AgentState): boolean {
    return TRANSITIONS[this.current].includes(to);
  }

  /** Legal next states, for diagnostics and UI affordances. */
  next(): readonly AgentState[] {
    return TRANSITIONS[this.current];
  }

  /**
   * Perform a transition. Throws `IllegalTransitionError` on an illegal edge.
   *
   * Throwing rather than silently ignoring is the point: a caller that asks for
   * an impossible transition has a logic bug, and swallowing it would hide the
   * bug behind a UI that no longer matches reality.
   */
  transition(to: AgentState): void {
    if (to === this.current) return; // idempotent no-op
    if (!this.can(to)) throw new IllegalTransitionError(this.current, to);
    this.commit(to);
  }

  /**
   * Force a transition to a terminal state, bypassing the table.
   *
   * Reserved for cancellation and unrecoverable failure. Emergency stop (spec
   * §33) must work from *any* state including ones with no legal edge to
   * `cancelled`, and a crash handler must be able to reach `failed`. Everything
   * else uses `transition`.
   */
  forceTerminal(to: 'cancelled' | 'failed'): void {
    if (this.current === to) return;
    this.commit(to);
  }

  /** Return to rest, ready for the next task. */
  reset(): void {
    if (this.current === 'idle') return;
    this.commit('idle');
  }

  onTransition(listener: TransitionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recentHistory(limit = 20): ReadonlyArray<{ from: AgentState; to: AgentState; at: string }> {
    return this.history.slice(Math.max(0, this.history.length - limit));
  }

  private commit(to: AgentState): void {
    const from = this.current;
    this.current = to;

    this.history.push({ from, to, at: new Date().toISOString() });
    if (this.history.length > AgentStateMachine.HISTORY_LIMIT) this.history.shift();

    for (const listener of [...this.listeners]) {
      try {
        listener(from, to);
      } catch {
        // A listener must not be able to corrupt the machine's state. The state
        // has already been committed above; observers failing is their problem.
      }
    }
  }
}

/**
 * Exhaustiveness guard for the transition table. Called by the unit tests to
 * prove every declared state has an entry — so adding a state to AGENT_STATES
 * without wiring its transitions fails the build rather than crashing at runtime.
 */
export function assertTransitionTableComplete(): void {
  for (const state of AGENT_STATES) {
    if (!(state in TRANSITIONS)) {
      throw new Error(`State "${state}" has no entry in the transition table.`);
    }
    for (const target of TRANSITIONS[state]) {
      if (!AGENT_STATES.includes(target)) {
        throw new Error(`State "${state}" declares unknown target "${target}".`);
      }
    }
  }
}

/** Exposed read-only for tests and diagnostics. */
export const TRANSITION_TABLE: Readonly<Record<AgentState, readonly AgentState[]>> = TRANSITIONS;
