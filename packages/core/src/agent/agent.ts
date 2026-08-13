import {
  err,
  toToolError,
  type AgentMode,
  type AgentState,
  type AgentStatus,
  type AppConfig,
  type ConfirmationRequest,
  type ConfirmationResponse,
  type Task,
  type TaskStep,
} from '@samix/shared';
import type { ConfigStore } from '../config/config-store.js';
import type { EventBus } from '../events/event-bus.js';
import { publish } from '../events/event-bus.js';
import type { Logger } from '../observability/logger.js';
import type { PermissionEngine } from '../security/permissions.js';
import type { ToolRegistry } from '../tools/registry.js';
import { CancellationToken } from './cancellation.js';
import { type StepExecutor } from './executor.js';
import { toTaskSteps, type Planner } from './planner.js';
import { AgentStateMachine } from './state-machine.js';
import { type TaskManager } from './task-manager.js';

/**
 * Agent orchestrator (spec §27, §77, §78).
 *
 * Spec §77 gives the loop as pseudocode and then warns: "Implement a robust
 * state machine rather than an uncontrolled recursive loop." This is that
 * implementation. The differences from the sketch are deliberate:
 *
 *  - **Bounded.** Step count, per-step retries and total wall clock are all
 *    capped (development rule 16). The loop cannot run forever even if a planner
 *    misbehaves.
 *  - **Single-flight.** One task at a time. A second submission while a task is
 *    running is rejected rather than queued — the agent is driving a shared
 *    resource (the user's desktop) and concurrent automation on one machine is a
 *    correctness hazard, not a feature.
 *  - **Verification gates completion.** There is no path from executing to
 *    completed that skips the verifier, in this code or in the state machine.
 *  - **Cancellation is checked at every boundary**, not just at the top.
 */

export interface AgentDeps {
  readonly bus: EventBus;
  readonly config: ConfigStore;
  readonly registry: ToolRegistry;
  readonly permissions: PermissionEngine;
  readonly executor: StepExecutor;
  readonly planner: Planner;
  readonly tasks: TaskManager;
  readonly logger: Logger;
  readonly version: string;
}

export interface SubsystemStatus {
  name: string;
  status: 'ready' | 'unavailable' | 'error' | 'not-implemented';
  detail?: string;
}

export class Agent {
  private readonly machine = new AgentStateMachine('idle');
  private readonly startedAt = new Date().toISOString();
  private readonly subsystems = new Map<string, SubsystemStatus>();

  private token = new CancellationToken();
  private pendingConfirmation:
    | { request: ConfirmationRequest; resolve: (approved: boolean) => void }
    | undefined;
  /** Set when the user approves the remainder of the current task. */
  private taskApproved = false;
  /** Latched by emergency stop; blocks new work until cleared. */
  private stopped = false;

  private readonly log: Logger;

