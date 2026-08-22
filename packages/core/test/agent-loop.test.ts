import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { z } from 'zod';
import { err, ok, verification, type AgentEvent, type AgentTool } from '@samix/shared';
import { createRuntime, type PlanResult, type Planner, type Runtime } from '../dist/index.js';
import { excludes, includes, matchObject, readNdjson, tempDir } from './helpers.ts';

/**
 * End-to-end tests of the agent loop.
 *
 * This is the Phase 1 test that matters most: it drives a REAL runtime — real
 * config, permission engine, executor, verification, audit trail and event bus —
 * and asserts the guarantees the whole design exists to provide. Only the
 * planner is substituted, so plans are deterministic and no network is involved.
 *
 * Everything runs against a temp directory (spec §69).
 */

let dir: string;
let cleanup: () => void;
let runtime: Runtime | undefined;

beforeEach(() => {
  ({ dir, cleanup } = tempDir('samix-agent-'));
});

afterEach(() => {
  runtime?.shutdown();
  runtime = undefined;
  cleanup();
});

/** A planner that always returns the same plan. */
function fixedPlanner(result: PlanResult, summary?: () => Promise<string | undefined>): Planner {
  return {
    name: 'fixed (test)',
    plan: () => Promise.resolve(result),
    ...(summary ? { summarise: summary } : {}),
  };
}

/** Build a runtime, optionally with a substitute planner and extra tools. */
function build(options: { planner?: Planner; tools?: AgentTool<never, unknown>[] } = {}): Runtime {
  const rt = createRuntime({
    dataDir: dir,
    logToStderr: false,
    ...(options.planner ? { planner: () => options.planner! } : {}),
  });
  for (const tool of options.tools ?? []) rt.registry.register(tool);
  runtime = rt;
  return rt;
}

/** Record all events and resolve when the task reaches a terminal state. */
function watch(rt: Runtime): { events: AgentEvent[]; done: Promise<AgentEvent> } {
  const events: AgentEvent[] = [];
  const done = new Promise<AgentEvent>((resolve) => {
    rt.bus.onAny((event) => {
      events.push(event);
      if (
        event.type === 'task.completed' ||
        event.type === 'task.failed' ||
        event.type === 'task.cancelled'
      ) {
        resolve(event);
      }
    });
  });
  return { events, done };
}

const types = (events: AgentEvent[]): string[] => events.map((e) => e.type);

// A step plan pointing at one tool.
const planFor = (tool: string, description = 'do the thing'): PlanResult => ({
  kind: 'steps',
  steps: [{ description, tool, input: {} }],
});

// ---------------------------------------------------------------------------

