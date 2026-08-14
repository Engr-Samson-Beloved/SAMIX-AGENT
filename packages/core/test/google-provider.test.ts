import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  ASK_USER_FUNCTION,
  GoogleProvider,
  assertEncodable,
  decodeToolName,
  encodeToolName,
  toFunctionDeclarations,
  type LlmError,
  type LlmRequest,
} from '../dist/index.js';
import { matchObject } from './helpers.ts';

/**
 * The Gemini provider, driven through an injected `fetch`.
 *
 * The wire shape asserted here is the one `scripts/check-gemini.mjs` verified
 * against the live API, so these tests lock in a format known to work rather
 * than one taken from documentation. They also pin the two behaviours that are
 * easy to get subtly wrong and expensive when wrong: what gets retried, and
 * what a cancellation does.
 */

interface Recorded {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** A fetch double that replays queued responses and records what it was sent. */
function fakeFetch(responses: Array<{ status?: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const queue = [...responses];

  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = queue.shift() ?? { status: 500, body: { error: { message: 'no response queued' } } };
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function textResponse(text: string): unknown {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    modelVersion: 'gemini-3.6-flash',
  };
}

function callResponse(name: string, args: unknown): unknown {
  return {
    candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 },
  };
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'gemini-3.6-flash',
    system: 'You are a planner.',
    messages: [{ role: 'user', text: 'What is my computer?' }],
    tools: [
      {
        name: 'system.getInfo',
        description: 'Read information about this computer.',
        parameters: {
          type: 'object',
          properties: { sections: { type: 'array', items: { type: 'string' } } },
        },
      },
    ],
    maxOutputTokens: 1024,
    temperature: 0,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('tool name encoding', () => {
  test('round-trips a dot-namespaced name', () => {
    assert.equal(encodeToolName('filesystem.copy'), 'filesystem_copy');
    assert.equal(decodeToolName('filesystem_copy'), 'filesystem.copy');
  });

  test('rejects a name that would not survive the round trip', () => {
    // The encoding is only bijective because tool names cannot contain `_`.
    assert.throws(() => assertEncodable('bad_name.thing'), /underscore/);
  });

  test('rejects a name colliding with the reserved control function', () => {
    assert.throws(() => assertEncodable(ASK_USER_FUNCTION.replace(/_/g, '.')), /reserved/);
  });
});

describe('function declarations', () => {
  test('omits parameters for a tool with no input', () => {
    const { declarations } = toFunctionDeclarations([
      { name: 'agent.getStatus', description: 'Read the status.', parameters: { type: 'object', properties: {} } },
    ]);

    assert.equal(declarations[0]?.name, 'agent_getStatus');
    assert.ok(!('parameters' in declarations[0]!), 'an empty parameter object is rejected by Gemini');
  });

  test('reports schema degradation without failing', () => {
    const { declarations, warnings } = toFunctionDeclarations([
      {
        name: 'demo.thing',
        description: 'A demo.',
        parameters: { type: 'object', properties: { n: { type: 'integer', enum: [1, 2] } } },
      },
    ]);

    assert.equal(declarations.length, 1);
    assert.ok(warnings.some((w) => w.startsWith('demo.thing:')), 'warnings are attributed to the tool');
  });
});

describe('GoogleProvider request shape', () => {
  test('sends the key in a header and never in the body', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: textResponse('hello') }]);
    const provider = new GoogleProvider({ apiKey: 'secret-key-value', fetchImpl });

    await provider.generate(request());

    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers['x-goog-api-key'], 'secret-key-value');
    assert.ok(
      !JSON.stringify(calls[0]!.body).includes('secret-key-value'),
      'the key must never appear in a request body',
    );
    assert.ok(!calls[0]!.url.includes('secret-key-value'), 'the key must never appear in a URL');
  });

  test('builds the verified Gemini envelope', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: textResponse('hi') }]);
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl });

    await provider.generate(request());

    matchObject(calls[0]!.body, {
      systemInstruction: { parts: [{ text: 'You are a planner.' }] },
      generationConfig: { temperature: 0, maxOutputTokens: 1024, candidateCount: 1 },
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    });
    assert.deepEqual(calls[0]!.body['contents'], [
      { role: 'user', parts: [{ text: 'What is my computer?' }] },
    ]);
    assert.match(calls[0]!.url, /models\/gemini-3\.6-flash:generateContent$/);
  });

  test('always offers the ask-user control function alongside real tools', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: textResponse('hi') }]);
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl });

    await provider.generate(request());

    const tools = calls[0]!.body['tools'] as Array<{ functionDeclarations: Array<{ name: string }> }>;
    const names = tools[0]!.functionDeclarations.map((d) => d.name);
    assert.deepEqual(names, ['system_getInfo', ASK_USER_FUNCTION]);
  });

  test('encodes a tool result as a functionResponse turn', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: textResponse('ok') }]);
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl });

    await provider.generate(
      request({
        messages: [
          { role: 'user', text: 'go' },
          { role: 'model', toolCalls: [{ id: 'c0', name: 'system.getInfo', input: {} }] },
          { role: 'tool', name: 'system.getInfo', result: { cpu: 'x86' } },
        ],
      }),
    );

    const contents = calls[0]!.body['contents'] as Array<Record<string, unknown>>;
    assert.equal(contents[1]!['role'], 'model');
    matchObject((contents[1]!['parts'] as unknown[])[0], {
      functionCall: { name: 'system_getInfo', args: {} },
    });

    // Gemini has no dedicated tool role in v1beta; results come back on `user`.
    assert.equal(contents[2]!['role'], 'user');
    matchObject((contents[2]!['parts'] as unknown[])[0], {
      functionResponse: { name: 'system_getInfo', response: { cpu: 'x86' } },
    });
  });

  test('wraps a non-object tool result, which the API requires to be an object', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: textResponse('ok') }]);
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl });

    await provider.generate(
      request({ messages: [{ role: 'tool', name: 'system.getInfo', result: 'a bare string' }] }),
    );

    const contents = calls[0]!.body['contents'] as Array<Record<string, unknown>>;
    matchObject((contents[0]!['parts'] as unknown[])[0], {
      functionResponse: { response: { result: 'a bare string' } },
    });
  });
});

