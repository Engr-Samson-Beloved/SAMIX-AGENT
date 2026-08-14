import type { LlmProvider as LlmProviderId } from '@samix/shared';
import { GoogleProvider, type GoogleProviderOptions } from './google.js';
import { LlmError, type LlmProvider } from './types.js';

export { toGeminiSchema } from './json-schema.js';
export type { GeminiSchema, SchemaConversionResult } from './json-schema.js';
export {
  GoogleProvider,
  ASK_USER_FUNCTION,
  ASK_USER_DECLARATION,
  assertEncodable,
  decodeToolName,
  encodeToolName,
  toFunctionDeclarations,
} from './google.js';
export type { AttemptInfo, GoogleProviderOptions } from './google.js';
export { ModelRouter, classifyInstruction } from './model-router.js';
export type { InstructionVerdict, Route, RouteRequest, TurnKind } from './model-router.js';
export { LlmError } from './types.js';
export type {
  FinishReason,
  LlmErrorKind,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmToolCall,
  LlmUsage,
  ToolSchema,
} from './types.js';

/**
 * Build the provider named in configuration.
 *
 * This is the ONLY place in the codebase that maps a provider id to an
 * implementation. Spec §6's requirement — that swapping providers not ripple
 * outwards — is only true if that mapping exists once, so anything tempted to
 * write `if (provider === 'google')` elsewhere belongs here instead.
 *
 * Unimplemented providers throw rather than silently degrading to Google. A user
 * who selected OpenAI and got Gemini would have no way to tell, and could send
 * data to a provider they deliberately did not choose.
 */
export function createProvider(
  id: LlmProviderId,
  options: GoogleProviderOptions,
): LlmProvider {
  switch (id) {
    case 'google':
      return new GoogleProvider(options);
    case 'anthropic':
    case 'openai':
    case 'local':
      throw new LlmError(
        'bad_request',
        `The "${id}" provider is not implemented yet. This build supports Google Gemini.`,
      );
  }
}