describe('the Phase 1 loop, end to end', () => {
  it('runs a real tool and reports a verified result', async () => {
    const rt = build();
    const { events, done } = watch(rt);
    rt.agent.start();

    const { taskId } = rt.agent.submit('what system am I on?', 'text');
    const outcome = await done;

    assert.equal(outcome.type, 'task.completed');
    for (const expected of [
      'task.created',
      'agent.plan.created',
      'tool.started',
      'tool.completed',
      'tool.verified',
    ]) {
      includes(types(events), expected, 'event stream');
    }

    const task = rt.tasks.find(taskId);
    assert.equal(task?.status, 'completed');
    assert.equal(task?.steps[0]?.tool, 'system.getInfo');
    assert.equal(task?.steps[0]?.status, 'succeeded');
  });

  it('returns the agent to idle so the next instruction is accepted', async () => {
    const rt = build();
    const { done } = watch(rt);
    rt.agent.start();
    rt.agent.submit('status', 'text');
    await done;

    assert.equal(rt.agent.state, 'idle');
    assert.doesNotThrow(() => rt.agent.submit('status', 'text'));
  });

  it('shows the planner what was said and answered on the previous turn', async () => {
    // The wiring behind multi-turn follow-ups. Without it the agent can offer
    // something and then not know it offered — which is how "yes, do that"
    // became "could you please clarify?" in real use.
    const seen: Array<readonly { instruction: string; reply: string; tools: readonly string[] }[]> = [];
    const rt = build({
      planner: {
        name: 'recording (test)',
        plan: (request) => {
          seen.push(request.history);
          return Promise.resolve<PlanResult>({ kind: 'reply', message: 'noted' });
        },
      },
    });

    const first = watch(rt);
    rt.agent.start();
    rt.agent.submit('what can you do?', 'text');
    await first.done;

    const second = watch(rt);
    rt.agent.submit('do that then', 'text');
    await second.done;

    assert.deepEqual(seen[0], [], 'the first instruction has no history');
    assert.equal(seen[1]?.length, 1, 'the second sees exactly the first exchange');
    assert.equal(seen[1]?.[0]?.instruction, 'what can you do?');
    assert.equal(seen[1]?.[0]?.reply, 'noted');
  });

  it('runs an offered action when the user simply agrees', async () => {
    // The failure this fixes: the agent offers something, the user says "yes do
    // that then", and the next turn — planning from prose — asks them to
    // clarify a suggestion the agent itself made.
    let plans = 0;
    const rt = build({
      planner: {
        name: 'offering (test)',
        plan: () => {
          plans += 1;
          return Promise.resolve<PlanResult>({
            kind: 'propose',
            message: 'That needs system details. Shall I read them?',
            step: { description: 'read system information', tool: 'system.getInfo', input: {} },
          });
        },
      },
    });

    const first = watch(rt);
    rt.agent.start();
    const offered = rt.agent.submit('is this machine any good?', 'text');
    await first.done;

    // Nothing ran: it was an offer, and the user was told what was on offer.
    assert.equal(rt.tasks.find(offered.taskId)?.steps.length, 0);
    assert.equal(rt.tasks.find(offered.taskId)?.summary, 'That needs system details. Shall I read them?');

    const second = watch(rt);
    const accepted = rt.agent.submit('yes do that then', 'text');
    const outcome = await second.done;

    assert.equal(outcome.type, 'task.completed');
    const task = rt.tasks.find(accepted.taskId);
    assert.equal(task?.steps[0]?.tool, 'system.getInfo');
    assert.equal(task?.steps[0]?.status, 'succeeded');
    // The planner is not consulted at all on the agreeing turn: the stored call
    // runs verbatim, so what happens is exactly what was offered.
    assert.equal(plans, 1, 'agreement must not be re-planned');
  });

  it('declines an offer without running it', async () => {
    const rt = build({
      planner: {
        name: 'offering (test)',
        plan: () =>
          Promise.resolve<PlanResult>({
            kind: 'propose',
            message: 'Shall I read the system details?',
            step: { description: 'read system information', tool: 'system.getInfo', input: {} },
          }),
      },
    });

    const first = watch(rt);
    rt.agent.start();
    rt.agent.submit('is this machine any good?', 'text');
    await first.done;

    const second = watch(rt);
    const declined = rt.agent.submit('no thanks', 'text');
    await second.done;

    assert.equal(rt.tasks.find(declined.taskId)?.steps.length, 0);
    assert.match(rt.tasks.find(declined.taskId)?.summary ?? '', /left it alone/i);
  });

  it('does not treat a new instruction as agreement to an old offer', async () => {
    const instructions: string[] = [];
    const rt = build({
      planner: {
        name: 'offering (test)',
        plan: (request) => {
          instructions.push(request.task.instruction);
          return Promise.resolve<PlanResult>(
            instructions.length === 1
              ? {
                  kind: 'propose',
                  message: 'Shall I open Notepad?',
                  step: { description: 'open Notepad', tool: 'app.launch', input: { name: 'Notepad' } },
                }
              : { kind: 'reply', message: 'ok' },
          );
        },
      },
    });

    const first = watch(rt);
    rt.agent.start();
    rt.agent.submit('I need to write something down', 'text');
    await first.done;

    const second = watch(rt);
    rt.agent.submit('actually open Chrome instead', 'text');
    await second.done;

    // The stored offer must not hijack an instruction that says something else.
    // "actually open Chrome" reaching the planner is the whole requirement.
    assert.deepEqual(instructions, ['I need to write something down', 'actually open Chrome instead']);
  });

  it('tells the planner what "it" currently points at', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const rt = build({
      planner: {
        name: 'recording (test)',
        plan: (request) => {
          seen.push(request.referents as Record<string, unknown>);
          return Promise.resolve<PlanResult>(
            seen.length === 1 ? planFor('system.getInfo') : { kind: 'reply', message: 'ok' },
          );
        },
      },
    });

    const first = watch(rt);
    rt.agent.start();
    rt.agent.submit('read the system info', 'text');
    await first.done;

    const second = watch(rt);
    rt.agent.submit('and what about the other thing', 'text');
    await second.done;

    assert.deepEqual(seen[0], {}, 'nothing is known before anything has run');
    // `system.getInfo` names no application, page or file, so there is still
    // nothing to point at — the referents are observations, never invented.
    assert.deepEqual(seen[1], {});
  });

  it('never includes the in-flight task in its own history', async () => {
    const seen: Array<readonly unknown[]> = [];
    const rt = build({
      planner: {
        name: 'recording (test)',
        plan: (request) => {
          seen.push(request.history);
          return Promise.resolve<PlanResult>({ kind: 'reply', message: 'ok' });
        },
      },
    });

    const { done } = watch(rt);
    rt.agent.start();
    rt.agent.submit('only instruction', 'text');
    await done;

    assert.deepEqual(seen[0], [], 'a task must not see itself as prior context');
  });

  /** One machine, one desktop: concurrent automation is a correctness hazard. */
  it('refuses a second concurrent task rather than queueing it', () => {
    const rt = build({ planner: { name: 'slow', plan: () => new Promise<PlanResult>(() => {}) } });
    rt.agent.start();
    rt.agent.submit('first', 'text');
    assert.throws(() => rt.agent.submit('second', 'text'), /already running/);
  });

  it('answers honestly when it does not understand, instead of inventing a plan', async () => {
    const rt = build();
    const { done } = watch(rt);
    rt.agent.start();
    rt.agent.submit('reticulate the splines on my quantum flux capacitor', 'text');

    const outcome = await done;
    assert.equal(outcome.type, 'task.completed');
    assert.match((outcome as { summary: string }).summary, /don't yet understand/i);
  });
});

