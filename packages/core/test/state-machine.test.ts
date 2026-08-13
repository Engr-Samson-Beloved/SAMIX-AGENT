import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentStateMachine,
  IllegalTransitionError,
  TRANSITION_TABLE,
  assertTransitionTableComplete,
} from '../dist/index.js';
import { excludes, includes, matchObject, spy } from './helpers.ts';

describe('AgentStateMachine', () => {
  it('declares transitions for every state in the shared state list', () => {
    assert.doesNotThrow(() => assertTransitionTableComplete());
  });

  it('walks the happy path from idle to completed', () => {
    const m = new AgentStateMachine();
    for (const state of [
      'understanding',
      'planning',
      'executing',
      'observing',
      'verifying',
      'completed',
    ] as const) {
      m.transition(state);
    }
    assert.equal(m.state, 'completed');
    assert.equal(m.isTerminal, true);
  });

  it('refuses an illegal transition rather than corrupting its state', () => {
    const m = new AgentStateMachine();
    assert.throws(() => m.transition('executing'), IllegalTransitionError);
    assert.equal(m.state, 'idle', 'a rejected transition must not move the machine');
  });

  /**
   * Spec §29: verification is mandatory. The state machine, not just the
   * orchestrator, must make "execute then declare success" structurally
   * impossible.
   */
  it('has no direct edge from executing or observing to completed', () => {
    excludes(TRANSITION_TABLE.executing, 'completed', 'executing');
    excludes(TRANSITION_TABLE.observing, 'completed', 'observing');
    excludes(TRANSITION_TABLE.recovering, 'completed', 'recovering');
    includes(TRANSITION_TABLE.verifying, 'completed', 'verifying');
  });

  it('allows emergency stop from any state via forceTerminal', () => {
    for (const state of ['listening', 'planning', 'executing', 'awaiting_confirmation'] as const) {
      const m = new AgentStateMachine(state);
      m.forceTerminal('cancelled');
      assert.equal(m.state, 'cancelled');
    }
  });

  it('treats a transition to the current state as a no-op', () => {
    const m = new AgentStateMachine('planning');
    const listener = spy();
    m.onTransition(listener);
    m.transition('planning');
    assert.equal(listener.count, 0);
  });

  it('keeps running after a listener throws', () => {
    const m = new AgentStateMachine();
    m.onTransition(() => {
      throw new Error('observer blew up');
    });
    const good = spy();
    m.onTransition(good);

    assert.doesNotThrow(() => m.transition('understanding'));
    assert.equal(m.state, 'understanding');
    assert.equal(good.count, 1);
  });

  it('records transition history for the timeline', () => {
    const m = new AgentStateMachine();
    m.transition('understanding');
    m.transition('planning');
    const history = m.recentHistory();
    assert.equal(history.length, 2);
    matchObject(history[0], { from: 'idle', to: 'understanding' });
  });
});
