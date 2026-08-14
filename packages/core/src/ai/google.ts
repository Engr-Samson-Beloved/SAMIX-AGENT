import { toGeminiSchema, type GeminiSchema } from './json-schema.js';
import {
  LlmError,
  type FinishReason,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmToolCall,
  type ToolSchema,
} from './types.js';

/**
 * Google Gemini provider.
 *
 * ## No SDK, deliberately
 *
 * This talks to the REST API over `fetch` rather than through `@google/genai`.
 * Reasons, in order of weight:
 *
 *  1. The exact wire format used here was verified against the live API on this
 *     project's own key by `scripts/check-gemini.mjs`, including function
 *     calling. There is no guesswork to insulate ourselves from.
 *  2. Retry policy, cancellation and error classification all have to be ours
 *     anyway — the agent's cancellation semantics (spec §33: emergency stop
 *     aborts everything in flight) are stricter than any SDK default.
 *  3. A sidecar that ships inside a desktop installer pays for every dependency
 *     in install size, supply-chain surface and build fragility. This module is
 *     smaller than the SDK's type definitions.
 *
 * The cost is that Google can change the wire format under us. That is mitigated
 * by `pnpm check:gemini`, which exercises this exact shape against the live API.
 *
 * ## Everything Gemini-specific stops here
 *
 * Callers see only the types in `types.ts`. Naming rules, schema dialect,
 * `functionResponse` envelopes and error taxonomies are all translated at this
 * boundary (spec §6).
 */

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GoogleProviderOptions {
  /**
   * The API key, or a resolver called before each request.
   *
   * The resolver form is what production uses: the key lives in the secret
   * store, reading it is async, and it can change while the app is running
   * (the user pastes a new one into Settings). Resolving per request means a
   * rotated key takes effect on the next turn instead of the next restart, and
   * it keeps the composition root synchronous.
   *
   * Never logged, never placed in a request body.
   */
  readonly apiKey: string | (() => string | undefined | Promise<string | undefined>);
  readonly baseUrl?: string;
  /** Wall-clock budget for one attempt, excluding retries. */
  readonly requestTimeoutMs?: number;
  /** Total attempts including the first. 1 disables retrying. */
  readonly maxAttempts?: number;
  /** Injected in tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Called after every attempt, successful or not. Diagnostics only. */
  readonly onAttempt?: (info: AttemptInfo) => void;
}

export interface AttemptInfo {
  readonly model: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly status: number | undefined;
  readonly error: LlmError | undefined;
}

/**
 * Gemini function names must match `[a-zA-Z_][a-zA-Z0-9_.-]{0,63}`. Dots are
 * accepted today, but underscores are accepted by every provider we might add,
 * so the encoding is chosen once here and never revisited.
 *
 * The mapping is bijective because `ToolRegistry`'s `NAME_PATTERN` forbids
 * underscores in tool names: every `_` in an encoded name came from a `.`.
 * `assertEncodable` enforces that rather than assuming it.
 */
export function encodeToolName(name: string): string {
  return name.replace(/\./g, '_');
}

export function decodeToolName(encoded: string): string {
  return encoded.replace(/_/g, '.');
}

/**
 * Control function the planner declares alongside the real tools, so the model
 * has a first-class way to say "I need to ask the user something" instead of
 * guessing (spec §21, §94).
 *
 * It is not in the registry and can never be executed; the planner intercepts
 * it. The name contains two underscores so it cannot collide with a real tool
 * name, which always encodes to exactly one underscore per namespace separator.
 */
export const ASK_USER_FUNCTION = 'samix__ask_user';

export const ASK_USER_DECLARATION = {
  name: ASK_USER_FUNCTION,
  description:
    'Ask the user a clarifying question instead of acting. Use this whenever the instruction is ambiguous ' +
    'and acting on the wrong interpretation would be costly or hard to undo — especially before sending ' +
    'anything to another person, or before deleting or overwriting anything. Never guess in those cases.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to put to the user, in one sentence.' },
      options: {
        type: 'array',
        description: 'Optional list of concrete choices the user can pick from.',
        items: { type: 'string' },
      },
    },
    required: ['question'],
    propertyOrdering: ['question', 'options'],
  },
} as const;

