import { z } from 'zod';
import { AgentEventSchema } from './events.js';
import { AgentStatusSchema, ConfirmationResponseSchema, TaskSchema } from './types/agent.js';
import { AgentModeSchema } from './types/mode.js';
import { AppConfigPatchSchema, AppConfigSchema } from './types/config.js';
import { LogEntrySchema, LogLevelSchema } from './types/log.js';
import { ToolDescriptorSchema, ToolErrorCodeSchema } from './types/tool.js';

/**
 * Sidecar IPC protocol (spec §75; see docs/ADR-0003-ipc-protocol.md).
 *
 * Two rules make this safe, and they are the whole point of the design:
 *
 *  1. **Closed method set.** The webview can only invoke the methods named in
 *     `IpcRequestSchema`. There is deliberately no `exec`, no `runCommand`, no
 *     `invokeTool(name, args)` passthrough. Spec §75 and development rule 10
 *     forbid a generic native escape hatch, and the type system is where that
 *     is enforced rather than in a code review checklist.
 *
 *  2. **Validate at the boundary.** Both ends parse with these schemas before
 *     acting. A malformed or hostile frame is rejected as data, never trusted
 *     because of where it came from.
 *
 * Note that tool invocation is NOT an IPC method. The UI submits an
 * *instruction*; only the planner inside the sidecar decides which tools run.
 * That keeps the permission engine on the single unavoidable path.
 */

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const IpcRequestSchema = z.discriminatedUnion('method', [
  /** Protocol/version negotiation; first frame the host sends. */
  z.object({ method: z.literal('handshake'), params: z.object({ protocolVersion: z.number() }) }),

  z.object({ method: z.literal('status.get'), params: z.object({}).default({}) }),

  z.object({ method: z.literal('config.get'), params: z.object({}).default({}) }),
  z.object({ method: z.literal('config.update'), params: AppConfigPatchSchema }),
  z.object({ method: z.literal('config.reset'), params: z.object({}).default({}) }),

  z.object({ method: z.literal('tools.list'), params: z.object({}).default({}) }),

  z.object({
    method: z.literal('task.submit'),
    params: z.object({
      instruction: z.string().min(1).max(4000),
      source: z.enum(['voice', 'text', 'hotkey', 'schedule']).default('text'),
    }),
  }),
  z.object({
    method: z.literal('task.cancel'),
    params: z.object({ taskId: z.string().optional(), reason: z.string().default('user requested') }),
  }),
  z.object({ method: z.literal('task.get'), params: z.object({ taskId: z.string() }) }),
  z.object({
    method: z.literal('task.history'),
    params: z.object({ limit: z.number().int().positive().max(200).default(20) }),
  }),

  z.object({ method: z.literal('confirmation.respond'), params: ConfirmationResponseSchema }),

  z.object({
    method: z.literal('logs.tail'),
    params: z.object({
      limit: z.number().int().positive().max(1000).default(200),
      minLevel: LogLevelSchema.optional(),
    }),
  }),

  z.object({ method: z.literal('agent.mode.set'), params: z.object({ mode: AgentModeSchema }) }),

  /**
   * Emergency stop (spec §33). Distinct from `task.cancel`: this also releases
   * synthetic input and refuses new work until explicitly resumed.
   */
  z.object({ method: z.literal('agent.emergencyStop'), params: z.object({}).default({}) }),
  z.object({ method: z.literal('agent.shutdown'), params: z.object({}).default({}) }),
]);

export type IpcRequest = z.infer<typeof IpcRequestSchema>;
export type IpcMethod = IpcRequest['method'];
export type ParamsOf<M extends IpcMethod> = Extract<IpcRequest, { method: M }>['params'];

// ---------------------------------------------------------------------------
// Results — one entry per method, keyed so the client is fully typed
// ---------------------------------------------------------------------------

export const IpcResultSchemas = {
  handshake: z.object({ protocolVersion: z.number(), version: z.string(), pid: z.number() }),
  'status.get': AgentStatusSchema,
  'config.get': AppConfigSchema,
  'config.update': AppConfigSchema,
  'config.reset': AppConfigSchema,
  'tools.list': z.array(ToolDescriptorSchema),
  'task.submit': z.object({ taskId: z.string() }),
  'task.cancel': z.object({ cancelled: z.boolean(), taskId: z.string().optional() }),
  'task.get': TaskSchema.nullable(),
  'task.history': z.array(TaskSchema),
  'confirmation.respond': z.object({ accepted: z.boolean() }),
  'logs.tail': z.array(LogEntrySchema),
  'agent.mode.set': AgentStatusSchema,
  'agent.emergencyStop': z.object({ stopped: z.boolean(), cancelledTaskId: z.string().optional() }),
  'agent.shutdown': z.object({ acknowledged: z.boolean() }),
} as const satisfies Record<IpcMethod, z.ZodType>;

export type IpcResultMap = {
  [M in IpcMethod]: z.infer<(typeof IpcResultSchemas)[M]>;
};
export type ResultOf<M extends IpcMethod> = IpcResultMap[M];

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export const IpcErrorSchema = z.object({
  code: ToolErrorCodeSchema,
  message: z.string(),
});
export type IpcError = z.infer<typeof IpcErrorSchema>;

export const IpcRequestFrameSchema = z.object({
  kind: z.literal('request'),
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
});
export type IpcRequestFrame = z.infer<typeof IpcRequestFrameSchema>;

export const IpcResponseFrameSchema = z.union([
  z.object({ kind: z.literal('response'), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ kind: z.literal('response'), id: z.string(), ok: z.literal(false), error: IpcErrorSchema }),
]);
export type IpcResponseFrame = z.infer<typeof IpcResponseFrameSchema>;

export const IpcEventFrameSchema = z.object({
  kind: z.literal('event'),
  event: AgentEventSchema,
});
export type IpcEventFrame = z.infer<typeof IpcEventFrameSchema>;

/** Anything that may arrive from the sidecar. */
export const IpcOutboundFrameSchema = z.union([IpcResponseFrameSchema, IpcEventFrameSchema]);
export type IpcOutboundFrame = z.infer<typeof IpcOutboundFrameSchema>;

/** Anything that may arrive at the sidecar. */
export const IpcInboundFrameSchema = IpcRequestFrameSchema;
export type IpcInboundFrame = z.infer<typeof IpcInboundFrameSchema>;

/**
 * Parse a request frame's params against the schema for its method.
 * Returns a discriminated result rather than throwing, because the transport
 * must answer a bad frame with an error response instead of dying.
 */
export function parseRequest(
  frame: IpcRequestFrame,
): { ok: true; request: IpcRequest } | { ok: false; error: IpcError } {
  const parsed = IpcRequestSchema.safeParse({ method: frame.method, params: frame.params });
  if (!parsed.success) {
    const known = IpcRequestSchema.options.some((o) => o.shape.method.value === frame.method);
    return {
      ok: false,
      error: {
        code: known ? 'INVALID_INPUT' : 'TOOL_NOT_FOUND',
        message: known
          ? `Invalid params for "${frame.method}": ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`
          : `Unknown IPC method "${frame.method}"`,
      },
    };
  }
  return { ok: true, request: parsed.data };
}
