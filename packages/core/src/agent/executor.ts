import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AGENT_LIMITS,
  err,
  toToolError,
  verification as makeVerification,
  type AgentMode,
  type AutomationConfig,
  type ConfirmationRequest,
  type TaskStep,
  type ToolResult,
  type Verification,
} from '@samix/shared';
import type { EventBus } from '../events/event-bus.js';
import { publish } from '../events/event-bus.js';
import type { AuditTrail } from '../observability/audit.js';
import type { Logger } from '../observability/logger.js';
import type { PermissionEngine } from '../security/permissions.js';
import type { ToolRegistry } from '../tools/registry.js';
import { withTimeout, type CancellationToken } from './cancellation.js';

/**
 * Step executor — the single path from "the planner wants this" to "this
 * happened to the user's computer".
 *
 * The ordering of the pipeline is the safety design, and every stage is
 * mandatory:
 *
 *    resolve tool → validate input → permission decision → [confirm] →
 *    execute with timeout → verify → audit → emit
 *
 * Notably:
 *  - Input is validated with the tool's own Zod schema BEFORE the permission
 *    check, so a policy decision is never made about a malformed request whose
 *    real effect nobody can predict (spec §73).
 *  - Verification runs even when the tool reports failure, because "the tool
 *    said it failed" and "nothing changed" are different claims, and a partially
 *    applied failure is exactly the case a user needs told about.
 *  - An audit record is written for every outcome including blocked and
 *    cancelled ones (spec §37).
 */

export type ConfirmationGate = (request: ConfirmationRequest) => Promise<boolean>;

export interface ExecutorDeps {
  readonly registry: ToolRegistry;
  readonly permissions: PermissionEngine;
  readonly bus: EventBus;
  readonly audit: AuditTrail;
  readonly logger: Logger;
  readonly requestConfirmation: ConfirmationGate;
}

export interface ExecuteStepContext {
  readonly taskId: string;
  readonly mode: AgentMode;
  readonly automation: Pick<AutomationConfig, 'alwaysConfirm'>;
  readonly token: CancellationToken;
  /** True once the user approved the remainder of this task. */
  readonly taskApproved: boolean;
}

export interface StepOutcome {
  readonly status: TaskStep['status'];
  readonly result: ToolResult;
  readonly verification: Verification | undefined;
  readonly durationMs: number;
  /** Set when the user chose "approve the rest of this task". */
  readonly approvedRemaining?: boolean;
}

export class StepExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(step: TaskStep, ctx: ExecuteStepContext): Promise<StepOutcome> {
    const startedAt = Date.now();
    const { registry, permissions, bus, audit, logger } = this.deps;
    const log = logger.child('executor', { taskId: ctx.taskId });

    const finish = (
      status: TaskStep['status'],
      result: ToolResult,
      verification: Verification | undefined,
      auditOutcome: 'success' | 'failure' | 'blocked' | 'cancelled',
      confirmation?: 'approved' | 'denied' | 'not-required',
    ): StepOutcome => {
      const durationMs = Date.now() - startedAt;
      audit.record({
        timestamp: new Date().toISOString(),
        taskId: ctx.taskId,
        stepId: step.id,
        tool: step.tool,
        permission: tool?.permission ?? 'unknown',
        input: step.input,
        outcome: auditOutcome,
        verification: verification?.status ?? 'unverified',
        ...(confirmation ? { confirmation } : {}),
        ...(result.error ? { errorCode: result.error.code } : {}),
        durationMs,
      });
      return { status, result, verification, durationMs };
    };

    // -- 1. Resolve -------------------------------------------------------
    const tool = registry.get(step.tool);
    if (!tool) {
      const result = err('TOOL_NOT_FOUND', `No tool named "${step.tool}" is registered.`, {
        recoverable: false,
      });
      log.error('planner referenced an unknown tool', { tool: step.tool });
      this.emitFailure(ctx.taskId, step, result, Date.now() - startedAt);
      return finish('failed', result, undefined, 'failure');
    }