describe('continuation — asking the planner again once results are in (Planner.continue)', () => {
  /**
   * `plan()` is one blind turn: the model commits to tool arguments before
   * anything has run. `Planner.continue` is the orchestrator's hook to show it
   * real results and ask whether more is needed — without it, nothing that
   * depends on a prior step's actual output (an element ref, a search id)
   * could ever be planned correctly. These tests exercise the round loop in
   * `agent.ts` directly; `llm-planner.test.ts` covers what the LLM planner
   * puts in the continuation prompt.
   */
  it('runs a second round of tool calls after the first succeeds, seeing the real result', async () => {
    let calls = 0;
    const rt = build({
      planner: {
        name: 'continuing (test)',
        plan: () => Promise.resolve<PlanResult>(planFor('system.getInfo', 'first read')),
        continue: (request) => {
          calls += 1;
          if (calls === 1) {
            assert.equal(request.completedSteps.length, 1, 'sees exactly the steps that have run');
            assert.equal(request.completedSteps[0]?.tool, 'system.getInfo');
            assert.equal(request.completedSteps[0]?.status, 'succeeded');
            return Promise.resolve<PlanResult>(planFor('agent.getStatus', 'second read'));
          }
          assert.equal(request.completedSteps.length, 2, 'the second round is visible on the next check');
          return Promise.resolve<PlanResult>({ kind: 'reply', message: '' });
        },
      },
    });
    const { done } = watch(rt);
    rt.agent.start();
    const { taskId } = rt.agent.submit('do two things', 'text');

    const outcome = await done;
    assert.equal(outcome.type, 'task.completed');
    const task = rt.tasks.find(taskId);
    assert.deepEqual(task?.steps.map((s) => s.tool), ['system.getInfo', 'agent.getStatus']);
    assert.equal(task?.steps[1]?.status, 'succeeded');
    // Called twice: once producing the second step, once confirming nothing
    // remained after it — never fewer, never looping forever.
    assert.equal(calls, 2);
  });

  it('a planner with no opinion on continuation stops after one round, unchanged from before this existed', async () => {
    const rt = build({ planner: fixedPlanner(planFor('system.getInfo', 'only read')) });
    const { done } = watch(rt);
    rt.agent.start();
    const { taskId } = rt.agent.submit('one thing', 'text');

    const outcome = await done;
    assert.equal(outcome.type, 'task.completed');
    assert.equal(rt.tasks.find(taskId)?.steps.length, 1);
  });

  it('stops asking once maxContinuationRounds is reached, without failing what already succeeded', async () => {
    let continues = 0;
    const rt = build({
      planner: {
        name: 'endless (test)',
        plan: () => Promise.resolve<PlanResult>(planFor('system.getInfo', 'round 0')),
        continue: () => {
          continues += 1;
          return Promise.resolve<PlanResult>(planFor('agent.getStatus', `round ${continues}`));
        },
      },
    });
    rt.config.update({ automation: { maxContinuationRounds: 2 } });
    const { done } = watch(rt);
    rt.agent.start();
    const { taskId } = rt.agent.submit('keep going', 'text');

    const outcome = await done;
    assert.equal(outcome.type, 'task.completed', 'a round budget is not a failure — it is a stopping point');
    const task = rt.tasks.find(taskId);
    assert.equal(task?.steps.length, 2, 'the initial step plus exactly one continuation round');
    assert.equal(continues, 1, 'a bound of 2 rounds means exactly one continuation call is made');
  });

  it('ends the task on a clarifying question raised during continuation', async () => {
    const rt = build({
      planner: {
        name: 'asking (test)',
        plan: () => Promise.resolve<PlanResult>(planFor('system.getInfo', 'first read')),
        continue: () => Promise.resolve<PlanResult>({ kind: 'clarify', question: 'Which one did you mean?' }),
      },
    });
    const { done } = watch(rt);
    rt.agent.start();
    const { taskId } = rt.agent.submit('do the thing', 'text');

    const outcome = await done;
    assert.equal(outcome.type, 'task.completed');
    assert.equal(rt.tasks.find(taskId)?.summary, 'Which one did you mean?');
  });

  it('stops rather than exceeding the step limit across rounds, keeping what already succeeded', async () => {
    let continues = 0;
    const rt = build({
      planner: {
        name: 'greedy (test)',
        plan: () => Promise.resolve<PlanResult>(planFor('system.getInfo', 'round 0')),
        continue: () => {
          continues += 1;
          // Offers far more than could ever fit under the step limit.
          return Promise.resolve<PlanResult>({
            kind: 'steps',
            steps: Array.from({ length: 50 }, (_, i) => ({
              description: `extra ${i}`,
              tool: 'agent.getStatus',
              input: {},
            })),
          });
        },
      },
    });
    rt.config.update({ automation: { maxStepsPerTask: 3, maxContinuationRounds: 5 } });
    const { done } = watch(rt);
    rt.agent.start();
    const { taskId } = rt.agent.submit('do a lot', 'text');

    const outcome = await done;
    assert.equal(outcome.type, 'task.completed', 'exceeding the limit stops the loop, it does not fail the task');
    assert.equal(rt.tasks.find(taskId)?.steps.length, 1, 'only the round that fit within the limit ran');
    assert.equal(continues, 1, 'asked once, then stopped once the answer could not fit');
  });
});