/** Throws if a tool name cannot survive the round trip. Called at projection time. */
export function assertEncodable(name: string): void {
  if (name.includes('_')) {
    throw new Error(
      `Tool name "${name}" contains an underscore, which collides with the Gemini name encoding ` +
        `(dots are encoded as underscores). Rename the tool.`,
    );
  }
  const encoded = encodeToolName(name);
  if (encoded === ASK_USER_FUNCTION) {
    throw new Error(`Tool name "${name}" collides with the reserved control function.`);
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(encoded)) {
    throw new Error(`Tool name "${name}" is not a legal Gemini function name once encoded.`);
  }
}

interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: GeminiSchema;
}

/**
 * Project provider-neutral tool schemas into Gemini function declarations.
 *
 * Exported so it can be unit-tested against every registered tool: a schema
 * that survives here is one that cannot break tool calling at runtime.
 */
export function toFunctionDeclarations(tools: readonly ToolSchema[]): {
  declarations: FunctionDeclaration[];
  warnings: string[];
} {
  const declarations: FunctionDeclaration[] = [];
  const warnings: string[] = [];

  for (const tool of tools) {
    assertEncodable(tool.name);
    const { schema, warnings: schemaWarnings } = toGeminiSchema(tool.parameters);
    for (const warning of schemaWarnings) warnings.push(`${tool.name}: ${warning}`);

    declarations.push({
      name: encodeToolName(tool.name),
      description: tool.description,
      // Omitted rather than empty: Gemini rejects a declaration whose
      // `parameters` is an object schema with no properties.
      ...(schema ? { parameters: schema } : {}),
    });
  }

  return { declarations, warnings };
}

export class GoogleProvider implements LlmProvider {
  readonly id = 'google' as const;
  readonly name = 'Google Gemini';

  private readonly resolveKey: () => string | undefined | Promise<string | undefined>;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onAttempt: ((info: AttemptInfo) => void) | undefined;

  constructor(options: GoogleProviderOptions) {
    this.resolveKey =
      typeof options.apiKey === 'function' ? options.apiKey : (): string => options.apiKey as string;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.onAttempt = options.onAttempt;
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const apiKey = (await this.resolveKey())?.trim();
    if (!apiKey) {
      throw new LlmError('auth', 'No Google API key is configured.');
    }

    const body = this.buildBody(request);
    const url = `${this.baseUrl}/models/${encodeURIComponent(request.model)}:generateContent`;
    const started = Date.now();

    let lastError: LlmError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      // Cancellation is checked before every attempt, not only at entry, so a
      // stop during backoff takes effect immediately.
      if (request.signal.aborted) throw new LlmError('cancelled', 'Cancelled before the request was sent.');

      const attemptStarted = Date.now();
      let status: number | undefined;
      try {
        const { payload, httpStatus } = await this.attempt(url, body, apiKey, request.signal);
        status = httpStatus;
        this.onAttempt?.({ model: request.model, attempt, durationMs: Date.now() - attemptStarted, status, error: undefined });
        return this.parseResponse(payload, request.model, Date.now() - started);
      } catch (cause) {
        const error = cause instanceof LlmError ? cause : classifyThrown(cause, request.signal);
        status = error.status;
        this.onAttempt?.({ model: request.model, attempt, durationMs: Date.now() - attemptStarted, status, error });

        // A cancelled request is not a failure to retry — the user asked us to
        // stop, and retrying would ignore that.
        if (error.kind === 'cancelled') throw error;
        if (!error.retryable || attempt === this.maxAttempts) throw error;

        lastError = error;
        await backoff(attempt, request.signal);
      }
    }

