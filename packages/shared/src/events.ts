import { z } from 'zod';
import {
  AgentStateSchema,
  AgentStatusSchema,
  ConfirmationRequestSchema,
  TaskSchema,
  TaskStepSchema,
} from './types/agent.js';
import { LogEntrySchema } from './types/log.js';
import { ToolErrorSchema, ToolResultSchema, VerificationSchema } from './types/tool.js';

/**
 * Internal event bus + UI event contract (spec §46).
 *
 * One discriminated union covers both. The bus is the single mechanism by which
 * subsystems observe each other, which keeps the orchestrator from acquiring
 * direct references to the UI, the logger or the transport. The frontend
 * subscribes to the same union over IPC and switches exhaustively on `type`.
 *
 * Rule: events are facts about the past ("tool.completed"), never commands.
 * Anything that asks for an action is a request in ipc.ts instead.
 */

const base = { at: z.string().datetime() };

export const AgentEventSchema = z.discriminatedUnion('type', [
  // ---- lifecycle -------------------------------------------------------
  z.object({ ...base, type: z.literal('agent.started'), status: AgentStatusSchema }),
  z.object({ ...base, type: z.literal('agent.stopping'), reason: z.string() }),
  z.object({
    ...base,
    type: z.literal('agent.state.changed'),
    from: AgentStateSchema,
    to: AgentStateSchema,
  }),
  z.object({
    ...base,
    type: z.literal('agent.subsystem.changed'),
    name: z.string(),
    status: z.enum(['ready', 'unavailable', 'error', 'not-implemented']),
    detail: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal('agent.error'), error: ToolErrorSchema }),

  // ---- voice (Phase 2 emits these; declared now so the UI is ready) -----
  z.object({ ...base, type: z.literal('agent.listening') }),
  z.object({ ...base, type: z.literal('agent.transcription.started') }),
  z.object({
    ...base,
    type: z.literal('agent.transcription.partial'),
    text: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('agent.transcription.completed'),
    text: z.string(),
    durationMs: z.number(),
  }),

  // ---- reasoning -------------------------------------------------------
  z.object({ ...base, type: z.literal('agent.thinking'), note: z.string().optional() }),
  z.object({
    ...base,
    type: z.literal('agent.plan.created'),
    taskId: z.string(),
    steps: z.array(TaskStepSchema),
  }),

  // ---- task ------------------------------------------------------------
  z.object({ ...base, type: z.literal('task.created'), task: TaskSchema }),
  z.object({ ...base, type: z.literal('task.updated'), task: TaskSchema }),
  z.object({
    ...base,
    type: z.literal('task.completed'),
    taskId: z.string(),
    summary: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('task.failed'),
    taskId: z.string(),
    error: ToolErrorSchema,
    summary: z.string(),
  }),
  z.object({ ...base, type: z.literal('task.cancelled'), taskId: z.string(), reason: z.string() }),

  // ---- tools -----------------------------------------------------------
  z.object({
    ...base,
    type: z.literal('tool.started'),
    taskId: z.string(),
    stepId: z.string(),
    tool: z.string(),
    /** Redacted. */
    input: z.unknown(),
  }),
  z.object({
    ...base,
    type: z.literal('tool.completed'),
    taskId: z.string(),
    stepId: z.string(),
    tool: z.string(),
    result: ToolResultSchema,
    durationMs: z.number(),
  }),
  z.object({
    ...base,
    type: z.literal('tool.failed'),
    taskId: z.string(),
    stepId: z.string(),
    tool: z.string(),
    error: ToolErrorSchema,
    durationMs: z.number(),
  }),
  z.object({
    ...base,
    type: z.literal('tool.verified'),
    taskId: z.string(),
    stepId: z.string(),
    tool: z.string(),
    verification: VerificationSchema,
  }),

  // ---- permissions -----------------------------------------------------
  z.object({
    ...base,
    type: z.literal('permission.denied'),
    tool: z.string(),
    reason: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('confirmation.required'),
    request: ConfirmationRequestSchema,
  }),
  z.object({
    ...base,
    type: z.literal('confirmation.resolved'),
    id: z.string(),
    approved: z.boolean(),
  }),

  // ---- observability ---------------------------------------------------
  z.object({ ...base, type: z.literal('log'), entry: LogEntrySchema }),
  z.object({ ...base, type: z.literal('config.changed') }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventType = AgentEvent['type'];

/** Narrow an event to one variant, e.g. `EventOf<'tool.completed'>`. */
export type EventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;

/** All event type strings, useful for wildcard subscription and tests. */
export const AGENT_EVENT_TYPES = AgentEventSchema.options.map(
  (o) => o.shape.type.value,
) as AgentEventType[];

/** Re-export for symmetry with the schema import above. */
export { ToolResultSchema };
