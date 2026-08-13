import { z } from 'zod';
import { AgentModeSchema } from './mode.js';
import { PermissionLevelSchema, ToolErrorSchema, ToolResultSchema, VerificationSchema } from './tool.js';

/**
 * Agent state, mode and task types (spec §27, §28, §55).
 *
 * The state list is the spec's verbatim set. It is wider than Phase 1 strictly
 * needs — LISTENING/TRANSCRIBING land in Phase 2 — but the transition table is
 * declared once here so later phases add edges rather than redefining the
 * machine.
 */

// ---------------------------------------------------------------------------
// Agent state machine
// ---------------------------------------------------------------------------

export const AGENT_STATES = [
  'idle',
  'listening',
  'transcribing',
  'understanding',
  'planning',
  'awaiting_confirmation',
  'executing',
  'observing',
  'verifying',
  'recovering',
  'completed',
  'failed',
  'cancelled',
] as const;
export const AgentStateSchema = z.enum(AGENT_STATES);
export type AgentState = (typeof AGENT_STATES)[number];

/** States from which no further transition occurs except back to `idle`. */
export const TERMINAL_STATES = ['completed', 'failed', 'cancelled'] as const satisfies readonly AgentState[];
export type TerminalState = (typeof TERMINAL_STATES)[number];

// ---------------------------------------------------------------------------
// Tasks and steps (spec §28)
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  'pending',
  'planning',
  'awaiting_confirmation',
  'executing',
  'verifying',
  'recovering',
  'completed',
  'failed',
  'cancelled',
  /** Process died mid-task; recovered on next launch (spec §67). */
  'interrupted',
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STEP_STATUSES = [
  'pending',
  'awaiting_confirmation',
  'running',
  'verifying',
  'succeeded',
  /** Executed and reported success, but verification could not confirm it. */
  'succeeded_unverified',
  'failed',
  'skipped',
  'cancelled',
] as const;
export const StepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = (typeof STEP_STATUSES)[number];

export const TaskStepSchema = z.object({
  id: z.string(),
  /** 1-based position in the plan, for display. */
  index: z.number().int().nonnegative(),
  /** Human-readable intent, e.g. "Search Downloads for recent PDFs". */
  description: z.string(),
  tool: z.string(),
  input: z.unknown(),
  status: StepStatusSchema,
  result: ToolResultSchema.optional(),
  verification: VerificationSchema.optional(),
  error: ToolErrorSchema.optional(),
  attempts: z.number().int().nonnegative().default(0),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  durationMs: z.number().optional(),
});
export type TaskStep = z.infer<typeof TaskStepSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  /** The user's original words, untouched. Never overwritten by paraphrase. */
  instruction: z.string(),
  /** How the instruction arrived. */
  source: z.enum(['voice', 'text', 'hotkey', 'schedule']),
  status: TaskStatusSchema,
  mode: AgentModeSchema,
  steps: z.array(TaskStepSchema),
  /** Final sentence reported to the user. Set on terminal transition only. */
  summary: z.string().optional(),
  error: ToolErrorSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

// ---------------------------------------------------------------------------
// Confirmation requests (spec §32, §95)
// ---------------------------------------------------------------------------

export const ConfirmationRequestSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  stepId: z.string(),
  tool: z.string(),
  permission: PermissionLevelSchema,
  /** Plain-language description of the pending effect. */
  effect: z.string(),
  /** Why policy demanded confirmation — shown so the user can trust the prompt. */
  reason: z.string(),
  /** Extra facts worth seeing before approving (paths, counts, recipient). */
  facts: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
  requestedAt: z.string().datetime(),
});
export type ConfirmationRequest = z.infer<typeof ConfirmationRequestSchema>;

export const ConfirmationResponseSchema = z.object({
  id: z.string(),
  approved: z.boolean(),
  /**
   * Approve every remaining step of THIS task only. Never persists across
   * tasks — a blanket "always allow" belongs in settings, not in a prompt.
   */
  approveRemainingInTask: z.boolean().default(false),
});
export type ConfirmationResponse = z.infer<typeof ConfirmationResponseSchema>;

// ---------------------------------------------------------------------------
// Runtime status snapshot (what the UI renders)
// ---------------------------------------------------------------------------

export const AgentStatusSchema = z.object({
  state: AgentStateSchema,
  mode: AgentModeSchema,
  currentTask: TaskSchema.optional(),
  pendingConfirmation: ConfirmationRequestSchema.optional(),
  /** False until every subsystem has reported ready (spec §2 launch sequence). */
  ready: z.boolean(),
  /** Per-subsystem readiness, so the UI can show what is missing and why. */
  subsystems: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['ready', 'unavailable', 'error', 'not-implemented']),
      detail: z.string().optional(),
    }),
  ),
  version: z.string(),
  startedAt: z.string().datetime(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