    /* c8 ignore next */
    throw lastError ?? new LlmError('server', 'Request failed with no recorded error.');
  }

  // -------------------------------------------------------------------------
  // Wire format
  // -------------------------------------------------------------------------

  private buildBody(request: LlmRequest): Record<string, unknown> {
    const { declarations } = toFunctionDeclarations(request.tools);
    const body: Record<string, unknown> = {
      contents: toContents(request.messages),
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        // One candidate only. Sampling several and picking would cost tokens
        // and latency for a decision nothing downstream is equipped to make.
        candidateCount: 1,
      },
    };

    if (request.system.trim() !== '') {
      body['systemInstruction'] = { parts: [{ text: request.system }] };
    }

    if (declarations.length > 0 || request.tools.length > 0) {
      body['tools'] = [{ functionDeclarations: [...declarations, ASK_USER_DECLARATION] }];
      // AUTO rather than ANY: the model must stay free to answer in prose, or
      // it can never say "that needs no tools" and would fabricate a call.
      body['toolConfig'] = { functionCallingConfig: { mode: 'AUTO' } };
    }

    return body;
  }

  private async attempt(
    url: string,
    body: Record<string, unknown>,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<{ payload: unknown; httpStatus: number }> {
    // Two independent reasons to abort: the caller stopped us, or this attempt
    // outran its budget. `AbortSignal.any` lets one listener serve both.
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          // The key travels in a header and appears in no body and no log line.
          'x-goog-api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (cause) {
      throw classifyThrown(cause, signal);
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text === '' ? {} : JSON.parse(text);
    } catch {
      if (response.ok) {
        throw new LlmError('malformed_response', 'Gemini returned a body that is not JSON.', {
          status: response.status,
        });
      }
      payload = {};
    }

    if (!response.ok) throw classifyHttp(response.status, payload, text);
    return { payload, httpStatus: response.status };
  }

  private parseResponse(payload: unknown, requestedModel: string, durationMs: number): LlmResponse {
    const root = asRecord(payload);

    // A prompt blocked before generation has no candidates at all, only a
    // `promptFeedback`. Reporting that as "empty response" would send the user
    // hunting for a bug that is really a policy refusal.
    const feedback = asRecord(root['promptFeedback']);
    const blockReason = feedback['blockReason'];
    if (typeof blockReason === 'string') {
      throw new LlmError('safety', `Gemini blocked the prompt (${blockReason}).`);
    }

    const candidates = root['candidates'];
    const candidate = asRecord(Array.isArray(candidates) ? candidates[0] : undefined);
    const rawFinish = typeof candidate['finishReason'] === 'string' ? candidate['finishReason'] : '';

    if (rawFinish === 'SAFETY' || rawFinish === 'PROHIBITED_CONTENT' || rawFinish === 'BLOCKLIST') {
      throw new LlmError('safety', `Gemini stopped generating (${rawFinish}).`);
    }

    const parts = asRecord(candidate['content'])['parts'];
    const texts: string[] = [];
    const toolCalls: LlmToolCall[] = [];

    if (Array.isArray(parts)) {
      for (const [index, raw] of parts.entries()) {
        const part = asRecord(raw);

        // `thought: true` marks internal reasoning. It is not an answer and
        // must never be shown to the user or fed back as the model's reply.
        if (part['thought'] === true) continue;

        if (typeof part['text'] === 'string' && part['text'] !== '') texts.push(part['text']);

        const call = asRecord(part['functionCall']);
        if (typeof call['name'] === 'string') {
          toolCalls.push({
            // Gemini supplies no call id, so one is synthesised. It only has to
            // be unique within this response, which is what it correlates.
            id: `call_${index}`,
            name: call['name'] === ASK_USER_FUNCTION ? ASK_USER_FUNCTION : decodeToolName(call['name']),
            input: call['args'] ?? {},
          });
        }
      }
    }

    if (texts.length === 0 && toolCalls.length === 0 && rawFinish !== 'MAX_TOKENS') {
      throw new LlmError('malformed_response', 'Gemini returned neither text nor a tool call.');
    }

    const usage = asRecord(root['usageMetadata']);
    const model = typeof root['modelVersion'] === 'string' ? root['modelVersion'] : requestedModel;

    return {
      text: texts.join('').trim(),
      toolCalls,
      finishReason: mapFinishReason(rawFinish),
      usage: {
        inputTokens: numberOr(usage['promptTokenCount'], 0),
        outputTokens: numberOr(usage['candidatesTokenCount'], 0),
      },
      model,
      durationMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Message translation
// ---------------------------------------------------------------------------

function toContents(messages: readonly LlmMessage[]): unknown[] {
  const contents: unknown[] = [];

  for (const message of messages) {
    switch (message.role) {
      case 'user':
        contents.push({ role: 'user', parts: [{ text: message.text }] });
        break;

      case 'model': {
        const parts: unknown[] = [];
        if (message.text && message.text !== '') parts.push({ text: message.text });
        for (const call of message.toolCalls ?? []) {
          parts.push({
            functionCall: {
              name: call.name === ASK_USER_FUNCTION ? ASK_USER_FUNCTION : encodeToolName(call.name),
              args: call.input ?? {},
            },
          });
        }
        // An empty `parts` array is rejected by the API. It should be
        // unreachable, but a malformed history must not take the request down.
        if (parts.length > 0) contents.push({ role: 'model', parts });
        break;
      }

      case 'tool':
        contents.push({
          // Function results are sent back on the `user` turn — Gemini has no
          // separate tool role in v1beta.
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: encodeToolName(message.name),
                // `response` must be a JSON object. Scalars and arrays are
                // wrapped so a tool returning a bare value still round-trips.
                response: wrapResponse(message.result),
              },
            },
          ],
        });
        break;
    }
  }

  return contents;
}

