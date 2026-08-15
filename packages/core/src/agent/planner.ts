import { randomUUID } from 'node:crypto';
import type { AgentMode, Task, TaskStep, ToolError } from '@samix/shared';
import type { ToolRegistry } from '../tools/registry.js';

/**
 * Planner contract (spec §27, §28).
 *
 * The orchestrator depends on THIS interface, never on a concrete planner. That
 * is the seam that lets Phase 3 drop in an Anthropic-backed planner — and later
 * an OpenAI or local one (spec §6) — without touching the agent loop, the
 * executor, the permission engine or the UI.
 *
 * A planner may return one of three things, and modelling all three explicitly
 * is what keeps the agent from being a chatbot that pretends to act:
 *
 *   - `steps`   — a concrete plan of tool invocations.
 *   - `reply`   — a direct answer needing no tools ("what's the date?").
 *   - `clarify` — a question back to the user. Spec §21/§94: never guess when an
 *                 external action is about to happen; stop and ask.
 */

/**
 * One completed exchange, oldest-first, for multi-turn context.
 *
 * Deliberately not the whole `Task`. Feeding back full step results would grow
 * the request without bound and bury the current instruction under tool output
 * the model has already reasoned about once. What a follow-up actually needs is
 * what was asked, what was answered, and which tools were involved — enough to
 * resolve "do that then", "close it" and "the other one".
 */
export interface ConversationTurn {
  readonly instruction: string;
  /** The sentence the user was given. */
  readonly reply: string;
  readonly tools: readonly string[];
}

export interface PlanRequest {
  readonly task: Task;
  readonly mode: AgentMode;
  /** Tools available in the current mode, already filtered. */
  readonly availableTools: readonly string[];
  /**
   * Earlier exchanges in this session, oldest-first. Empty on the first
   * instruction. A planner may ignore it; the rule-based one does.
   */
  readonly history: readonly ConversationTurn[];
  readonly signal: AbortSignal;
}

export interface RecoveryRequest extends PlanRequest {
  readonly failedStep: TaskStep;
  readonly error: ToolError;
  /** How many recovery attempts have already been made for this step. */
  readonly attempt: number;
}

export type PlanResult =
  | { kind: 'steps'; steps: PlannedStep[] }
  | { kind: 'reply'; message: string }
  | { kind: 'clarify'; question: string; options?: string[] }
  /** Recovery only: no way forward, fail the task with this explanation. */
  | { kind: 'give-up'; reason: string };

export interface PlannedStep {
  readonly description: string;
  readonly tool: string;
  readonly input: unknown;
}

/**
 * Input to the REPORT stage of the loop (spec §77): the finished task, with
 * every step's result attached, so the answer can be written from what was
 * actually observed rather than from what was intended.
 */
export interface SummaryRequest {
  readonly task: Task;
  readonly mode: AgentMode;
  readonly signal: AbortSignal;
}

export interface Planner {
  /** Identifies the planner in logs and the status snapshot. */
  readonly name: string;
  plan(request: PlanRequest): Promise<PlanResult>;
  /**
   * Decide what to do about a failed step (spec §30). Optional: a planner that
   * cannot reason about recovery simply omits it and the orchestrator fails the
   * task, which is the safe default.
   */
  recover?(request: RecoveryRequest): Promise<PlanResult>;
  /**
   * Turn verified tool results into the sentence the user hears (spec §77's
   * REPORT stage). Optional: without it the orchestrator falls back to its own
   * mechanical summary, which states what ran but cannot answer a question.
   *
   * The orchestrator only calls this when **every step verified** — see
   * `Agent.report()`. Honesty about unverified work stays a property of the
   * code, not a request made of a language model.
   *
   * Returning `undefined` means "no better answer than the mechanical one".
   */
  summarise?(request: SummaryRequest): Promise<string | undefined>;
}

