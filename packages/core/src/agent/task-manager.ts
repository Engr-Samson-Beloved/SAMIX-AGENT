import { randomUUID } from 'node:crypto';
import type { AgentMode, Task, TaskStatus, TaskStep } from '@samix/shared';

/**
 * Task lifecycle and history (spec §28, §48).
 *
 * Holds tasks in memory only. SQLite persistence is Phase 9 — the interface here
 * is shaped so that swapping the store is an implementation change rather than a
 * change to every caller.
 *
 * All mutations go through methods that stamp `updatedAt`, because the UI
 * timeline (spec §48) is driven off task snapshots and a mutation that skipped
 * the timestamp would silently stop updating the display.
 */

export interface TaskManagerOptions {
  /** Completed tasks retained for the history pane. */
  readonly historyLimit?: number;
}

export class TaskManager {
  private current: Task | undefined;
  private readonly history: Task[] = [];
  private readonly historyLimit: number;

  constructor(options: TaskManagerOptions = {}) {
    this.historyLimit = options.historyLimit ?? 50;
  }

  get activeTask(): Task | undefined {
    return this.current ? structuredClone(this.current) : undefined;
  }

  get hasActiveTask(): boolean {
    return this.current !== undefined && !isTerminalStatus(this.current.status);
  }

  create(instruction: string, source: Task['source'], mode: AgentMode): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: `task_${randomUUID().slice(0, 8)}`,
      instruction,
      source,
      status: 'pending',
      mode,
      steps: [],
      createdAt: now,
      updatedAt: now,
    };
    this.current = task;
    return structuredClone(task);
  }

  setStatus(status: TaskStatus, patch: Partial<Pick<Task, 'summary' | 'error'>> = {}): Task {
    const task = this.requireCurrent();
    task.status = status;
    task.updatedAt = new Date().toISOString();
    if (patch.summary !== undefined) task.summary = patch.summary;
    if (patch.error !== undefined) task.error = patch.error;
    if (isTerminalStatus(status)) {
      task.finishedAt = task.updatedAt;
      this.archive(task);
    }
    return structuredClone(task);
  }

  setSteps(steps: TaskStep[]): Task {
    const task = this.requireCurrent();
    task.steps = steps;
    task.updatedAt = new Date().toISOString();
    return structuredClone(task);
  }

  appendSteps(steps: TaskStep[]): Task {
    const task = this.requireCurrent();
    task.steps = [...task.steps, ...steps];
    task.updatedAt = new Date().toISOString();
    return structuredClone(task);
  }

  updateStep(stepId: string, patch: Partial<TaskStep>): Task {
    const task = this.requireCurrent();
    const index = task.steps.findIndex((s) => s.id === stepId);
    if (index === -1) throw new Error(`No step "${stepId}" in task ${task.id}`);
    task.steps[index] = { ...task.steps[index]!, ...patch };
    task.updatedAt = new Date().toISOString();
    return structuredClone(task);
  }

  /** The next step awaiting execution, or undefined when the plan is done. */
  nextPendingStep(): TaskStep | undefined {
    const step = this.current?.steps.find((s) => s.status === 'pending');
    return step ? structuredClone(step) : undefined;
  }

  /**
   * Did every step reach an acceptable end state?
   *
   * `succeeded_unverified` counts as *not* fully successful. Development rule 25
   * forbids claiming success without verification, so the distinction survives
   * all the way to the summary the user reads.
   */
  outcome(): { allSucceeded: boolean; unverified: number; failed: number } {
    const steps = this.current?.steps ?? [];
    return {
      allSucceeded: steps.every((s) => s.status === 'succeeded'),
      unverified: steps.filter((s) => s.status === 'succeeded_unverified').length,
      failed: steps.filter((s) => s.status === 'failed').length,
    };
  }

  recent(limit: number): Task[] {
    const all = this.current && !isTerminalStatus(this.current.status)
      ? [this.current, ...this.history]
      : this.history;
    return all.slice(0, limit).map((t) => structuredClone(t));
  }

  find(taskId: string): Task | undefined {
    if (this.current?.id === taskId) return structuredClone(this.current);
    const found = this.history.find((t) => t.id === taskId);
    return found ? structuredClone(found) : undefined;
  }

  /** Detach the current task without archiving, when returning to idle. */
  clearCurrent(): void {
    this.current = undefined;
  }

  private requireCurrent(): Task {
    if (!this.current) throw new Error('No active task');
    return this.current;
  }

  private archive(task: Task): void {
    // Newest first, so `recent()` is a plain slice.
    this.history.unshift(structuredClone(task));
    if (this.history.length > this.historyLimit) this.history.length = this.historyLimit;
  }
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
  );
}