    // -- 2. Validate input ------------------------------------------------
    const parsed = tool.inputSchema.safeParse(step.input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      const result = err('INVALID_INPUT', `Input rejected by ${tool.name}: ${detail}`, {
        recoverable: false,
        details: { issues: detail },
      });
      log.warn('tool input failed validation', { tool: tool.name, detail });
      this.emitFailure(ctx.taskId, step, result, Date.now() - startedAt);
      return finish('failed', result, undefined, 'failure');
    }
    const input = parsed.data as never;

    // -- 3. Permission ----------------------------------------------------
    const decision = permissions.evaluate({
      tool,
      mode: ctx.mode,
      automation: ctx.automation,
      taskApproved: ctx.taskApproved,
    });

    if (decision.effect === 'deny') {
      const result = err('ACTION_BLOCKED', decision.reason, { recoverable: false });
      log.warn('tool execution blocked by policy', {
        tool: tool.name,
        rule: decision.rule,
        mode: ctx.mode,
      });
      publish(bus, { type: 'permission.denied', tool: tool.name, reason: decision.reason });
      this.emitFailure(ctx.taskId, step, result, Date.now() - startedAt);
      return finish('failed', result, undefined, 'blocked');
    }

    // -- 4. Confirmation --------------------------------------------------
    let confirmationOutcome: 'approved' | 'denied' | 'not-required' = 'not-required';
    if (decision.effect === 'confirm') {
      const request: ConfirmationRequest = {
        id: `cnf_${randomUUID().slice(0, 8)}`,
        taskId: ctx.taskId,
        stepId: step.id,
        tool: tool.name,
        permission: tool.permission,
        effect: tool.describeEffect?.(input) ?? step.description,
        reason: decision.reason,
        facts: buildFacts(step),
        requestedAt: new Date().toISOString(),
      };

      let approved: boolean;
      try {
        approved = await this.deps.requestConfirmation(request);
      } catch (cause) {
        // The gate rejects on cancellation/shutdown. Treat as a refusal — the
        // safe interpretation of "we never got an answer".
        const result: ToolResult = { success: false, error: toToolError(cause, 'USER_CANCELLED') };
        this.emitFailure(ctx.taskId, step, result, Date.now() - startedAt);
        return finish('cancelled', result, undefined, 'cancelled', 'denied');
      }

      confirmationOutcome = approved ? 'approved' : 'denied';
      if (!approved) {
        const result = err('USER_CANCELLED', 'You declined this action.', { recoverable: false });
        log.info('user declined confirmation', { tool: tool.name });
        this.emitFailure(ctx.taskId, step, result, Date.now() - startedAt);
        return finish('cancelled', result, undefined, 'cancelled', 'denied');
      }
    }

    // -- 5. Execute -------------------------------------------------------
    if (ctx.token.cancelled) {
      const result = err('USER_CANCELLED', 'Cancelled before this step started.', {
        recoverable: false,
      });
      return finish('cancelled', result, undefined, 'cancelled', confirmationOutcome);
    }

    publish(this.deps.bus, {
      type: 'tool.started',
      taskId: ctx.taskId,
      stepId: step.id,
      tool: tool.name,
      input: step.input,
    });
    log.info(`tool: ${tool.name}`, { step: step.description });

    const timeoutMs = tool.timeoutMs ?? AGENT_LIMITS.defaultToolTimeoutMs;
    let result: ToolResult;
    try {
      result = await withTimeout(
        (signal) =>
          tool.execute(input, {
            taskId: ctx.taskId,
            stepId: step.id,
            signal,
            logger: log.child(tool.name),
            timeoutMs,
          }),
        timeoutMs,
        ctx.token,
        tool.name,
      );
    } catch (cause) {
      const error = toToolError(cause);
      result = { success: false, error };
    }

    // A tool that returns a malformed result is a bug in the tool, not a reason
    // to crash the agent. Coerce and report.
    if (typeof result !== 'object' || result === null || typeof result.success !== 'boolean') {
      result = err('INTERNAL_ERROR', `${tool.name} returned a malformed ToolResult.`, {
        recoverable: false,
      });
    }

    const durationMs = Date.now() - startedAt;
    result = { ...result, metadata: { ...result.metadata, durationMs, tool: tool.name } };