describe('the verification guarantee (spec §29, development rule 25)', () => {
  /**
   * The central promise of the product: when the tool claims success but the
   * world disagrees, the world wins and the agent reports failure.
   */
  it('fails a step whose verifier contradicts the tool', async () => {
    const lying: AgentTool<Record<string, never>, unknown> = {
      name: 'demo.lie',
      description: 'A tool that claims success while changing nothing at all.',
      permission: 'write',
      reversibility: 'reversible',
      inputSchema: z.object({}),
      verification: 'explicit',
      execute: () => Promise.resolve(ok({ claimed: 'done' })),
      verify: () => Promise.resolve(verification('failed', 'Destination does not exist.')),
    };

    const rt = build({
      planner: fixedPlanner(planFor('demo.lie', 'pretend to copy')),
      tools: [lying as unknown as AgentTool<never, unknown>],
    });
    const { done } = watch(rt);
    rt.agent.start();
    rt.agent.submit('copy the thing', 'text');

    const outcome = await done;
    assert.equal(outcome.type, 'task.failed');
    assert.equal((outcome as { error: { code: string } }).error.code, 'VERIFICATION_FAILED');
  });

  it('never lets a planner write the summary for unverified work', async () => {
    const unverifiable: AgentTool<Record<string, never>, unknown> = {
      name: 'demo.unverifiableToo',
      description: 'A tool whose verification step fails when it is attempted.',
      permission: 'write',
      reversibility: 'reversible',
      inputSchema: z.object({}),
      verification: 'explicit',
      execute: () => Promise.resolve(ok({ done: true })),
      verify: () => Promise.reject(new Error('cannot reach the target to check')),
    };

    let asked = false;
    const rt = build({
      planner: fixedPlanner(planFor('demo.unverifiableToo'), () => {
        asked = true;
        return Promise.resolve('All done, everything worked perfectly!');
      }),
      tools: [unverifiable as unknown as AgentTool<never, unknown>],
    });
    const { done } = watch(rt);
    rt.agent.start();
    const { taskId } = rt.agent.submit('do it', 'text');

    await done;

    // The honesty guarantee is structural: an LLM is never given the chance to
    // phrase unverified work, so it cannot be talked into "everything worked".
    assert.equal(asked, false, 'the planner must not be asked to summarise unverified work');

    // Asserted as the invariant rather than as a fixed phrase: unverified work
    // must never read as a confident success, and must carry the doubt. The
    // exact wording comes from whichever verifier ran, so pinning it here would
    // make every new verifier a test failure.
    const summary = rt.tasks.find(taskId)?.summary ?? '';
    assert.doesNotMatch(summary, /^Done\./, 'unverified work must not open with "Done."');
    assert.match(summary, /could ?n[o']?t|cannot|unable|unverified/i);
  });

  it('uses a planner-written summary when every step verified', async () => {
    const rt = build({
      planner: fixedPlanner(planFor('system.getInfo'), () =>
        Promise.resolve('You are running Windows on an Intel CPU.'),
      ),
    });
    const { done } = watch(rt);
    rt.agent.start();
    rt.agent.submit('what am I running', 'text');

    const outcome = await done;
    assert.equal(outcome.type, 'task.completed');
    matchObject(outcome, { summary: 'You are running Windows on an Intel CPU.' });
  });

  it('falls back to the mechanical summary when the planner cannot phrase one', async () => {
    const rt = build({
      planner: fixedPlanner(planFor('system.getInfo'), () =>
        Promise.reject(new Error('the provider is down')),
      ),
    });
    const { done } = watch(rt);
    rt.agent.start();
    rt.agent.submit('what am I running', 'text');

    const outcome = await done;
    // Work that succeeded and verified must not be reported as failed just
    // because the sentence describing it could not be written.
    assert.equal(outcome.type, 'task.completed');
    matchObject(outcome, { summary: /^Done\./ });
  });

  it('marks a step succeeded_unverified when the verifier cannot run', async () => {
    const unverifiable: AgentTool<Record<string, never>, unknown> = {
      name: 'demo.unverifiable',
      description: 'A tool whose verification step fails when it is attempted.',
      permission: 'write',
      reversibility: 'reversible',
      inputSchema: z.object({}),
      verification: 'explicit',
      execute: () => Promise.resolve(ok({ done: true })),
      verify: () => Promise.reject(new Error('cannot reach the target to check')),
    };

    const rt = build({
      planner: fixedPlanner(planFor('demo.unverifiable')),
      tools: [unverifiable as unknown as AgentTool<never, unknown>],
    });
    const { done } = watch(rt);
    rt.agent.start();
    const { taskId } = rt.agent.submit('do it', 'text');

    await done;
    const task = rt.tasks.find(taskId);
    assert.equal(task?.steps[0]?.status, 'succeeded_unverified');
    assert.doesNotMatch(
      task?.summary ?? '',
      /^Done\./,
      'the summary must not claim an unverified step succeeded',
    );
    assert.match(task?.summary ?? '', /could ?n[o']?t|cannot|unable|unverified/i);
  });

  it('reports a verified step with what was observed, not with the step description', async () => {
    const observant: AgentTool<Record<string, never>, unknown> = {
      name: 'demo.observable',
      description: 'A tool whose verifier reports a concrete observation about the world.',
      permission: 'write',
      reversibility: 'reversible',
      inputSchema: z.object({}),
      verification: 'explicit',
      execute: () => Promise.resolve(ok({ done: true })),
      verify: () => Promise.resolve(verification('verified', 'The kettle is now switched on.')),
    };

    const rt = build({
      planner: fixedPlanner(planFor('demo.observable', 'switch the kettle on')),
      tools: [observant as unknown as AgentTool<never, unknown>],
    });
    const { done } = watch(rt);
    rt.agent.start();
    const { taskId } = rt.agent.submit('put the kettle on', 'text');

    await done;

    // Verified work gets the confident tone AND the observation. "Done. Switch
    // the kettle on." would describe the mechanism instead of the outcome.
    assert.equal(rt.tasks.find(taskId)?.summary, 'Done. The kettle is now switched on.');
  });

  it('reports a read-only step plainly, with no confirmation language', async () => {
    const rt = build({ planner: fixedPlanner(planFor('system.getInfo', 'read system information')) });
    const { done } = watch(rt);
    rt.agent.start();
    const { taskId } = rt.agent.submit('what am I running', 'text');

    await done;

    // A pure read verifies as `not-applicable`: its return value IS the
    // observation, so there is nothing to confirm and nothing to hedge. It must
    // not borrow either the confident or the doubtful phrasing.
    const summary = rt.tasks.find(taskId)?.summary ?? '';
    assert.equal(summary, 'Done. read system information.');
    assert.doesNotMatch(summary, /confirm|verif/i);
  });
});

describe('permissions and confirmation', () => {
  const externalTool: AgentTool<Record<string, never>, unknown> = {
    name: 'demo.sendMessage',
    description: 'Pretends to send a message to an external recipient, for testing.',
    permission: 'external',
    reversibility: 'irreversible',
    inputSchema: z.object({}),
    verification: 'explicit',
    execute: () => Promise.resolve(ok({ sent: true })),
    verify: () => Promise.resolve(verification('verified', 'Message appears in the conversation.')),
    describeEffect: () => 'Send a message to Charles',
  };

  const buildExternal = (): Runtime =>
    build({
      planner: fixedPlanner(planFor('demo.sendMessage', 'send it')),
      tools: [externalTool as unknown as AgentTool<never, unknown>],
    });

  it('pauses for confirmation before an external action', async () => {
    const rt = buildExternal();
    rt.agent.start();

    const requested = rt.bus.waitFor('confirmation.required', 5000);
    rt.agent.submit('send it', 'text');
    const event = await requested;

    assert.equal(event.request.tool, 'demo.sendMessage');
    assert.equal(event.request.effect, 'Send a message to Charles');
    assert.equal(rt.agent.state, 'awaiting_confirmation');
  });

  it('executes after approval', async () => {
    const rt = buildExternal();
    const { done } = watch(rt);
    rt.agent.start();

    const requested = rt.bus.waitFor('confirmation.required', 5000);
    rt.agent.submit('send it', 'text');
    const { request } = await requested;
    rt.agent.respondToConfirmation({ id: request.id, approved: true, approveRemainingInTask: false });

    assert.equal((await done).type, 'task.completed');
  });

  it('does not execute when the user declines', async () => {
    const rt = buildExternal();
    const { events, done } = watch(rt);
    rt.agent.start();

    const requested = rt.bus.waitFor('confirmation.required', 5000);
    const { taskId } = rt.agent.submit('send it', 'text');
    const { request } = await requested;
    rt.agent.respondToConfirmation({ id: request.id, approved: false, approveRemainingInTask: false });

    await done;
    excludes(types(events), 'tool.started', 'event stream');
    assert.equal(rt.tasks.find(taskId)?.status, 'cancelled');
  });

  it('blocks the action outright in SAFE mode, without even prompting', async () => {
    const rt = buildExternal();
    rt.config.update({ automation: { mode: 'safe' } });
    const { events, done } = watch(rt);
    rt.agent.start();
    rt.agent.submit('send it', 'text');

    assert.equal((await done).type, 'task.failed');
    includes(types(events), 'permission.denied', 'event stream');
    excludes(types(events), 'confirmation.required', 'event stream');
    excludes(types(events), 'tool.started', 'event stream');
  });
});

describe('cancellation and emergency stop', () => {
  it('emergency stop cancels an in-flight task and latches the agent closed', () => {
    const rt = build({ planner: { name: 'hanging', plan: () => new Promise<PlanResult>(() => {}) } });
    rt.agent.start();
    const { taskId } = rt.agent.submit('something long', 'text');

    const result = rt.agent.emergencyStop();
    assert.equal(result.stopped, true);
    assert.equal(result.cancelledTaskId, taskId);
    assert.equal(rt.agent.isStopped, true);
    assert.throws(() => rt.agent.submit('another', 'text'), /emergency stop/i);

    rt.agent.resume();
    assert.doesNotThrow(() => rt.agent.submit('another', 'text'));
  });

  /** A pending confirmation must never be able to wedge the agent forever. */
  it('cancels a task that is waiting on confirmation', async () => {
    const external: AgentTool<Record<string, never>, unknown> = {
      name: 'demo.external',
      description: 'An external-permission tool used to exercise the confirmation gate.',
      permission: 'external',
      reversibility: 'irreversible',
      inputSchema: z.object({}),
      verification: 'explicit',
      execute: () => Promise.resolve(ok({})),
      verify: () => Promise.resolve(verification('verified', 'ok')),
      describeEffect: () => 'Do an external thing',
    };

    const rt = build({
      planner: fixedPlanner(planFor('demo.external', 'external step')),
      tools: [external as unknown as AgentTool<never, unknown>],
    });
    const { done } = watch(rt);
    rt.agent.start();

    const requested = rt.bus.waitFor('confirmation.required', 5000);
    rt.agent.submit('do it', 'text');
    await requested;

    rt.agent.cancel('user pressed stop');
    assert.equal((await done).type, 'task.cancelled');
  });
});

describe('failure reporting', () => {
  it('reports a tool failure without claiming success', async () => {
    const failing: AgentTool<Record<string, never>, unknown> = {
      name: 'demo.fails',
      description: 'A tool that always fails, used to exercise the failure path.',
      permission: 'read',
      reversibility: 'reversible',
      inputSchema: z.object({}),
      verification: 'intrinsic',
      execute: () => Promise.resolve(err('FILE_NOT_FOUND', 'No such file.', { recoverable: false })),
    };

    const rt = build({
      planner: fixedPlanner(planFor('demo.fails', 'find the file')),
      tools: [failing as unknown as AgentTool<never, unknown>],
    });
    const { done } = watch(rt);
    rt.agent.start();
    rt.agent.submit('find it', 'text');

    const outcome = await done;
    assert.equal(outcome.type, 'task.failed');
    assert.equal((outcome as { error: { code: string } }).error.code, 'FILE_NOT_FOUND');
    assert.match((outcome as { summary: string }).summary, /could not complete/i);
  });

  it('rejects a plan that references an unregistered tool', async () => {
    const rt = build({ planner: fixedPlanner(planFor('demo.nonexistent', 'do magic')) });
    const { done } = watch(rt);
    rt.agent.start();
    rt.agent.submit('go', 'text');

    assert.equal((await done).type, 'task.failed');
  });

  /** Policy must never be decided about input whose real effect is unknown. */
  it('rejects malformed tool input before any tool runs', async () => {
    const strict: AgentTool<{ count: number }, unknown> = {
      name: 'demo.strict',
      description: 'A tool with a strict input schema, for validation testing purposes.',
      permission: 'read',
      reversibility: 'reversible',
      inputSchema: z.object({ count: z.number() }),
      verification: 'intrinsic',
      execute: () => Promise.resolve(ok({})),
    };

    const rt = build({
      planner: fixedPlanner({
        kind: 'steps',
        steps: [{ description: 'bad input', tool: 'demo.strict', input: { count: 'lots' } }],
      }),
      tools: [strict as unknown as AgentTool<never, unknown>],
    });
    const { events, done } = watch(rt);
    rt.agent.start();
    rt.agent.submit('go', 'text');

    await done;
    excludes(types(events), 'tool.started', 'event stream');
  });
});

describe('the audit trail (spec §37)', () => {
  it('records every tool execution', async () => {
    const rt = build();
    const { done } = watch(rt);
    rt.agent.start();
    rt.agent.submit('what system am I on?', 'text');
    await done;
    rt.shutdown();
    runtime = undefined;

    const records = await readNdjson(path.join(dir, 'logs', 'audit.log'));
    assert.ok(records.length > 0);
    matchObject(records[0], { tool: 'system.getInfo', outcome: 'success', permission: 'read' });
  });

  it('records a policy refusal, not just successes', async () => {
    const external: AgentTool<Record<string, never>, unknown> = {
      name: 'demo.blocked',
      description: 'An external tool used to verify that refusals reach the audit trail.',
      permission: 'external',
      reversibility: 'irreversible',
      inputSchema: z.object({}),
      verification: 'explicit',
      execute: () => Promise.resolve(ok({})),
      verify: () => Promise.resolve(verification('verified', 'ok')),
      describeEffect: () => 'Do something external',
    };

    const rt = build({
      planner: fixedPlanner(planFor('demo.blocked')),
      tools: [external as unknown as AgentTool<never, unknown>],
    });
    rt.config.update({ automation: { mode: 'safe' } });
    const { done } = watch(rt);
    rt.agent.start();
    rt.agent.submit('go', 'text');
    await done;
    rt.shutdown();
    runtime = undefined;

    const records = await readNdjson(path.join(dir, 'logs', 'audit.log'));
    matchObject(records[0], { tool: 'demo.blocked', outcome: 'blocked' });
  });
});
