import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { z } from 'zod';
import { defaultConfig, ok, verification, type AgentTool, type AppConfig } from '@samix/shared';
import {
  ASK_USER_FUNCTION,
  HybridPlanner,
  LlmError,
  LlmPlanner,
  ModelRouter,
  ToolRegistry,
  classifyInstruction,
  nullLogger,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type PlanRequest,
  type RecoveryRequest,
} from '../dist/index.js';
import { matchObject } from './helpers.ts';

/**
 * The LLM planner.
 *
 * The theme running through these tests is that the model is a source of
 * suggestions, not of authority. Each one checks that a plausible-but-wrong
 * model output produces an honest outcome rather than an action.
 */

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function makeTool(name: string, overrides: Partial<AgentTool> = {}): AgentTool<never, unknown> {
  return {
    name,
    description: `Read information about ${name}. Used when the user asks about it.`,
    permission: 'read',
    reversibility: 'reversible',
    verification: 'intrinsic',
    inputSchema: z.object({
      sections: z.array(z.enum(['os', 'hardware'])).optional(),
    }),
    execute: () => Promise.resolve(ok({}, verification('verified', 'read'))),
    ...overrides,
  } as AgentTool<never, unknown>;
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(makeTool('system.getInfo'));
  registry.register(
    makeTool('developer.inspect', {
      availableInModes: ['developer'],
      inputSchema: z.object({ target: z.string() }),
    }),
  );
  return registry;
}

/** A provider that replays scripted responses and records what it was asked. */
function scriptedProvider(
  responses: Array<Partial<LlmResponse> | LlmError>,
): { provider: LlmProvider; requests: LlmRequest[] } {
  const queue = [...responses];
  const requests: LlmRequest[] = [];

  return {
    requests,
    provider: {
      id: 'google',
      name: 'Test provider',
      generate: (request) => {
        requests.push(request);
        const next = queue.shift();
        if (next instanceof LlmError) return Promise.reject(next);
        return Promise.resolve({
          text: '',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: request.model,
          durationMs: 1,
          ...next,
        });
      },
    },
  };
}

function makePlanner(
  responses: Array<Partial<LlmResponse> | LlmError>,
  config: AppConfig = defaultConfig(),
): { planner: LlmPlanner; registry: ToolRegistry; requests: LlmRequest[] } {
  const registry = makeRegistry();
  const { provider, requests } = scriptedProvider(responses);
  const planner = new LlmPlanner({
    provider,
    router: new ModelRouter(() => config.llm),
    registry,
    config: () => config,
    logger: nullLogger(),
  });
  return { planner, registry, requests };
}

