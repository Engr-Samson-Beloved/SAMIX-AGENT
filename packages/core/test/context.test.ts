import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TaskStep } from '@samix/shared';
import { AgentContext, classifyResponse, PROPOSAL_TTL_MS } from '../dist/index.js';

/**
 * Conversational context and the yes/no test (spec §80).
 *
 * The affirmative classifier decides whether a stored tool call runs without
 * re-planning, so its boundaries are the security-relevant part: an utterance
 * that carries new information must never be read as bare agreement.
 */

describe('recognising a plain yes', () => {
  const yes = [
    'yes',
    'Yes.',
    'yeah',
    'yep',
    'sure',
    'ok',
    'okay!',
    'alright',
    'yes please',
    'yes, do that',
    'yes do that then',
    'do it',
    'do that',
    'go ahead',
    'go ahead then',
    'sure, go ahead',
    'ok please do that',
    'yes please do it for me',
    'proceed',
    'let’s do it',
  ];

  for (const phrase of yes) {
    test(`"${phrase}" is agreement`, () => {
      assert.equal(classifyResponse(phrase), 'affirmative');
    });
  }
});

describe('recognising a plain no', () => {
  for (const phrase of ['no', 'nope', 'no thanks', 'don’t', 'cancel', 'never mind', 'no, stop']) {
    test(`"${phrase}" is a refusal`, () => {
      assert.equal(classifyResponse(phrase), 'negative');
    });
  }

  test('a hedged yes-no is read as no', () => {
    // "yeah no" is a refusal in every dialect that uses it, and reading it as
    // consent is the expensive direction to be wrong in.
    assert.equal(classifyResponse('yeah no'), 'negative');
  });
});

describe('anything carrying new information is not bare agreement', () => {
  const other = [
    'yes open chrome',
    'yes but use Firefox',
    'yes and then close it',
    'ok now find my invoice',
    'sure, what about the other one',
    'open notepad',
    'do that for the second file',
    'yes to the first one and no to the second, then check the folder again',
  ];

  for (const phrase of other) {
    test(`"${phrase}" goes to the planner`, () => {
      // Resolving these against a stored proposal would run the stored action
      // and ignore what the user actually said — "yes open chrome" must open
      // Chrome, not whatever was offered last turn.
      assert.equal(classifyResponse(phrase), 'other');
    });
  }

  test('an empty instruction is not agreement', () => {
    assert.equal(classifyResponse('   '), 'other');
  });
});

describe('pending proposals', () => {
  const offer = {
    tool: 'app.launch',
    input: { name: 'Chrome' },
    offer: 'Chrome is not running. Shall I open it?',
    description: 'App: launch (name: Chrome)',
    taskId: 'task_1',
  };

  test('an offer can be read back with its exact tool call', () => {
    const context = new AgentContext();
    context.propose(offer);

    assert.deepEqual(context.pendingProposal?.input, { name: 'Chrome' });
    assert.equal(context.pendingProposal?.tool, 'app.launch');
  });

  test('taking an offer consumes it', () => {
    const context = new AgentContext();
    context.propose(offer);

    assert.equal(context.takeProposal()?.tool, 'app.launch');
    // One offer, one answer: a proposal that survived being accepted could be
    // accepted again by the next stray "ok", running the action twice.
    assert.equal(context.takeProposal(), undefined);
  });

  test('an offer expires rather than lingering indefinitely', () => {
    let now = 1_000_000;
    const context = new AgentContext(() => now);
    context.propose(offer);

    now += PROPOSAL_TTL_MS - 1;
    assert.notEqual(context.pendingProposal, undefined);

    now += 2;
    assert.equal(context.pendingProposal, undefined, 'a stale offer must not be answerable');
  });
});

describe('learning what "it" points at', () => {
  const step = (patch: Partial<TaskStep>): TaskStep => ({
    id: 'step_1',
    index: 0,
    description: 'do the thing',
    tool: 'app.launch',
    input: {},
    status: 'succeeded',
    attempts: 1,
    ...patch,
  });

  test('remembers the application a successful step acted on', () => {
    const context = new AgentContext();
    context.observe(step({ tool: 'app.launch', input: { name: 'Notepad' } }));

    assert.equal(context.referents.app, 'Notepad');
  });

  test('prefers the URL the browser actually landed on over the one requested', () => {
    const context = new AgentContext();
    context.observe(
      step({
        tool: 'browser.goto',
        input: { url: 'https://app.example.com' },
        result: { success: true, data: { url: 'https://accounts.example.com/login' } },
      }),
    );

    assert.equal(context.referents.url, 'https://accounts.example.com/login');
  });

  test('a failed step teaches nothing', () => {
    const context = new AgentContext();
    context.observe(step({ status: 'failed', input: { name: 'Photoshop' } }));

    // "Open Photoshop" that failed must not make "close it" mean Photoshop.
    assert.equal(context.referents.app, undefined);
  });

  test('a later step does not erase what an earlier one established', () => {
    const context = new AgentContext();
    context.observe(step({ tool: 'app.launch', input: { name: 'Notepad' } }));
    context.observe(
      step({
        tool: 'filesystem.copy',
        input: { destination: 'C:\\Users\\me\\Desktop\\a.pdf' },
      }),
    );

    assert.equal(context.referents.app, 'Notepad');
    assert.equal(context.referents.path, 'C:\\Users\\me\\Desktop\\a.pdf');
  });

  test('listing applications names nothing in particular', () => {
    const context = new AgentContext();
    context.observe(step({ tool: 'app.list', input: {}, result: { success: true, data: {} } }));

    assert.equal(context.referents.app, undefined);
  });
});