/** Materialise planner output into task steps. */
export function toTaskSteps(planned: readonly PlannedStep[], startIndex = 0): TaskStep[] {
  return planned.map((step, i) => ({
    id: `step_${randomUUID().slice(0, 8)}`,
    index: startIndex + i,
    description: step.description,
    tool: step.tool,
    input: step.input,
    status: 'pending' as const,
    attempts: 0,
  }));
}

/**
 * Phase 1 planner — deterministic, no LLM.
 *
 * Why this exists rather than stubbing the orchestrator: the agent loop, the
 * permission engine, verification, the audit trail and the event stream are all
 * real in Phase 1 and need to be exercised end to end on real input. A rule-based
 * planner drives all of that with zero network, zero cost and perfect
 * repeatability, which also makes it the right planner for integration tests
 * even after Phase 3 lands.
 *
 * What it deliberately does NOT do is pretend to understand language. Anything it
 * cannot match with confidence produces an honest `reply` saying so, rather than
 * guessing at a tool. Spec §93: never hallucinate capability.
 */
export class RuleBasedPlanner implements Planner {
  readonly name = 'rule-based (Phase 1)';

  constructor(private readonly registry: ToolRegistry) {}

  plan(request: PlanRequest): Promise<PlanResult> {
    const text = request.task.instruction.toLowerCase().trim();

    // Rule 1 — questions about the agent itself.
    if (
      this.registry.has('agent.getStatus') &&
      /\b(status|mode|what can you do|capabilit|which tools|your state)\b/.test(text)
    ) {
      return Promise.resolve({
        kind: 'steps',
        steps: [
          {
            description: 'Read the agent’s current mode, available tools and subsystem readiness',
            tool: 'agent.getStatus',
            input: {},
          },
        ],
      });
    }

    // Rule 2 — questions about the machine.
    if (
      this.registry.has('system.getInfo') &&
      /\b(system|computer|machine|windows version|os|cpu|memory|ram|hostname|username|this pc)\b/.test(text)
    ) {
      const sections = selectSections(text);
      return Promise.resolve({
        kind: 'steps',
        steps: [
          {
            description: `Read system information${sections ? ` (${sections.join(', ')})` : ''}`,
            tool: 'system.getInfo',
            input: sections ? { sections } : {},
          },
        ],
      });
    }

    // Rule 3 — greeting, so the very first launch feels alive.
    if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/.test(text)) {
      return Promise.resolve({
        kind: 'reply',
        message: 'Hello. Ask me about this computer or about my current status.',
      });
    }

    // No confident match. Say so plainly and list what is genuinely available,
    // instead of inventing a plan.
    return Promise.resolve({
      kind: 'reply',
      message:
        `I don't yet understand that. Natural-language planning arrives in Phase 3, when the LLM is connected. ` +
        `Right now I can answer questions about this computer or about my own status. ` +
        `Available tools: ${request.availableTools.join(', ') || 'none'}.`,
    });
  }

  /**
   * No recovery reasoning in Phase 1. Returning `give-up` is the honest answer —
   * a rule-based planner has no basis for deciding whether a retry would help,
   * and retrying blindly is how agents get stuck in loops (spec §30).
   */
  recover(request: RecoveryRequest): Promise<PlanResult> {
    return Promise.resolve({
      kind: 'give-up',
      reason: `The step "${request.failedStep.description}" failed (${request.error.code}) and this planner cannot re-plan. LLM-driven recovery arrives in Phase 3.`,
    });
  }
}

function selectSections(text: string): Array<'os' | 'hardware' | 'runtime' | 'user'> | undefined {
  const sections: Array<'os' | 'hardware' | 'runtime' | 'user'> = [];
  if (/\b(windows version|os|operating system|platform)\b/.test(text)) sections.push('os');
  if (/\b(cpu|memory|ram|processor|hardware)\b/.test(text)) sections.push('hardware');
  if (/\b(node|runtime|uptime|pid)\b/.test(text)) sections.push('runtime');
  if (/\b(user|username|home|hostname|account)\b/.test(text)) sections.push('user');
  return sections.length > 0 ? sections : undefined;
}
