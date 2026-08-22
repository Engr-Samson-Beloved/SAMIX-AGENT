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
import { classifyResponse } from './affirmative.js';
import { CancellationToken } from './cancellation.js';
import { AgentContext } from './context.js';
import { createActionBudget, type ActionBudget, type StepExecutor } from './executor.js';
import { toTaskSteps, type ConversationTurn, type PlanResult, type Planner } from './planner.js';
import { AgentStateMachine } from './state-machine.js';
import { type TaskManager } from './task-manager.js';

/**
 * How many completed exchanges the planner is shown.
 *
 * Six covers the follow-ups people actually make ("do that then", "close it",
 * "the other one") without letting a long session push the request towards the
 * context budget. Real conversation memory with summarisation is Phase 9.
 */
const CONVERSATION_TURNS = 6;

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
  /**
   * Conversational memory that spans tasks (spec §80). Optional so existing
   * callers and tests keep working; one is created if none is supplied.
   */
  readonly context?: AgentContext;
  /**
   * Release synthetic mouse and keyboard state (Phase 7 §5). Absent when no
   * desktop sidecar is running — nothing was ever pressed on its behalf, so
   * there is nothing to release. See `Agent.emergencyStop()`.
   */
  readonly releaseInputControl?: () => void;
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
  /** Phase 7 §5: recreated per task from `automation.desktop.maxActionsPerTask`. */
  private actionBudget: ActionBudget = createActionBudget(0);

  private readonly log: Logger;
  private readonly context: AgentContext;

  constructor(private readonly deps: AgentDeps) {
    this.log = deps.logger.child('agent');
    this.context = deps.context ?? new AgentContext();

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
    this.actionBudget = createActionBudget(
      this.deps.config.get().automation.desktop.maxActionsPerTask,
    );

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
      // The note is what the UI shows while nothing else is happening. Planning
      // against a language model takes seconds, and a silent prompt during them
      // is indistinguishable from a hung agent — so each phase says what it is
      // waiting for. These are statements of what the agent is doing, never a
      // narration of what a model is "thinking": the model's reasoning is not
      // available here, and inventing a plausible one would be a lie told in the
      // one place the user is watching most closely.
      publish(this.deps.bus, {
        type: 'agent.thinking',
        note: `working out what to do — ${this.deps.planner.name}`,
      });

      // ---- plan ---------------------------------------------------------
      this.machine.transition('planning');
      const plan = await this.decide();

      if (plan.kind === 'reply') {
        this.complete(plan.message);
        return;
      }
      if (plan.kind === 'propose') {
        // Said, not done. The structured call is kept so that "yes, do that" on
        // the next turn runs exactly this, rather than something re-derived from
        // the sentence the user was shown.
        this.context.propose({
          tool: plan.step.tool,
          input: plan.step.input,
          offer: plan.message,
          description: plan.step.description,
          taskId,
        });
        this.log.info('offered an action without running it', { tool: plan.step.tool });
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

      // ---- execute, then observe and ask whether more is needed ---------
      //
      // `plan()` was one blind turn: the model committed to concrete tool
      // arguments before anything had run, so it could not correctly call a
      // tool whose input only exists once a prior step has produced it — an
      // element's `ref` and `tree` hash, an id from a search. A capable model
      // recognises this and rightly plans only as far as it can justify.
      //
      // So once a batch of steps has all succeeded, the loop goes back to the
      // planner with their real results attached (`Planner.continue`) and asks
      // whether the task is actually finished. This is what turns "one blind
      // batch" into a real observe-then-act loop, bounded on two independent
      // axes: total steps across every round (`maxStepsPerTask`, unchanged)
      // and the number of rounds themselves (`maxContinuationRounds`), which
      // is what actually limits LLM round-trips.
      this.deps.tasks.setStatus('executing');

      let guard = 0;
      roundLoop: for (let round = 0; ; round++) {
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

        // Every step so far succeeded (a failure would have returned 'abort'
        // above). Stop asking once a bound is hit, or when this planner has no
        // opinion at all (the deterministic fallback) — either way, whatever
        // already succeeded stands and moves on to the report below.
        if (round + 1 >= config.automation.maxContinuationRounds) break roundLoop;
        if (!this.deps.planner.continue) break roundLoop;

        this.token.throwIfCancelled();
        publish(this.deps.bus, {
          type: 'agent.thinking',
          note: 'checking whether the task actually needs anything else',
        });

        const completedSteps = this.requireTask().steps;
        const continuation = await this.deps.planner.continue({
          task: this.requireTask(),
          mode: this.mode,
          availableTools: this.deps.registry.availableIn(this.mode).map((t) => t.name),
          history: this.conversation(),
          referents: this.context.referents,
          signal: this.token.signal,
          completedSteps,
        });

        if (continuation.kind === 'clarify') {
          this.complete(continuation.question);
          return;
        }
        if (continuation.kind === 'propose') {
          this.context.propose({
            tool: continuation.step.tool,
            input: continuation.step.input,
            offer: continuation.message,
            description: continuation.step.description,
            taskId,
          });
          this.complete(continuation.message);
          return;
        }
        if (continuation.kind !== 'steps' || continuation.steps.length === 0) {
          // 'reply' or 'give-up': the planner has nothing more to add. Nothing
          // that already succeeded is undone by that — go straight to the
          // report below, exactly as if this had been the whole plan.
          break roundLoop;
        }

        const nextTotal = completedSteps.length + continuation.steps.length;
        if (nextTotal > config.automation.maxStepsPerTask) {
          // Unlike the identical check on the very first plan, nothing is
          // discarded here on purpose: real, verified work has already
          // happened this task, and a step-count guard is not a reason to
          // report it as failed.
          this.log.warn('continuation plan would exceed the step limit; stopping with what succeeded', {
            wouldBe: nextTotal,
            limit: config.automation.maxStepsPerTask,
          });
          break roundLoop;
        }

        const added = toTaskSteps(continuation.steps, completedSteps.length);
        this.deps.tasks.appendSteps(added);
        publish(this.deps.bus, { type: 'task.updated', task: this.requireTask() });
        this.log.info('continuation plan created', { round: round + 1, steps: added.length });
      }

      // ---- verify + report ----------------------------------------------
      this.machine.transition('verifying');
      this.deps.tasks.setStatus('verifying');
      this.complete(await this.report());
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

  /**
   * Decide what this instruction means: an answer to a standing offer, or new
   * work for the planner (spec §80).
   *
   * The order is the design. A bare "yes do that then" carries no content the
   * planner could act on — re-planning it produces, at best, a guess and, as
   * observed, a request to clarify a suggestion the agent itself made a moment
   * earlier. So agreement is resolved against the stored proposal *first*, and
   * the model is never consulted about whether it meant what it said.
   *
   * Anything that is not a plain yes or no clears the offer before planning.
   * A user who has moved on has withdrawn their attention from it, and an offer
   * left lying around could be accepted several turns later by an unrelated
   * "sure".
   */
  private async decide(): Promise<PlanResult> {
    const task = this.requireTask();
    const answer = classifyResponse(task.instruction);
    const proposal = answer === 'other' ? undefined : this.context.pendingProposal;

    if (proposal && answer === 'affirmative') {
      // `take` rather than `read`: one offer, one answer. Leaving it in place
      // would let the next stray "ok" run the same action a second time.
      this.context.takeProposal();
      this.log.info('resolved an affirmative against a standing offer', {
        tool: proposal.tool,
        offeredInTask: proposal.taskId,
      });
      return {
        kind: 'steps',
        steps: [{ description: proposal.description, tool: proposal.tool, input: proposal.input }],
      };
    }

    if (proposal && answer === 'negative') {
      this.context.clearProposal();
      this.log.info('a standing offer was declined', { tool: proposal.tool });
      return { kind: 'reply', message: 'All right — I have left it alone.' };
    }

    if (answer === 'other') this.context.clearProposal();

    return this.deps.planner.plan({
      task,
      mode: this.mode,
      availableTools: this.deps.registry.availableIn(this.mode).map((t) => t.name),
      history: this.conversation(),
      referents: this.context.referents,
      signal: this.token.signal,
    });
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
      // Phase 7 §5: which applications the user has explicitly trusted. Read
      // fresh from config each step, so editing the list takes effect on the
      // next action rather than the next restart.
      security: { trustedApplications: config.security.trustedApplications },
      token: this.token,
      taskApproved: this.taskApproved,
      actionBudget: this.actionBudget,
    });

    // The executor moves us through observe/verify conceptually; reflect that in
    // the machine so the UI shows what is actually happening.
    if (this.machine.can('observing')) this.machine.transition('observing');
    if (this.machine.can('verifying')) this.machine.transition('verifying');

    const updated = this.deps.tasks.updateStep(step.id, {
      status: outcome.status,
      result: outcome.result,
      finishedAt: new Date().toISOString(),
      durationMs: outcome.durationMs,
      ...(outcome.verification ? { verification: outcome.verification } : {}),
      ...(outcome.result.error ? { error: outcome.result.error } : {}),
    });

    // Learn what this step was about, so "it", "that" and "this window" have
    // something concrete to point at next turn (spec §80). Driven from the
    // finished step, because the interesting facts — the URL a redirect actually
    // landed on, the window that was really focused — are in the result.
    const finished = updated.steps.find((candidate) => candidate.id === step.id);
    if (finished) this.context.observe(finished);

    publish(this.deps.bus, { type: 'task.updated', task: updated });

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
    publish(this.deps.bus, {
      type: 'agent.thinking',
      note: 'that step failed — working out what to try instead',
    });

    const recovery = await this.deps.planner.recover?.({
      task: this.requireTask(),
      mode: this.mode,
      availableTools: this.deps.registry.availableIn(this.mode).map((t) => t.name),
      history: this.conversation(),
      referents: this.context.referents,
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
    if (recovery.kind === 'reply' || recovery.kind === 'clarify' || recovery.kind === 'propose') {
      // A recovery that suggests rather than acts still ends this task. The
      // offer is stored so the user can simply agree, which is the whole point
      // of the mechanism — but the step that failed stays failed.
      if (recovery.kind === 'propose') {
        this.context.propose({
          tool: recovery.step.tool,
          input: recovery.step.input,
          offer: recovery.message,
          description: recovery.step.description,
          taskId,
        });
      }
      this.complete(
        recovery.kind === 'clarify'
          ? recovery.question
          : recovery.message,
      );
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
   * starts until `resume()`. Releases synthetic mouse and keyboard state
   * before anything else — a stuck modifier key or a held mouse button is
   * live on the user's machine for as long as this takes to run, so it goes
   * first, ahead of even the cancellation token.
   */
  emergencyStop(): { stopped: boolean; cancelledTaskId?: string } {
    const task = this.deps.tasks.activeTask;
    this.stopped = true;
    try {
      this.deps.releaseInputControl?.();
    } catch (cause) {
      this.log.warn('releasing synthetic input failed', { error: String(cause) });
    }
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
   * REPORT stage of the loop (spec §77).
   *
   * A planner that can read tool results writes the answer, because "Done.
   * System: get info" is not an answer to "what CPU do I have" — the data was
   * fetched and then thrown away. `Planner.summarise` closes that gap.
   *
   * The guard in front of it is the important part. The planner is only invited
   * to speak when **every step verified**; any failure or unverified step keeps
   * the mechanical sentence, which is built from step status and cannot
   * overstate what happened. Development rule 25 therefore holds structurally,
   * rather than depending on a language model honouring an instruction not to
   * claim success — which is exactly the kind of promise a model breaks under
   * pressure from a user who wants to hear that it worked.
   */
  private async report(): Promise<string> {
    const mechanical = this.summarise();
    const { unverified, failed } = this.deps.tasks.outcome();

    if (failed > 0 || unverified > 0) return mechanical;
    if (!this.deps.planner.summarise) return mechanical;

    publish(this.deps.bus, { type: 'agent.thinking', note: 'writing up what happened' });

    try {
      const written = await this.deps.planner.summarise({
        task: this.requireTask(),
        mode: this.mode,
        signal: this.token.signal,
      });
      return written?.trim() || mechanical;
    } catch (cause) {
      // Failing to phrase the answer must not fail work that already succeeded.
      if (this.token.cancelled) throw cause;
      this.log.warn('could not write a summary; using the mechanical one', { error: String(cause) });
      return mechanical;
    }
  }

  /**
   * Build the sentence the user hears when no planner can write one.
   *
   * ## Three outcomes, three tones
   *
   * Every step ends in one of three states, and each deserves different words.
   * Collapsing them — the earlier version did, and it made ordinary successes
   * read as malfunctions — is its own kind of dishonesty: a user who is told
   * "I could not confirm it" about work that plainly happened learns to ignore
   * the distinction entirely, which is the exact opposite of what development
   * rule 25 is protecting.
   *
   *  - **verified** — something was re-observed. Lead with the observation:
   *    "Done. The page is showing github.com — 'GitHub'." The observation is
   *    the answer; the step description is only the mechanism.
   *  - **not-applicable** — a pure read, whose returned value *is* the
   *    observation, so there is nothing extra to confirm. Report the result
   *    plainly, with no hedge and no confirmation language.
   *  - **unverified** — it ran, and the check could not settle it. Say what was
   *    seen and then what was not: "Opened it — could not confirm the page
   *    rendered." Never "done", never a bare "I could not confirm it", which
   *    withholds the part that is actually known.
   *
   * Failure keeps its own, plainly negative, phrasing. Order matters: failures
   * and unverified work are checked before the single-step shortcut, so a
   * one-step task can never take the confident path on unconfirmed work.
   */
  private summarise(): string {
    const { unverified, failed } = this.deps.tasks.outcome();
    const task = this.requireTask();
    const done = task.steps.filter(
      (s) => s.status === 'succeeded' || s.status === 'succeeded_unverified',
    ).length;

    if (failed > 0) {
      return `I completed ${done} of ${task.steps.length} steps; ${failed} failed.`;
    }

    if (unverified > 0) {
      const findings = observations(task.steps, 'succeeded_unverified');

      // One step, one finding: the verifier's own sentence is the whole report.
      // It already says what happened and what could not be checked, and
      // wrapping it in "I completed 1 step, but…" only buries that. `hedge`
      // guarantees the uncertainty survives even if a verifier forgot to state
      // it — the honesty rule cannot depend on every author remembering.
      if (task.steps.length === 1 && findings.length === 1) return hedge(findings[0]!);

      const noun = unverified === 1 ? 'one of them' : `${unverified} of them`;
      const detail = findings.length > 0 ? ` ${findings.join(' ')}` : '';
      return `I completed ${done} step${done === 1 ? '' : 's'} but could not confirm ${noun}.${detail}`;
    }

    // Nothing failed and nothing is unconfirmed. Answer with what was actually
    // seen where a verifier saw something, and with the step itself where the
    // tool was a pure read and there was nothing to see.
    const seen = observations(task.steps, 'succeeded');

    if (task.steps.length === 1) {
      return seen.length === 1 ? `Done. ${seen[0]}` : `Done. ${task.steps[0]!.description}.`;
    }
    // Beyond a few observations this stops being a summary and becomes a log,
    // which the task timeline already is.
    if (seen.length > 0 && seen.length <= 3) return `Done. ${seen.join(' ')}`;
    return `Done. I completed and verified all ${done} steps.`;
  }

  /**
   * The last few completed exchanges, oldest-first.
   *
   * Without this the agent offers to do something, the user says "yes do that",
   * and the next turn has never heard of the offer — which is how it ends up
   * asking the user to clarify a request it made itself. Observed in real use;
   * it is the single thing that most stops the agent feeling like an agent.
   *
   * Bounded at {@link CONVERSATION_TURNS}. Unbounded history would grow every
   * request until the context-budget guard refused the task outright, and the
   * failure would arrive later and be harder to explain than a short memory.
   */
  private conversation(): ConversationTurn[] {
    const active = this.deps.tasks.activeTask?.id;

    return this.deps.tasks
      .recent(CONVERSATION_TURNS + 1)
      .filter((task) => task.id !== active && task.summary !== undefined)
      .slice(0, CONVERSATION_TURNS)
      .reverse() // `recent()` is newest-first; a conversation reads forwards.
      .map((task) => ({
        instruction: task.instruction,
        reply: task.summary ?? '',
        tools: task.steps.map((step) => step.tool),
      }));
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

/**
 * Sentences that already admit the thing was not confirmed.
 *
 * Used to decide whether an unverified finding needs a caveat appended. It is a
 * heuristic over free text and is allowed to be: a false positive leaves a
 * sentence that already hedges, and a false negative appends a second hedge to
 * one that did. Neither can produce an overclaim, which is the only outcome
 * development rule 25 actually forbids.
 */
const ALREADY_HEDGED =
  /\b(could ?n[o']?t|could not|cannot|can'?t|unable|not been|has not|have not|was not|were not|may not|might not|unverified|unconfirmed|no way to (tell|check|confirm))\b/i;

/** Guarantee an unverified report says so, whatever the verifier wrote. */
function hedge(detail: string): string {
  return ALREADY_HEDGED.test(detail) ? detail : `${detail} I could not confirm it.`;
}

/**
 * Collect what the verifiers actually observed, for steps in a given state.
 *
 * `not-applicable` details are deliberately excluded: they say "read-only tool:
 * the returned value is itself the observation", which is a note to a developer
 * about the verification model, not something a user asked to hear.
 */
function observations(steps: readonly TaskStep[], status: TaskStep['status']): string[] {
  return steps
    .filter((step) => step.status === status)
    .filter((step) => step.verification?.status === 'verified' || status === 'succeeded_unverified')
    .map((step) => step.verification?.detail?.trim())
    .filter((detail): detail is string => Boolean(detail))
    // Details are free text written by each verifier, so terminal punctuation
    // cannot be assumed — without this they run together into one unreadable
    // sentence.
    .map((detail) => (/[.!?]$/.test(detail) ? detail : `${detail}.`));
}
