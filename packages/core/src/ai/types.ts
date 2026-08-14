import type { LlmProvider as LlmProviderId } from '@samix/shared';

/**
 * Provider-neutral LLM contract (spec §6).
 *
 * ## What this abstraction is for
 *
 * Spec §6 requires that swapping providers not ripple through the system. The
 * rule that makes that real: **nothing outside `src/ai/` may branch on the
 * provider**. The planner, the orchestrator, the executor and the UI all speak
 * the types in this file; each provider module translates them to and from its
 * own wire format and keeps every quirk inside its own walls.
 *
 * ## What is deliberately not here
 *
 * No provider-specific knobs (Gemini's `thinkingConfig`, Anthropic's cache
 * control) leak into this interface. A knob that only one provider has belongs
 * in that provider's options, not in the shared shape — otherwise the
 * abstraction becomes a union of every API it wraps, which is no abstraction.
 */

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

/**
 * A tool as described to a model, in provider-neutral form.
 *
 * `parameters` is plain JSON Schema. It is NOT yet safe to send to any given
 * provider — each one accepts a different subset, so the provider module is
 * responsible for projecting this into its own dialect (see
 * `json-schema.ts` for Gemini's). Keeping the raw schema here means the
 * registry stays provider-agnostic and the lossy step happens exactly once, at
 * the wire boundary, where it can be tested per provider.
 */
export interface ToolSchema {
  /** SAMIX tool name, dot-namespaced, e.g. `filesystem.copy`. */
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export interface LlmToolCall {
  /**
   * Correlates a call with its result. Gemini does not supply one, so the
   * provider synthesises it; treat it as opaque.
   */
  readonly id: string;
  /** SAMIX tool name, already decoded from the provider's naming rules. */
  readonly name: string;
  /** Raw arguments. Untrusted — always re-validated against the tool's Zod schema. */
  readonly input: unknown;
}

export type LlmMessage =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'model'; readonly text?: string; readonly toolCalls?: readonly LlmToolCall[] }
  /** The outcome of a tool the model asked for, fed back so it can continue. */
  | { readonly role: 'tool'; readonly name: string; readonly result: unknown };

export type FinishReason = 'stop' | 'max_tokens' | 'safety' | 'other';

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LlmRequest {
  readonly model: string;
  /** Standing instructions. Sent as a system instruction, not as a user turn. */
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly ToolSchema[];
  readonly maxOutputTokens: number;
  /**
   * Lower is more deterministic. An agent driving a desktop should be boring
   * and repeatable, so callers pass a low value; it is explicit rather than
   * defaulted so the choice is visible at the call site.
   */
  readonly temperature: number;
  /** Emergency stop and task cancellation both abort in-flight requests. */
  readonly signal: AbortSignal;
}

export interface LlmResponse {
  /** Prose the model produced. Empty string when it only called tools. */
  readonly text: string;
  readonly toolCalls: readonly LlmToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: LlmUsage;
  /** The model that actually served the request, for logs and cost attribution. */
  readonly model: string;
  readonly durationMs: number;
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  /** Human-readable, for the status pane and logs. */
  readonly name: string;
  generate(request: LlmRequest): Promise<LlmResponse>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Why a request failed, in terms the caller can act on.
 *
 * The split that matters is `retryable`: a 429 or a socket reset should be
 * retried with backoff, while a 400 (our schema is malformed) or a 401 (the key
 * is wrong) will fail identically forever and retrying only wastes the user's
 * time and quota.
 */
export type LlmErrorKind =
  /** Missing, malformed or rejected credentials. */
  | 'auth'
  /** Key is valid but not entitled to this model, or the quota is spent. */
  | 'quota'
  /** Temporarily rate limited. */
  | 'rate_limit'
  /** We sent something the API refused — almost always a schema defect. */
  | 'bad_request'
  /** The requested model does not exist or was retired. */
  | 'model_not_found'
  /** Provider-side fault (5xx). */
  | 'server'
  /** DNS, TLS, socket. */
  | 'network'
  | 'timeout'
  /** Cancelled by the user (emergency stop) rather than failed. */
  | 'cancelled'
  /** Blocked by the provider's safety filters. */
  | 'safety'
  /** The response could not be understood. */
  | 'malformed_response';

const RETRYABLE: ReadonlySet<LlmErrorKind> = new Set<LlmErrorKind>([
  'rate_limit',
  'server',
  'network',
  'timeout',
]);

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(kind: LlmErrorKind, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = options.status;
    this.retryable = RETRYABLE.has(kind);
  }

  /**
   * A sentence safe to show the user.
   *
   * Provider error bodies can echo request content back, so the raw message is
   * kept for logs (where redaction applies) and this plainer text is what the
   * UI renders.
   */
  userMessage(): string {
    switch (this.kind) {
      case 'auth':
        return 'The AI provider rejected the API key. Check it in Settings.';
      case 'quota':
        return 'This API key is not entitled to that model, or its quota is exhausted.';
      case 'rate_limit':
        return 'The AI provider is rate limiting requests. Try again shortly.';
      case 'model_not_found':
        return 'The configured model no longer exists. Pick another in Settings.';
      case 'bad_request':
        return 'The request sent to the AI provider was rejected. This is a bug in SAMIX, not in your instruction.';
      case 'server':
        return 'The AI provider had a server error.';
      case 'network':
        return 'Could not reach the AI provider. Check the network connection.';
      case 'timeout':
        return 'The AI provider took too long to respond.';
      case 'cancelled':
        return 'Cancelled.';
      case 'safety':
        return 'The AI provider blocked that request under its safety policy.';
      case 'malformed_response':
        return 'The AI provider returned a response SAMIX could not read.';
    }
  }
}
