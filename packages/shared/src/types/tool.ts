import { z } from 'zod';
import { AgentModeSchema, type AgentMode } from './mode.js';

/**
 * Tool contract (spec §11, §49, §50).
 *
 * Design notes
 * ------------
 * 1. A tool is data plus one function. It declares its permission level and its
 *    own input schema, so the permission engine and the LLM tool-schema
 *    generator both read from the same source of truth. There is no second
 *    place where "is this dangerous" is decided.
 * 2. Results are structured. Tools never return bare strings, because the
 *    planner has to reason over them (spec §49).
 * 3. `verify` is part of the contract, not an afterthought. Spec §29 makes
 *    verification mandatory, so the type system makes a tool author confront it:
 *    either supply a verifier or explicitly declare `verification: 'intrinsic'`.
 */

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** Spec §31. Ordered from least to most dangerous. */
export const PERMISSION_LEVELS = ['read', 'write', 'external', 'destructive', 'system'] as const;
export const PermissionLevelSchema = z.enum(PERMISSION_LEVELS);
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

/** Numeric rank so policies can express "at or above this level". */
export const PERMISSION_RANK: Readonly<Record<PermissionLevel, number>> = {
  read: 0,
  write: 1,
  external: 2,
  destructive: 3,
  system: 4,
};

/**
 * Reversibility is orthogonal to permission level and spec §32 keys off it:
 * "MEDIUM RISK → automatic if clearly reversible". A file copy and a file
 * overwrite are both `write`, but only one can be undone.
 */
export const REVERSIBILITY = ['reversible', 'irreversible', 'unknown'] as const;
export const ReversibilitySchema = z.enum(REVERSIBILITY);
export type Reversibility = (typeof REVERSIBILITY)[number];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Machine-readable error taxonomy (spec §50). The planner branches on these
 * codes during recovery, so they are a closed set rather than free text.
 */
export const TOOL_ERROR_CODES = [
  'FILE_NOT_FOUND',
  'PERMISSION_DENIED',
  'APP_NOT_FOUND',
  'WINDOW_NOT_FOUND',
  'ELEMENT_NOT_FOUND',
  'TIMEOUT',
  'CONTACT_AMBIGUOUS',
  'ACTION_BLOCKED',
  'USER_CANCELLED',
  'NETWORK_ERROR',
  'VERIFICATION_FAILED',
  'INVALID_INPUT',
  'TOOL_NOT_FOUND',
  'UNSUPPORTED_PLATFORM',
  'INTERNAL_ERROR',
] as const;
export const ToolErrorCodeSchema = z.enum(TOOL_ERROR_CODES);
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export const ToolErrorSchema = z.object({
  code: ToolErrorCodeSchema,
  message: z.string(),
  /** Whether the planner may attempt recovery, or must surface it to the user. */
  recoverable: z.boolean(),
  /** Optional structured hint the planner can use to re-plan. */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Outcome of the mandatory verification pass (spec §29).
 *
 * `unverified` exists deliberately. Development rule 25 forbids claiming
 * success without verification, so a tool that could not be checked must say so
 * rather than quietly reporting success — the UI and the planner both surface
 * this distinctly.
 */
export const VERIFICATION_STATUSES = ['verified', 'failed', 'unverified', 'not-applicable'] as const;
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VerificationSchema = z.object({
  status: VerificationStatusSchema,
  /** Human-readable statement of what was actually checked. */
  detail: z.string(),
  checkedAt: z.string().datetime(),
});
export type Verification = z.infer<typeof VerificationSchema>;

export const ToolResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: ToolErrorSchema.optional(),
  verification: VerificationSchema.optional(),
  metadata: z
    .object({
      durationMs: z.number().optional(),
      tool: z.string().optional(),
      /** True when the executor short-circuited from cache/no-op. */
      noop: z.boolean().optional(),
    })
    .optional(),
});
export type ToolResult<TData = unknown> = Omit<z.infer<typeof ToolResultSchema>, 'data'> & {
  data?: TData;
};

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/** How a tool satisfies spec §29. */
export type VerificationStrategy =
  /** The tool supplies a `verify` function that re-observes real state. */
  | 'explicit'
  /**
   * The tool's own return value IS the observation — a pure read whose result
   * cannot be "wrong" in the way a mutation can. Read-only tools qualify;
   * anything that changes state does not.
   */
  | 'intrinsic';

export interface ToolExecutionContext {
  readonly taskId: string;
  readonly stepId: string;
  /** Rejects/aborts when the user hits emergency stop (spec §33). */
  readonly signal: AbortSignal;
  readonly logger: ToolLogger;
  /** Wall-clock budget for this invocation. */
  readonly timeoutMs: number;
}

/** Narrow logger surface handed to tools; keeps tools decoupled from core. */
export interface ToolLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  /** Namespaced identifier, e.g. `filesystem.copy`. Unique in the registry. */
  readonly name: string;
  /** Written for the LLM, not for humans. Describes when to choose this tool. */
  readonly description: string;
  readonly permission: PermissionLevel;
  readonly reversibility: Reversibility;
  /** Zod schema; doubles as the JSON Schema source for LLM tool definitions. */
  readonly inputSchema: z.ZodType<TInput>;
  readonly verification: VerificationStrategy;
  /** Per-tool override of AGENT_LIMITS.defaultToolTimeoutMs. */
  readonly timeoutMs?: number;
  /**
   * Modes in which this tool is even offered to the planner. Omitted means
   * "available in every mode". Spec §55 gates terminal/code tools behind
   * DEVELOPER; this is how a tool declares that, rather than the orchestrator
   * keeping a hard-coded list of special-case names.
   *
   * Availability is checked BEFORE permission: a tool that is not available in
   * the current mode is never described to the LLM at all, so the model cannot
   * plan around a capability it does not have.
   */
  readonly availableInModes?: readonly AgentMode[];

  execute(input: TInput, ctx: ToolExecutionContext): Promise<ToolResult<TOutput>>;

  /**
   * Re-observe the world and confirm the effect actually happened. Required
   * whenever `verification === 'explicit'`; the registry enforces this at
   * registration time so the invariant cannot be forgotten.
   */
  verify?(
    input: TInput,
    result: ToolResult<TOutput>,
    ctx: ToolExecutionContext,
  ): Promise<Verification>;

  /**
   * Short, human-facing sentence describing the pending effect, shown in the
   * confirmation prompt (spec §95: "This will permanently delete 184 files…").
   */
  describeEffect?(input: TInput): string;
}

/** Registry view of a tool, minus the executable parts. Safe to send to the UI. */
export const ToolDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
  permission: PermissionLevelSchema,
  reversibility: ReversibilitySchema,
  verification: z.enum(['explicit', 'intrinsic']),
  availableInModes: z.array(AgentModeSchema).optional(),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;
