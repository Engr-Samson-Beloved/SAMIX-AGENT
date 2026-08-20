import { z } from 'zod';
import { ToolErrorCodeSchema, type ToolErrorCode } from '@samix/shared';

/**
 * Wire format between the agent core and the Python desktop sidecar (Phase 7 §3).
 *
 * Newline-delimited JSON over the child's stdin/stdout, one frame per line:
 *
 *   -> {"id":"7","op":"snapshot","params":{…}}
 *   <- {"id":"7","ok":true,"data":{…},"ms":180}
 *   <- {"id":"7","ok":false,"error":{"code":"WINDOW_NOT_FOUND",…},"ms":4}
 *
 * The error vocabulary is the core's own `TOOL_ERROR_CODES`, not a private one.
 * A sidecar-specific taxonomy would need a translation table at this boundary,
 * and every entry in such a table is a chance to turn a code the planner knows
 * how to recover from into one it does not.
 *
 * Frames are validated on arrival rather than trusted. The sidecar is a separate
 * process that a user could in principle replace, and a malformed frame should
 * become a clean typed failure rather than an `undefined` propagating into a
 * tool result.
 */

export const SIDECAR_PROTOCOL_VERSION = 1;

export interface SidecarRequest {
  readonly id: string;
  readonly op: string;
  readonly params?: Record<string, unknown>;
}

const SidecarErrorSchema = z.object({
  code: ToolErrorCodeSchema,
  message: z.string(),
  recoverable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const SidecarResponseSchema = z.union([
  z.object({
    id: z.union([z.string(), z.number(), z.null()]),
    ok: z.literal(true),
    data: z.unknown(),
    ms: z.number().optional(),
  }),
  z.object({
    id: z.union([z.string(), z.number(), z.null()]),
    ok: z.literal(false),
    error: SidecarErrorSchema,
    ms: z.number().optional(),
  }),
]);
export type SidecarResponse = z.infer<typeof SidecarResponseSchema>;

/** What the sidecar reports about itself during the handshake. */
export const HandshakeSchema = z.object({
  protocolVersion: z.number().int(),
  pid: z.number().int(),
  python: z.string(),
  architecture: z.string(),
  /** `per-monitor-v2` when correct. Anything else means coordinates may lie. */
  dpiAwareness: z.string(),
  com: z.string(),
  /** False when UI Automation could not be reached — the degradation trigger. */
  uia: z.boolean(),
  uiaDetail: z.string(),
});
export type Handshake = z.infer<typeof HandshakeSchema>;

/** A snapshot, as the sidecar renders it. Mirrors `tree.to_json`. */
export const SnapshotElementSchema = z.object({
  ref: z.number().int().positive(),
  depth: z.number().int().nonnegative(),
  role: z.string(),
  name: z.string(),
  value: z.string().nullable(),
  automationId: z.string(),
  runtimeId: z.string(),
  nativeHandle: z.number().int(),
  /** `[x, y, width, height]` in PHYSICAL pixels, screen coordinates. */
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  enabled: z.boolean(),
  patterns: z.array(z.string()),
  toggle: z.string().nullable(),
});
export type SnapshotElement = z.infer<typeof SnapshotElementSchema>;

export const SnapshotWindowSchema = z.object({
  handle: z.number().int(),
  title: z.string(),
  processName: z.string(),
  processId: z.number().int(),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  isActive: z.boolean().optional(),
  isMinimized: z.boolean().optional(),
  /** Read by the permission engine: an action on one of ours is refused. */
  isOwn: z.boolean().optional(),
});

export const SnapshotSchema = z.object({
  window: SnapshotWindowSchema,
  /** Structure hash. Carried by every action as its stale-ref guard (§4). */
  tree: z.string(),
  /** A truncated snapshot is a legitimate result, never an error (§2). */
  truncated: z.boolean(),
  truncatedReason: z.enum(['depth', 'nodes', 'time', 'cancelled']).nullable(),
  nodeCount: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  elements: z.array(SnapshotElementSchema),
  /** The flat indexed form the planner reads. */
  text: z.string(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** A failure that carries a code the planner can branch on. */
export class SidecarError extends Error {
  readonly code: ToolErrorCode;
  readonly recoverable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ToolErrorCode,
    message: string,
    recoverable = true,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SidecarError';
    this.code = code;
    this.recoverable = recoverable;
    this.details = details;
  }
}

/** Parse one line from the sidecar's stdout. Returns undefined if it is noise. */
export function parseFrame(line: string): SidecarResponse | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const parsed = SidecarResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