function wrapResponse(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value ?? null };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyHttp(status: number, payload: unknown, rawText: string): LlmError {
  const error = asRecord(asRecord(payload)['error']);
  const message =
    typeof error['message'] === 'string' && error['message'] !== ''
      ? error['message']
      : rawText.slice(0, 300) || `HTTP ${status}`;
  const googleStatus = typeof error['status'] === 'string' ? error['status'] : '';

  if (status === 401 || status === 403) return new LlmError('auth', message, { status });

  if (status === 400) {
    // Google returns 400 for both "your key is invalid" and "your schema is
    // wrong". They demand completely different fixes, so they are separated by
    // the message rather than collapsed into one unhelpful error.
    if (/api[ _-]?key/i.test(message)) return new LlmError('auth', message, { status });
    return new LlmError('bad_request', message, { status });
  }

  if (status === 404) return new LlmError('model_not_found', message, { status });

  if (status === 429 || googleStatus === 'RESOURCE_EXHAUSTED') {
    // Two very different conditions share this status. Being rate limited is
    // temporary and worth retrying; having no entitlement to the model never
    // resolves on its own, and retrying it just burns the user's time.
    if (/not have access|does not have|billing|not entitled|limit: 0|free tier/i.test(message)) {
      return new LlmError('quota', message, { status });
    }
    return new LlmError('rate_limit', message, { status });
  }

  if (status >= 500) return new LlmError('server', message, { status });
  return new LlmError('server', message, { status });
}

function classifyThrown(cause: unknown, callerSignal: AbortSignal): LlmError {
  if (cause instanceof LlmError) return cause;

  const name = cause instanceof Error ? cause.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    // The combined signal cannot say which input fired, so the caller's signal
    // is consulted directly. Getting this backwards would report a user's
    // emergency stop as a provider timeout.
    return callerSignal.aborted
      ? new LlmError('cancelled', 'The request was cancelled.', { cause })
      : new LlmError('timeout', 'The request to Gemini timed out.', { cause });
  }

  const message = cause instanceof Error ? cause.message : String(cause);
  return new LlmError('network', `Could not reach Gemini: ${message}`, { cause });
}

/** Exponential backoff with jitter, abortable. */
async function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  // Jitter matters even for one client: without it, a retry storm after a
  // provider blip lands in lockstep and re-triggers the rate limit.
  const base = Math.min(500 * 2 ** (attempt - 1), 8_000);
  const delay = base / 2 + Math.random() * (base / 2);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new LlmError('cancelled', 'Cancelled while waiting to retry.'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function mapFinishReason(raw: string): FinishReason {
  switch (raw) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'safety';
    default:
      return 'other';
  }
}