  constructor(private readonly deps: AgentDeps) {
    this.log = deps.logger.child('agent');

    this.machine.onTransition((from, to) => {
      publish(this.deps.bus, { type: 'agent.state.changed', from, to });
      this.log.debug(`state ${from} → ${to}`);
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    publish(this.deps.bus, { type: 'agent.started', status: this.status() });
    this.log.info('agent started', {
      mode: this.mode,
      planner: this.deps.planner.name,
      tools: this.deps.registry.size,
    });
  }

  setSubsystem(status: SubsystemStatus): void {
    this.subsystems.set(status.name, status);
    publish(this.deps.bus, {
      type: 'agent.subsystem.changed',
      name: status.name,
      status: status.status,
      ...(status.detail ? { detail: status.detail } : {}),
    });
  }

  get state(): AgentState {
    return this.machine.state;
  }

  get mode(): AgentMode {
    return this.deps.config.get().automation.mode;
  }

  status(): AgentStatus {
    const activeTask = this.deps.tasks.activeTask;
    return {
      state: this.machine.state,
      mode: this.mode,
      ...(activeTask ? { currentTask: activeTask } : {}),
      ...(this.pendingConfirmation ? { pendingConfirmation: this.pendingConfirmation.request } : {}),
      ready: [...this.subsystems.values()].every(
        (s) => s.status === 'ready' || s.status === 'not-implemented',
      ),
      subsystems: [...this.subsystems.values()].map((s) => ({
        name: s.name,
        status: s.status,
        ...(s.detail ? { detail: s.detail } : {}),
      })),
      version: this.deps.version,
      startedAt: this.startedAt,
    };
  }

  setMode(mode: AgentMode): AgentStatus {
    // Changing mode mid-task would mean a plan approved under one policy
    // finishing under another. Refuse.
    if (this.deps.tasks.hasActiveTask) {
      throw new Error('Cannot change mode while a task is running. Cancel it first.');
    }
    this.deps.config.update({ automation: { mode } });
    this.log.info('mode changed', { mode });
    return this.status();
  }

  // -------------------------------------------------------------------------
  // Task submission
  // -------------------------------------------------------------------------

  /**
   * Accept an instruction and run it to completion.
   *
   * Returns the task id as soon as the task is created; the caller does not
   * await the run. Everything the UI needs arrives as events, which is what
   * keeps the interface responsive during long automation (spec §76).
   */
  submit(instruction: string, source: Task['source']): { taskId: string } {
    if (this.stopped) {
      throw new Error('Agent is stopped after an emergency stop. Resume it before submitting work.');
    }
    if (this.deps.tasks.hasActiveTask) {
      throw new Error('A task is already running. Cancel it before starting another.');
    }

    const task = this.deps.tasks.create(instruction, source, this.mode);
    this.token = new CancellationToken();
    this.taskApproved = false;

    publish(this.deps.bus, { type: 'task.created', task });
    this.log.info('task created', { taskId: task.id, source, instruction });

    // Fire and forget: `run` owns all its own error handling and always drives
    // the task to a terminal state.
    void this.run(task.id);
    return { taskId: task.id };
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  private async run(taskId: string): Promise<void> {
    const config = this.deps.config.get();
    const deadline = Date.now() + config.automation.taskTimeoutMs;

    try {
      this.machine.transition('understanding');
      this.deps.tasks.setStatus('planning');
      publish(this.deps.bus, { type: 'agent.thinking' });

      // ---- plan ---------------------------------------------------------
      this.machine.transition('planning');
      const plan = await this.deps.planner.plan({
        task: this.requireTask(),
        mode: this.mode,
        availableTools: this.deps.registry.availableIn(this.mode).map((t) => t.name),
        signal: this.token.signal,
      });

      if (plan.kind === 'reply') {
        this.complete(plan.message);
        return;
      }
      if (plan.kind === 'clarify') {
        // Spec §21/§94: stop and ask rather than guess. Phase 3 will resume the
        // task with the user's answer; today it terminates cleanly with the
        // question surfaced as the summary.
        this.complete(plan.question);
        return;
      }
      if (plan.kind === 'give-up') {
        this.fail(err('INTERNAL_ERROR', plan.reason, { recoverable: false }).error!, plan.reason);
        return;
      }
      if (plan.steps.length === 0) {
        this.complete('There was nothing to do.');
        return;
      }
      if (plan.steps.length > config.automation.maxStepsPerTask) {
        const reason = `The plan needs ${plan.steps.length} steps, over the ${config.automation.maxStepsPerTask}-step limit.`;
        this.fail(err('ACTION_BLOCKED', reason, { recoverable: false }).error!, reason);
        return;
      }

      const steps = toTaskSteps(plan.steps);
      this.deps.tasks.setSteps(steps);
      publish(this.deps.bus, { type: 'agent.plan.created', taskId, steps });
      publish(this.deps.bus, { type: 'task.updated', task: this.requireTask() });

      // ---- execute ------------------------------------------------------
      this.deps.tasks.setStatus('executing');

      let guard = 0;
      for (;;) {
        if (++guard > config.automation.maxStepsPerTask * (config.automation.maxStepRetries + 2)) {
          // Belt and braces: the per-step retry cap should make this
          // unreachable, but an unbounded loop next to the user's filesystem
          // deserves a second bound.
          throw new Error('Agent loop exceeded its iteration budget.');
        }
        this.token.throwIfCancelled();
        if (Date.now() > deadline) {
          const reason = `The task exceeded its ${Math.round(config.automation.taskTimeoutMs / 1000)}s time budget.`;
          this.fail(err('TIMEOUT', reason).error!, reason);
          return;
        }

        const step = this.deps.tasks.nextPendingStep();
        if (!step) break;

        const finished = await this.runStep(step, config, taskId);
        if (finished === 'abort') return;
      }

      // ---- verify + report ----------------------------------------------
      this.machine.transition('verifying');
      this.deps.tasks.setStatus('verifying');
      this.complete(this.summarise());
    } catch (cause) {
      if (this.token.cancelled) {
        this.cancelTask(this.token.detail || 'Cancelled.');
        return;
      }
      const error = toToolError(cause);
      this.log.error('task failed with an unhandled error', { taskId, error: error.message });
      this.fail(error, `Something went wrong: ${error.message}`);
    }
  }

  /** Execute one step, applying the retry policy. Returns 'abort' to stop. */
  private async runStep(
    step: TaskStep,
    config: AppConfig,
    taskId: string,
  ): Promise<'continue' | 'abort'> {
    this.machine.transition('executing');
    this.deps.tasks.updateStep(step.id, {
      status: 'running',
      startedAt: new Date().toISOString(),
      attempts: step.attempts + 1,
    });
    publish(this.deps.bus, { type: 'task.updated', task: this.requireTask() });

    const outcome = await this.deps.executor.execute(step, {
      taskId,
      mode: this.mode,
      automation: { alwaysConfirm: config.automation.alwaysConfirm },
      token: this.token,
      taskApproved: this.taskApproved,
    });

    // The executor moves us through observe/verify conceptually; reflect that in
    // the machine so the UI shows what is actually happening.
    if (this.machine.can('observing')) this.machine.transition('observing');
    if (this.machine.can('verifying')) this.machine.transition('verifying');

    this.deps.tasks.updateStep(step.id, {
      status: outcome.status,
      result: outcome.result,
      finishedAt: new Date().toISOString(),
      durationMs: outcome.durationMs,
      ...(outcome.verification ? { verification: outcome.verification } : {}),
      ...(outcome.result.error ? { error: outcome.result.error } : {}),
    });
    publish(this.deps.bus, { type: 'task.updated', task: this.requireTask() });

    if (outcome.status === 'succeeded' || outcome.status === 'succeeded_unverified') {
      return 'continue';
    }

    if (outcome.status === 'cancelled') {
      this.cancelTask(outcome.result.error?.message ?? 'Cancelled.');
      return 'abort';
    }

    // ---- recovery (spec §30) ---------------------------------------------
    const error = outcome.result.error ?? {
      code: 'INTERNAL_ERROR' as const,
      message: 'Unknown failure.',
      recoverable: false,
    };
    const attempts = step.attempts + 1;

    if (!error.recoverable || attempts > config.automation.maxStepRetries) {
      this.fail(error, `I could not complete "${step.description}". ${error.message}`);
      return 'abort';
    }

    this.machine.transition('recovering');
    this.deps.tasks.setStatus('recovering');

    const recovery = await this.deps.planner.recover?.({
      task: this.requireTask(),
      mode: this.mode,
      availableTools: this.deps.registry.availableIn(this.mode).map((t) => t.name),
      signal: this.token.signal,
      failedStep: step,
      error,
      attempt: attempts,
    });

    if (!recovery || recovery.kind === 'give-up') {
      const reason =
        recovery?.kind === 'give-up'
          ? recovery.reason
          : `"${step.description}" failed and no recovery is available. ${error.message}`;
      this.fail(error, reason);
      return 'abort';
    }
    if (recovery.kind === 'reply' || recovery.kind === 'clarify') {
      this.complete(recovery.kind === 'reply' ? recovery.message : recovery.question);
      return 'abort';
    }

    // Replace the remaining plan with the recovery steps.
    const replacement = toTaskSteps(recovery.steps, step.index + 1);
    this.deps.tasks.appendSteps(replacement);
    this.deps.tasks.setStatus('executing');
    this.log.info('recovery plan created', { steps: replacement.length });
    return 'continue';
  }

  // -------------------------------------------------------------------------
  // Confirmation
  // -------------------------------------------------------------------------

  /**
   * Gate handed to the executor. Resolves when the user answers.
   *
   * There is intentionally no timeout: spec §94 says the system must pause and
   * wait. The escape hatches are cancellation and emergency stop, both of which
   * reject this promise — so it can never hang unrecoverably.
   */
  readonly confirmationGate = (request: ConfirmationRequest): Promise<boolean> => {
    if (this.pendingConfirmation) {
      return Promise.reject(new Error('A confirmation is already pending.'));
    }
    this.machine.transition('awaiting_confirmation');
    this.deps.tasks.setStatus('awaiting_confirmation');
    publish(this.deps.bus, { type: 'confirmation.required', request });
    this.log.info('waiting for confirmation', { tool: request.tool, effect: request.effect });

    return new Promise<boolean>((resolve, reject) => {
      const onAbort = (): void => {
        this.pendingConfirmation = undefined;
        reject(new DOMException('Cancelled while awaiting confirmation', 'AbortError'));
      };
      this.token.signal.addEventListener('abort', onAbort, { once: true });

      this.pendingConfirmation = {
        request,
        resolve: (approved) => {
          this.token.signal.removeEventListener('abort', onAbort);
          this.pendingConfirmation = undefined;
          resolve(approved);
        },
      };
    });
  };

  respondToConfirmation(response: ConfirmationResponse): { accepted: boolean } {
    const pending = this.pendingConfirmation;
    if (!pending || pending.request.id !== response.id) {
      // Stale response — the prompt was already resolved or superseded.
      return { accepted: false };
    }
    if (response.approved && response.approveRemainingInTask) {
      this.taskApproved = true;
    }
    publish(this.deps.bus, {
      type: 'confirmation.resolved',
      id: response.id,
      approved: response.approved,
    });

    // Leave the waiting state before handing control back to the executor.
    // Without this the machine stays in `awaiting_confirmation` for the rest of
    // the step, and the loop's later move to `verifying` is an illegal edge.
    if (response.approved && this.machine.state === 'awaiting_confirmation') {
      this.machine.transition('executing');
      this.deps.tasks.setStatus('executing');
    }

    pending.resolve(response.approved);
    return { accepted: true };
  }

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  cancel(reason = 'user requested'): { cancelled: boolean; taskId?: string } {
    const task = this.deps.tasks.activeTask;
    if (!task || !this.deps.tasks.hasActiveTask) return { cancelled: false };
    this.token.cancel('user', reason);
    // Reject any in-flight confirmation so the loop unwinds immediately rather
    // than waiting for an answer that is no longer wanted.
    this.pendingConfirmation = undefined;
    this.log.info('cancellation requested', { taskId: task.id, reason });
    return { cancelled: true, taskId: task.id };
  }

  /**
   * Emergency stop (spec §33).
   *
   * Stronger than cancel: it also latches the agent closed so no further work
   * starts until `resume()`. Phase 7 adds the release of synthetic mouse and
   * keyboard state here — the hook is `releaseInputControl`, wired when those
   * tools exist.
   */
  emergencyStop(): { stopped: boolean; cancelledTaskId?: string } {
    const task = this.deps.tasks.activeTask;
    this.stopped = true;
    this.token.cancel('emergency-stop', 'Emergency stop');
    this.pendingConfirmation = undefined;

    if (this.deps.tasks.hasActiveTask && task) {
      this.machine.forceTerminal('cancelled');
      this.deps.tasks.setStatus('cancelled', { summary: 'Stopped by emergency stop.' });
      publish(this.deps.bus, { type: 'task.cancelled', taskId: task.id, reason: 'emergency stop' });
      this.machine.reset();
      this.deps.tasks.clearCurrent();
      this.log.warn('emergency stop', { taskId: task.id });
      return { stopped: true, cancelledTaskId: task.id };
    }

    this.machine.reset();
    this.log.warn('emergency stop with no active task');
    return { stopped: true };
  }

  resume(): void {
    this.stopped = false;
    this.log.info('agent resumed after emergency stop');
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  // -------------------------------------------------------------------------
  // Terminal transitions
  // -------------------------------------------------------------------------

  private complete(summary: string): void {
    const task = this.requireTask();
    if (this.machine.can('completed')) this.machine.transition('completed');
    else this.machine.forceTerminal('failed');

    this.deps.tasks.setStatus('completed', { summary });
    publish(this.deps.bus, { type: 'task.completed', taskId: task.id, summary });
    publish(this.deps.bus, { type: 'task.updated', task: this.requireTaskOr(task) });
    this.log.info('task completed', { taskId: task.id, summary });
    this.settle();
  }

  private fail(error: NonNullable<ReturnType<typeof toToolError>>, summary: string): void {
    const task = this.requireTask();
    this.machine.forceTerminal('failed');
    this.deps.tasks.setStatus('failed', { summary, error });
    publish(this.deps.bus, { type: 'task.failed', taskId: task.id, error, summary });
    this.log.warn('task failed', { taskId: task.id, code: error.code, summary });
    this.settle();
  }

  private cancelTask(reason: string): void {
    const task = this.deps.tasks.activeTask;
    if (!task) return;
    this.machine.forceTerminal('cancelled');
    this.deps.tasks.setStatus('cancelled', { summary: reason });
    publish(this.deps.bus, { type: 'task.cancelled', taskId: task.id, reason });
    this.log.info('task cancelled', { taskId: task.id, reason });
    this.settle();
  }

  /** Return to rest so the next instruction can be accepted. */
  private settle(): void {
    this.machine.reset();
    this.deps.tasks.clearCurrent();
  }

  /**
   * Build the sentence the user hears.
   *
   * Development rule 25 and spec §93 are the whole design of this method: it
   * reports what was verified, and says so explicitly when something completed
   * but could not be confirmed. It never rounds "probably worked" up to "done".
   */
  private summarise(): string {
    const { unverified, failed } = this.deps.tasks.outcome();
    const task = this.requireTask();
    const done = task.steps.filter(
      (s) => s.status === 'succeeded' || s.status === 'succeeded_unverified',
    ).length;

    // Order matters: the failure and unverified cases are checked BEFORE the
    // single-step shortcut. Reversing them would let a one-step task report a
    // confident "Done." for work that was never confirmed, which is exactly the
    // claim development rule 25 forbids.
    if (failed > 0) {
      return `I completed ${done} of ${task.steps.length} steps; ${failed} failed.`;
    }
    if (unverified > 0) {
      const noun = unverified === 1 ? 'it' : `${unverified} of them`;
      return `I completed ${done} step${done === 1 ? '' : 's'}, but could not confirm ${noun}. I have not assumed that succeeded.`;
    }

    // A single verified step: answer with its result rather than narrating.
    if (task.steps.length === 1 && done === 1) {
      return `Done. ${task.steps[0]!.description}.`;
    }
    return `Done. I completed and verified all ${done} steps.`;
  }

  private requireTask(): Task {
    const task = this.deps.tasks.activeTask;
    if (!task) throw new Error('No active task');
    return task;
  }

  private requireTaskOr(fallback: Task): Task {
    return this.deps.tasks.activeTask ?? fallback;
  }
}
