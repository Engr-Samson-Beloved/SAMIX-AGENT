import type { ToolError, ToolErrorCode, ToolResult, Verification, VerificationStatus } from './types/tool.js';

/**
 * Constructors for `ToolResult`. Every tool returns through these helpers so
 * the shape stays uniform and `metadata.durationMs` is never forgotten by
 * accident (the executor fills it in).
 */

export function ok<T>(data: T, metadata?: ToolResult<T>['metadata']): ToolResult<T> {
  return metadata ? { success: true, data, metadata } : { success: true, data };
}

export function err<T = never>(
  code: ToolErrorCode,
  message: string,
  options: { recoverable?: boolean; details?: Record<string, unknown> } = {},
): ToolResult<T> {
  const error: ToolError = {
    code,
    message,
    // Default to recoverable: the planner may retry or re-plan. Callers opt out
    // explicitly for conditions no retry can fix (blocked, cancelled, invalid).
    recoverable: options.recoverable ?? true,
    ...(options.details ? { details: options.details } : {}),
  };
  return { success: false, error };
}

/** Error codes that no amount of retrying can resolve. */
const NON_RECOVERABLE: ReadonlySet<ToolErrorCode> = new Set([
  'ACTION_BLOCKED',
  'USER_CANCELLED',
  'PERMISSION_DENIED',
  'INVALID_INPUT',
  'TOOL_NOT_FOUND',
  'UNSUPPORTED_PLATFORM',
]);

export function isRecoverable(code: ToolErrorCode): boolean {
  return !NON_RECOVERABLE.has(code);
}

export function verification(status: VerificationStatus, detail: string): Verification {
  return { status, detail, checkedAt: new Date().toISOString() };
}

/**
 * Coerce an unknown thrown value into a ToolError. Used at every catch site so
 * a stray `throw 'oops'` still produces a well-formed, machine-readable result.
 */
export function toToolError(cause: unknown, fallbackCode: ToolErrorCode = 'INTERNAL_ERROR'): ToolError {
  if (cause instanceof Error) {
    if (cause.name === 'AbortError') {
      return { code: 'USER_CANCELLED', message: 'Cancelled before completion.', recoverable: false };
    }
    if (cause.name === 'TimeoutError') {
      return { code: 'TIMEOUT', message: cause.message, recoverable: true };
    }
    return { code: fallbackCode, message: cause.message, recoverable: isRecoverable(fallbackCode) };
  }
  return {
    code: fallbackCode,
    message: typeof cause === 'string' ? cause : 'Unknown error',
    recoverable: isRecoverable(fallbackCode),
  };
}