function planRequest(instruction: string, overrides: Partial<PlanRequest> = {}): PlanRequest {
  return {
    task: {
      id: 'task_1',
      instruction,
      source: 'text',
      mode: 'controlled',
      status: 'planning',
      steps: [],
      createdAt: new Date().toISOString(),
    },
    mode: 'controlled',
    availableTools: ['system.getInfo'],
    signal: new AbortController().signal,
    ...overrides,
  } as PlanRequest;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

describe('LlmPlanner.plan', () => {
  test('a text-only answer becomes a reply', async () => {
    const { planner } = makePlanner([{ text: 'Your computer is a Windows machine.' }]);

    const result = await planner.plan(planRequest('what am I running'));

    matchObject(result, { kind: 'reply', message: 'Your computer is a Windows machine.' });
  });

  test('a valid tool call becomes a plan step with the parsed input', async () => {
    const { planner } = makePlanner([
      { toolCalls: [{ id: 'c0', name: 'system.getInfo', input: { sections: ['os'] } }] },
    ]);

    const result = await planner.plan(planRequest('tell me about the OS'));

    assert.equal(result.kind, 'steps');
    assert.equal(result.steps.length, 1);
    matchObject(result.steps[0]!, { tool: 'system.getInfo', input: { sections: ['os'] } });

    // The step line is derived from the tool name and the real arguments, not
    // from the tool's description — that description is written for the model
    // and reads as documentation when shown to a person.
    assert.equal(result.steps[0]!.description, 'System: get info (sections: os)');
  });

  test('the ask-user control function becomes a clarification, not an action', async () => {
    const { planner } = makePlanner([
      {
        toolCalls: [
          {
            id: 'c0',
            name: ASK_USER_FUNCTION,
            input: { question: 'Which drive did you mean?', options: ['C:', 'D:'] },
          },
        ],
      },
    ]);

    const result = await planner.plan(planRequest('clean up the drive'));

    matchObject(result, { kind: 'clarify', question: 'Which drive did you mean?' });
    assert.deepEqual(result.kind === 'clarify' ? result.options : undefined, ['C:', 'D:']);
  });

  test('a clarification wins even when the model also proposed actions', async () => {
    const { planner } = makePlanner([
      {
        toolCalls: [
          { id: 'c0', name: 'system.getInfo', input: {} },
          { id: 'c1', name: ASK_USER_FUNCTION, input: { question: 'Which one?' } },
        ],
      },
    ]);

    const result = await planner.plan(planRequest('do the thing'));

    // Acting on the very ambiguity the model just flagged is the failure mode
    // spec §94 exists to prevent.
    assert.equal(result.kind, 'clarify');
  });

  test('a hallucinated tool is rejected, repaired once, then accepted', async () => {
    const { planner, requests } = makePlanner([
      { toolCalls: [{ id: 'c0', name: 'filesystem.deleteEverything', input: {} }] },
      { toolCalls: [{ id: 'c0', name: 'system.getInfo', input: {} }] },
    ]);

    const result = await planner.plan(planRequest('check the system'));

    assert.equal(result.kind, 'steps');
    assert.equal(requests.length, 2, 'the planner should offer exactly one repair round trip');
    const followUp = requests[1]!.messages.at(-1);
    assert.match(
      followUp?.role === 'user' ? followUp.text : '',
      /filesystem\.deleteEverything/,
      'the rejection reason is fed back so the model can correct itself',
    );
  });

  test('a tool that exists but is not available in this mode is refused', async () => {
    const { planner } = makePlanner([
      { toolCalls: [{ id: 'c0', name: 'developer.inspect', input: { target: 'x' } }] },
      { text: 'I cannot do that in this mode.' },
    ]);

    // `developer.inspect` is registered, but only in developer mode.
    const result = await planner.plan(planRequest('inspect it', { mode: 'controlled' }));

    matchObject(result, { kind: 'reply' });
  });

  test('invalid arguments are rejected rather than passed to the executor', async () => {
    const { planner, requests } = makePlanner([
      { toolCalls: [{ id: 'c0', name: 'system.getInfo', input: { sections: ['not-a-section'] } }] },
      { toolCalls: [{ id: 'c0', name: 'system.getInfo', input: { sections: ['os'] } }] },
    ]);

    const result = await planner.plan(planRequest('check the os'));

    assert.equal(result.kind, 'steps');
    const followUp = requests[1]!.messages.at(-1);
    assert.match(followUp?.role === 'user' ? followUp.text : '', /not valid/);
  });

  test('gives up honestly when the repair also fails, and runs nothing', async () => {
    const { planner } = makePlanner([
      { toolCalls: [{ id: 'c0', name: 'made.up', input: {} }] },
      { toolCalls: [{ id: 'c0', name: 'still.madeUp', input: {} }] },
    ]);

    const result = await planner.plan(planRequest('do something impossible'));

    assert.equal(result.kind, 'reply');
    assert.match(result.kind === 'reply' ? result.message : '', /not run anything/);
  });

  test('never executes a truncated plan', async () => {
    const { planner } = makePlanner([
      {
        finishReason: 'max_tokens',
        toolCalls: [{ id: 'c0', name: 'system.getInfo', input: {} }],
      },
    ]);

    const result = await planner.plan(planRequest('do a very long thing'));

    // The half of a plan that arrived is not a safe subset of the whole.
    assert.equal(result.kind, 'reply');
    assert.match(result.kind === 'reply' ? result.message : '', /cut off/);
  });

  test('reports a provider failure in the user’s terms', async () => {
    const { planner } = makePlanner([new LlmError('auth', 'API key not valid')]);

    const result = await planner.plan(planRequest('anything'));

    assert.equal(result.kind, 'reply');
    assert.match(result.kind === 'reply' ? result.message : '', /API key/);
    assert.ok(
      !(result.kind === 'reply' && result.message.includes('API key not valid')),
      'the raw provider message stays in the logs, not the UI',
    );
  });

  test('re-throws cancellation so the orchestrator handles it as a cancel', async () => {
    const { planner } = makePlanner([new LlmError('cancelled', 'stopped')]);

    await assert.rejects(planner.plan(planRequest('anything')), (error: LlmError) => {
      assert.equal(error.kind, 'cancelled');
      return true;
    });
  });

  test('refuses a request over the context budget without sending it', async () => {
    const config = defaultConfig();
    config.llm.maxContextTokens = 50;
    const { planner, requests } = makePlanner([{ text: 'unreachable' }], config);

    const result = await planner.plan(planRequest('x'.repeat(4000)));

    assert.equal(result.kind, 'reply');
    assert.match(result.kind === 'reply' ? result.message : '', /too large/);
    assert.equal(requests.length, 0, 'nothing is spent on a request we already know is too big');
  });

  test('describes the tools and the safety rules in the system prompt', async () => {
    const { planner, requests } = makePlanner([{ text: 'ok' }]);

    await planner.plan(planRequest('hello'));

    const system = requests[0]!.system;
    assert.match(system, /system\.getInfo/);
    assert.ok(!system.includes('developer.inspect'), 'a mode-gated tool is never described');
    assert.match(system, /Never claim an action has happened/);
    assert.match(system, new RegExp(ASK_USER_FUNCTION));
  });

  test('tells the model the tool list is the whole answer to "what can you do"', async () => {
    // Found live: asked to open Chrome, the model called agent.getStatus to look
    // up its own capabilities, then reported "The results do not answer the
    // question." The catalogue is already in front of it; a reconnaissance call
    // costs a round trip and ends in a non-answer.
    const { planner, requests } = makePlanner([{ text: 'ok' }]);

    await planner.plan(planRequest('open chrome'));

    const system = requests[0]!.system;
    assert.match(system, /complete and\s+authoritative/);
    assert.match(system, /Never call a tool to find out what\s+you are capable of/);
    assert.match(system, /call no tools at all/);
  });
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

function recoveryRequest(): RecoveryRequest {
  return {
    ...planRequest('copy the report'),
    failedStep: {
      id: 'step_1',
      index: 0,
      description: 'Read system information',
      tool: 'system.getInfo',
      input: {},
      status: 'failed',
      attempts: 1,
    },
    error: { code: 'FILE_NOT_FOUND', message: 'No such file', recoverable: true },
    attempt: 1,
  } as RecoveryRequest;
}

describe('LlmPlanner.recover', () => {
  test('shows the model the failure, including the machine-readable code', async () => {
    const { planner, requests } = makePlanner([{ text: 'nothing to try' }]);

    await planner.recover(recoveryRequest());

    const serialised = JSON.stringify(requests[0]!.messages);
    assert.match(serialised, /FILE_NOT_FOUND/);
    assert.match(serialised, /No such file/);
  });

  test('a prose answer during recovery is a give-up, never a completed task', async () => {
    const { planner } = makePlanner([{ text: 'The source file does not exist, so there is nothing to copy.' }]);

    const result = await planner.recover(recoveryRequest());

    // Returning `reply` here would drive the orchestrator to mark a task that
    // actually failed as completed — the exact dishonesty rule 25 forbids.
    assert.equal(result.kind, 'give-up');
    assert.match(result.kind === 'give-up' ? result.reason : '', /does not exist/);
  });

  test('a valid alternative call becomes replacement steps', async () => {
    const { planner } = makePlanner([
      { toolCalls: [{ id: 'c0', name: 'system.getInfo', input: { sections: ['hardware'] } }] },
    ]);

    const result = await planner.recover(recoveryRequest());

    assert.equal(result.kind, 'steps');
  });

  test('always uses the planner model, never the fast one', async () => {
    const config = defaultConfig();
    const { planner, requests } = makePlanner([{ text: 'no' }], config);

    await planner.recover(recoveryRequest());

    assert.equal(requests[0]!.model, config.llm.plannerModel);
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function summaryRequest(steps: unknown[]) {
  return {
    task: { ...planRequest('what cpu do I have').task, steps },
    mode: 'controlled',
    signal: new AbortController().signal,
  } as never;
}

const succeededStep = {
  id: 'step_1',
  index: 0,
  description: 'System: get info',
  tool: 'system.getInfo',
  input: {},
  status: 'succeeded',
  attempts: 1,
  result: { success: true, data: { cpu: 'Intel i7-4800MQ' } },
};

describe('LlmPlanner.summarise', () => {
  test('answers the original question from the tool results', async () => {
    const { planner, requests } = makePlanner([{ text: 'You have an Intel i7-4800MQ.' }]);

    const answer = await planner.summarise(summaryRequest([succeededStep]));

    assert.equal(answer, 'You have an Intel i7-4800MQ.');
    // The results have to reach the model, or it would be inventing the answer.
    assert.match(JSON.stringify(requests[0]!.messages), /Intel i7-4800MQ/);
  });

  test('offers no tools, since reporting must not trigger more actions', async () => {
    const { planner, requests } = makePlanner([{ text: 'ok' }]);

    await planner.summarise(summaryRequest([succeededStep]));

    assert.deepEqual(requests[0]!.tools, []);
  });

  test('requires a non-answer to name what could not be determined', async () => {
    // "The results do not answer the question." is true, and useless. If the
    // report stage has to admit a gap it must say which gap.
    const { planner, requests } = makePlanner([{ text: 'ok' }]);

    await planner.summarise(summaryRequest([succeededStep]));

    const system = requests[0]!.system;
    assert.match(system, /name the specific thing you could not\s+determine/);
    assert.match(system, /never an acceptable answer/);
  });

  test('uses the fast model, because this turn sits between the user and the answer', async () => {
    const config = defaultConfig();
    const { planner, requests } = makePlanner([{ text: 'ok' }], config);

    await planner.summarise(summaryRequest([succeededStep]));

    assert.equal(requests[0]!.model, config.llm.fastModel);
  });

  test('declines rather than guessing when there is nothing to report', async () => {
    const { planner, requests } = makePlanner([{ text: 'unreachable' }]);

    const answer = await planner.summarise(summaryRequest([]));

    assert.equal(answer, undefined);
    assert.equal(requests.length, 0);
  });

  test('a provider failure yields no summary rather than failing the task', async () => {
    const { planner } = makePlanner([new LlmError('server', 'boom')]);

    // The work already succeeded and verified. Failing to phrase it is not a
    // reason to report a failure.
    assert.equal(await planner.summarise(summaryRequest([succeededStep])), undefined);
  });

  test('propagates cancellation so a stop is not mistaken for a phrasing failure', async () => {
    const { planner } = makePlanner([new LlmError('cancelled', 'stopped')]);

    await assert.rejects(planner.summarise(summaryRequest([succeededStep])), (error: LlmError) => {
      assert.equal(error.kind, 'cancelled');
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('ModelRouter', () => {
  const config = defaultConfig();
  const router = new ModelRouter(() => config.llm);

  test('routes a single-clause question to the fast model', () => {
    const route = router.select({ kind: 'plan', instruction: 'what is my cpu' });
    assert.equal(route.model, config.llm.fastModel);
  });

  test('routes chained instructions to the planner model', () => {
    const route = router.select({
      kind: 'plan',
      instruction: 'find my latest invoice and then email it to Sam',
    });
    assert.equal(route.model, config.llm.plannerModel);
  });

  test('plans deterministically', () => {
    assert.equal(router.select({ kind: 'plan', instruction: 'what is my cpu' }).temperature, 0);
  });

  test('classification is cheap; recovery is not', () => {
    assert.equal(router.select({ kind: 'classify' }).model, config.llm.fastModel);
    assert.equal(router.select({ kind: 'recover' }).model, config.llm.plannerModel);
  });
});

describe('classifyInstruction', () => {
  test('recognises simple single-action instructions', () => {
    for (const simple of ['what is the date', 'show my status', 'open notepad', 'hello']) {
      assert.equal(classifyInstruction(simple).simple, true, simple);
    }
  });

  test('treats anything ambiguous as complex, because the mistake costs more than the latency', () => {
    for (const complex of [
      'find every pdf and move them to Archive',
      'if the file exists, delete it',
      'summarise my downloads folder',
      'reorganise these into folders by client name and date',
      'do it',
      '',
    ]) {
      assert.equal(classifyInstruction(complex).simple, false, complex);
    }
  });

  test('a follow-up turn is never routed down', () => {
    assert.equal(classifyInstruction('what is my cpu', 3).simple, false);
  });
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

describe('HybridPlanner', () => {
  const stub = (name: string, kind: string) =>
    ({
      name,
      plan: () => Promise.resolve({ kind: 'reply', message: kind }),
      recover: () => Promise.resolve({ kind: 'give-up', reason: kind }),
    }) as never;

  test('uses the LLM when credentials exist', async () => {
    const planner = new HybridPlanner({
      llm: stub('llm', 'from-llm'),
      fallback: stub('rules', 'from-rules'),
      hasCredentials: () => Promise.resolve(true),
      logger: nullLogger(),
    });

    matchObject(await planner.plan(planRequest('hi')), { message: 'from-llm' });
  });

  test('falls back to deterministic planning when no key is configured', async () => {
    const planner = new HybridPlanner({
      llm: stub('llm', 'from-llm'),
      fallback: stub('rules', 'from-rules'),
      hasCredentials: () => Promise.resolve(false),
      logger: nullLogger(),
    });

    matchObject(await planner.plan(planRequest('hi')), { message: 'from-rules' });
  });

  test('a secret store that throws degrades instead of taking the agent down', async () => {
    const planner = new HybridPlanner({
      llm: stub('llm', 'from-llm'),
      fallback: stub('rules', 'from-rules'),
      hasCredentials: () => Promise.reject(new Error('credential store unavailable')),
      logger: nullLogger(),
    });

    matchObject(await planner.plan(planRequest('hi')), { message: 'from-rules' });
  });

  test('re-checks every turn, so a key added at runtime takes effect immediately', async () => {
    let hasKey = false;
    const planner = new HybridPlanner({
      llm: stub('llm', 'from-llm'),
      fallback: stub('rules', 'from-rules'),
      hasCredentials: () => Promise.resolve(hasKey),
      logger: nullLogger(),
    });

    matchObject(await planner.plan(planRequest('hi')), { message: 'from-rules' });
    hasKey = true;
    matchObject(await planner.plan(planRequest('hi')), { message: 'from-llm' });
  });
});