    // -- 6. Verify (spec §29 — mandatory, never skipped) ------------------
    const verification = await this.verify(tool, input, result, ctx, step, timeoutMs, log);

    if (result.success) {
      publish(this.deps.bus, {
        type: 'tool.completed',
        taskId: ctx.taskId,
        stepId: step.id,
        tool: tool.name,
        result,
        durationMs,
      });
      publish(this.deps.bus, {
        type: 'tool.verified',
        taskId: ctx.taskId,
        stepId: step.id,
        tool: tool.name,
        verification,
      });

      if (verification.status === 'failed') {
        // The tool claimed success; the world disagrees. The world wins.
        const failed = err('VERIFICATION_FAILED', verification.detail, { recoverable: true });
        log.warn('tool reported success but verification failed', {
          tool: tool.name,
          detail: verification.detail,
        });
        return finish('failed', failed, verification, 'failure', confirmationOutcome);
      }

      const status: TaskStep['status'] =
        verification.status === 'unverified' ? 'succeeded_unverified' : 'succeeded';
      return finish(status, result, verification, 'success', confirmationOutcome);
    }

    this.emitFailure(ctx.taskId, step, result, durationMs);
    const cancelled = result.error?.code === 'USER_CANCELLED';
    return finish(
      cancelled ? 'cancelled' : 'failed',
      result,
      verification,
      cancelled ? 'cancelled' : 'failure',
      confirmationOutcome,
    );
  }

  /**
   * Run the tool's verifier, or classify why verification did not happen.
   *
   * A verifier that throws yields `unverified`, never `verified`. The whole
   * point is that we do not claim success we could not confirm.
   */
  private async verify(
    tool: NonNullable<ReturnType<ToolRegistry['get']>>,
    input: never,
    result: ToolResult,
    ctx: ExecuteStepContext,
    step: TaskStep,
    timeoutMs: number,
    log: Logger,
  ): Promise<Verification> {
    if (tool.verification === 'intrinsic') {
      return makeVerification(
        result.success ? 'not-applicable' : 'not-applicable',
        'Read-only tool: the returned value is itself the observation.',
      );
    }
    if (!tool.verify) {
      // Registry guarantees this cannot happen; defend anyway rather than
      // silently upgrading to "verified".
      return makeVerification('unverified', 'Tool declares explicit verification but has no verifier.');
    }
    if (ctx.token.cancelled) {
      return makeVerification('unverified', 'Cancelled before verification could run.');
    }

    try {
      return await withTimeout(
        (signal) =>
          tool.verify!(input, result, {
            taskId: ctx.taskId,
            stepId: step.id,
            signal,
            logger: log.child(`${tool.name}.verify`),
            timeoutMs,
          }),
        timeoutMs,
        ctx.token,
        `${tool.name} verification`,
      );
    } catch (cause) {
      const error = toToolError(cause);
      log.warn('verification could not complete', { tool: tool.name, code: error.code });
      return makeVerification('unverified', `Verification could not complete: ${error.message}`);
    }
  }

  private emitFailure(taskId: string, step: TaskStep, result: ToolResult, durationMs: number): void {
    publish(this.deps.bus, {
      type: 'tool.failed',
      taskId,
      stepId: step.id,
      tool: step.tool,
      error: result.error ?? {
        code: 'INTERNAL_ERROR',
        message: 'Tool failed without an error object.',
        recoverable: false,
      },
      durationMs,
    });
  }
}

/**
 * Surface scalar input fields in the confirmation prompt so the user can see
 * exactly what is about to happen (spec §95) rather than approving blind.
 * Only top-level scalars: nested structures would make the prompt unreadable.
 */
function buildFacts(step: TaskStep): Array<{ label: string; value: string }> {
  if (typeof step.input !== 'object' || step.input === null) return [];
  const facts: Array<{ label: string; value: string }> = [];
  for (const [key, value] of Object.entries(step.input as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    facts.push({ label: key, value: String(value) });
    if (facts.length >= 6) break;
  }
  return facts;
}

/** Re-exported so tools can be written without importing zod directly. */
export { z };