describe('GoogleProvider response parsing', () => {
  test('reads text and usage', async () => {
    const { fetchImpl } = fakeFetch([{ body: textResponse('  the answer  ') }]);
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl });

    const response = await provider.generate(request());

    assert.equal(response.text, 'the answer');
    assert.deepEqual(response.toolCalls, []);
    assert.equal(response.finishReason, 'stop');
    assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(response.model, 'gemini-3.6-flash');
  });

  test('decodes a function call back to the SAMIX tool name', async () => {
    const { fetchImpl } = fakeFetch([{ body: callResponse('system_getInfo', { sections: ['os'] }) }]);
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl });

    const response = await provider.generate(request());

    assert.equal(response.toolCalls.length, 1);
    matchObject(response.toolCalls[0]!, { name: 'system.getInfo', input: { sections: ['os'] } });
  });

  test('passes the control function through without decoding it', async () => {
    const { fetchImpl } = fakeFetch([{ body: callResponse(ASK_USER_FUNCTION, { question: 'Which one?' }) }]);
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl });

    const response = await provider.generate(request());

    assert.equal(response.toolCalls[0]?.name, ASK_USER_FUNCTION);
  });

  test('ignores thought parts, which are reasoning and not an answer', async () => {
    const { fetchImpl } = fakeFetch([
      {
        body: {
          candidates: [
            {
              content: { parts: [{ text: 'internal musing', thought: true }, { text: 'real answer' }] },
              finishReason: 'STOP',
            },
          ],
        },
      },
    ]);
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl });

    const response = await provider.generate(request());

    assert.equal(response.text, 'real answer');
  });

  test('surfaces a blocked prompt as a safety error, not an empty response', async () => {
    const { fetchImpl } = fakeFetch([{ body: { promptFeedback: { blockReason: 'SAFETY' } } }]);
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl });

    await assert.rejects(provider.generate(request()), (error: LlmError) => {
      assert.equal(error.kind, 'safety');
      return true;
    });
  });
});

