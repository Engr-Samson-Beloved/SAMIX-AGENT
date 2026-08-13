import { z } from 'zod';

/** Observability types (spec §37, §92). */

/**
 * `audit` is a peer of the diagnostic levels, not the top of the severity
 * ladder. Spec §37 lists it alongside debug/info/warn/error, and audit records
 * must survive any level filter — an operator raising the log level to `error`
 * must not thereby stop recording what the agent did to their machine.
 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'audit'] as const;
export const LogLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Severity ranking for the diagnostic levels only. */
export const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  /**
   * Deliberately below `debug`: the writer treats audit as always-on and
   * bypasses threshold comparison, so this rank is never used to suppress.
   */
  audit: 0,
};

export const LogEntrySchema = z.object({
  timestamp: z.string().datetime(),
  level: LogLevelSchema,
  /** Emitting subsystem, e.g. `agent`, `tools.filesystem`, `config`. */
  scope: z.string(),
  message: z.string(),
  /** Structured, already-redacted context. Never contains secrets. */
  fields: z.record(z.string(), z.unknown()).optional(),
  taskId: z.string().optional(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

/**
 * Audit record for a single tool execution (spec §37 example shape).
 * Written to a dedicated append-only file, separate from diagnostics.
 */
export const AuditRecordSchema = z.object({
  timestamp: z.string().datetime(),
  taskId: z.string(),
  stepId: z.string(),
  tool: z.string(),
  permission: z.string(),
  /** Redacted tool input. */
  input: z.unknown(),
  outcome: z.enum(['success', 'failure', 'blocked', 'cancelled']),
  verification: z.enum(['verified', 'failed', 'unverified', 'not-applicable']),
  /** Present when policy demanded a prompt: whether the user approved. */
  confirmation: z.enum(['approved', 'denied', 'not-required']).optional(),
  errorCode: z.string().optional(),
  durationMs: z.number(),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