describe('GoogleProvider error handling', () => {
  test('retries a 503 and succeeds', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 503, body: { error: { message: 'overloaded' } } },
      { body: textResponse('recovered') },
    ]);
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl, maxAttempts: 3 });

    const response = await provider.generate(request());

    assert.equal(response.text, 'recovered');
    assert.equal(calls.length, 2);
  });

  test('does not retry a 400, because a malformed schema never fixes itself', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 400, body: { error: { message: 'Invalid JSON payload' } } },
    ]);
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl, maxAttempts: 3 });

    await assert.rejects(provider.generate(request()), (error: LlmError) => {
      assert.equal(error.kind, 'bad_request');
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(calls.length, 1, 'a bad request must be attempted exactly once');
  });

  test('separates a rate limit from a missing entitlement, though both are 429', async () => {
    const limited = fakeFetch([
      { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded, retry later' } } },
      { body: textResponse('after backoff') },
    ]);
    const limitedProvider = new GoogleProvider({ apiKey: 'k', fetchImpl: limited.fetchImpl, maxAttempts: 2 });
    assert.equal((await limitedProvider.generate(request())).text, 'after backoff');

    const unentitled = fakeFetch([
      {
        status: 429,
        body: {
          error: {
            status: 'RESOURCE_EXHAUSTED',
            message: 'Your project does not have access to this model. Enable billing.',
          },
        },
      },
    ]);
    const unentitledProvider = new GoogleProvider({
      apiKey: 'k',
      fetchImpl: unentitled.fetchImpl,
      maxAttempts: 3,
    });

    await assert.rejects(unentitledProvider.generate(request()), (error: LlmError) => {
      assert.equal(error.kind, 'quota');
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(unentitled.calls.length, 1, 'no entitlement never resolves by retrying');
  });

  test('classifies auth and missing-model failures distinctly', async () => {
    for (const [status, kind] of [
      [401, 'auth'],
      [403, 'auth'],
      [404, 'model_not_found'],
    ] as const) {
      const { fetchImpl } = fakeFetch([{ status, body: { error: { message: 'nope' } } }]);
      const provider = new GoogleProvider({ apiKey: 'k', fetchImpl, maxAttempts: 1 });
      await assert.rejects(provider.generate(request()), (error: LlmError) => {
        assert.equal(error.kind, kind, `HTTP ${status}`);
        return true;
      });
    }
  });

  test('treats a 400 mentioning the API key as an auth problem', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.' } } },
    ]);
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl, maxAttempts: 1 });

    await assert.rejects(provider.generate(request()), (error: LlmError) => {
      assert.equal(error.kind, 'auth');
      return true;
    });
  });

  test('fails before sending anything when no key is configured', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: textResponse('unreachable') }]);
    const provider = new GoogleProvider({ apiKey: () => undefined, fetchImpl });

    await assert.rejects(provider.generate(request()), (error: LlmError) => {
      assert.equal(error.kind, 'auth');
      return true;
    });
    assert.equal(calls.length, 0);
  });

  test('resolves the key per request, so a rotated key takes effect immediately', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: textResponse('a') }, { body: textResponse('b') }]);
    let current = 'first';
    const provider = new GoogleProvider({ apiKey: () => current, fetchImpl });

    await provider.generate(request());
    current = 'second';
    await provider.generate(request());

    assert.equal((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key'], 'first');
    assert.equal((calls[1]!.init.headers as Record<string, string>)['x-goog-api-key'], 'second');
  });

  test('an aborted signal cancels rather than failing, and sends nothing', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: textResponse('unreachable') }]);
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(provider.generate(request({ signal: controller.signal })), (error: LlmError) => {
      assert.equal(error.kind, 'cancelled');
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  test('gives up after the attempt budget rather than retrying forever', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 503, body: { error: { message: 'a' } } },
      { status: 503, body: { error: { message: 'b' } } },
      { status: 503, body: { error: { message: 'c' } } },
      { status: 503, body: { error: { message: 'd' } } },
    ]);
    const provider = new GoogleProvider({ apiKey: 'k', fetchImpl, maxAttempts: 3 });

    await assert.rejects(provider.generate(request()), (error: LlmError) => {
      assert.equal(error.kind, 'server');
      return true;
    });
    assert.equal(calls.length, 3);
  });
});
