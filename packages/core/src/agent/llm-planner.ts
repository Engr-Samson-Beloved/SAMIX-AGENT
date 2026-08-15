import { z } from 'zod';
import type { AgentMode, AppConfig } from '@samix/shared';
import { ASK_USER_FUNCTION } from '../ai/google.js';
import type { ModelRouter } from '../ai/model-router.js';
import { LlmError, type LlmMessage, type LlmProvider, type LlmResponse, type LlmToolCall } from '../ai/types.js';
import type { Logger } from '../observability/logger.js';
import type { ToolRegistry } from '../tools/registry.js';
import type {
  PlanRequest,
  PlanResult,
  PlannedStep,
  Planner,
  RecoveryRequest,
  SummaryRequest,
} from './planner.js';

/**
 * LLM-backed planner (spec §27, §28, §30).
 *
 * Drops into the `Planner` seam that Phase 1 built, so the orchestrator, the
 * executor, the permission engine and the UI are untouched by this file
 * existing. That was the point of the seam.
 *
 * ## The model proposes; this class disposes
 *
 * Everything the model returns is treated as an untrusted suggestion:
 *
 *  - A call to a tool that is not registered **in the current mode** is
 *    rejected, not executed. The model cannot widen its own capabilities by
 *    naming something that is not there.
 *  - Every argument object is re-validated against the tool's real Zod schema.
 *    The schema Gemini saw was a lossy projection (`ai/json-schema.ts`), so the
 *    only authoritative check is the local one.
 *  - A truncated response is never executed. A plan cut off mid-generation can
 *    be missing exactly the step that made it safe.
 *
 * Rejections get one repair round-trip with the specific errors fed back, which
 * fixes the common case (a mistyped enum value) without letting a confused model
 * loop. After that the planner reports honestly rather than trying again.
 *
 * ## What it deliberately does not do
 *
 * It does not decide whether an action is allowed. Permission and confirmation
 * belong to `PermissionEngine` and the executor, and stay there — a planner that
 * could reason its way past a confirmation would make the whole safety model
 * advisory. The planner only ever produces a proposal.
 */

export interface LlmPlannerDeps {
  readonly provider: LlmProvider;
  readonly router: ModelRouter;
  readonly registry: ToolRegistry;
  readonly config: () => AppConfig;
  readonly logger: Logger;
  /** Injected in tests so prompts are reproducible. */
  readonly now?: () => Date;
}

/** One repair attempt. Two would mostly buy a slower way to reach the same wall. */
const MAX_REPAIR_ATTEMPTS = 1;

/** Rough characters-per-token for the pre-flight context estimate. */
const CHARS_PER_TOKEN = 4;

export class LlmPlanner implements Planner {
  readonly name: string;
  private readonly now: () => Date;

  constructor(private readonly deps: LlmPlannerDeps) {
    this.name = `${deps.provider.name} (LLM)`;
    this.now = deps.now ?? ((): Date => new Date());
  }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  async plan(request: PlanRequest): Promise<PlanResult> {
    const config = this.deps.config();
    const tools = this.deps.registry.toLlmSchemas(request.mode);
    const route = this.deps.router.select({ kind: 'plan', instruction: request.task.instruction });

    const messages: LlmMessage[] = [{ role: 'user', text: request.task.instruction }];
    const system = this.buildSystemPrompt(request.mode, 'plan');

    const budget = this.checkContextBudget(system, messages, tools, config);
    if (budget) return budget;

    this.deps.logger.debug('planning', {
      model: route.model,
      routing: route.reason,
      tools: tools.length,
    });

    return this.converse({ request, messages, system, route, tools, config, phase: 'plan' });
  }

  // -------------------------------------------------------------------------
  // Recovery (spec §30)
  // -------------------------------------------------------------------------

  async recover(request: RecoveryRequest): Promise<PlanResult> {
    const config = this.deps.config();
    const tools = this.deps.registry.toLlmSchemas(request.mode);
    const route = this.deps.router.select({ kind: 'recover' });

    // The model is shown the original instruction, the step it proposed, and
    // exactly what went wrong — including the machine-readable error code, which
    // is the part it can actually reason about (spec §50).
    const messages: LlmMessage[] = [
      { role: 'user', text: request.task.instruction },
      {
        role: 'model',
        toolCalls: [
          { id: 'failed', name: request.failedStep.tool, input: request.failedStep.input },
        ],
      },
      {
        role: 'tool',
        name: request.failedStep.tool,
        result: {
          success: false,
          errorCode: request.error.code,
          message: request.error.message,
          ...(request.error.details ? { details: request.error.details } : {}),
        },
      },
      {
        role: 'user',
        text:
          `That step failed (attempt ${request.attempt} of ${config.automation.maxStepRetries}). ` +
          `Either propose different tool calls that work around the failure, or explain in plain text why ` +
          `this cannot be done. Do not repeat the identical call — it will fail the same way.`,
      },
    ];

    const system = this.buildSystemPrompt(request.mode, 'recover');
    const budget = this.checkContextBudget(system, messages, tools, config);
    if (budget) {
      return { kind: 'give-up', reason: budget.kind === 'reply' ? budget.message : 'Context budget exceeded.' };
    }

    this.deps.logger.debug('recovering', { model: route.model, code: request.error.code });

    return this.converse({ request, messages, system, route, tools, config, phase: 'recover' });
  }

  // -------------------------------------------------------------------------
  // Reporting (spec §77, REPORT)
  // -------------------------------------------------------------------------

  /**
   * Answer the user's original question from the results that were actually
   * observed.
   *
   * Without this the agent fetches the data and throws it away: "what CPU do I
   * have" completes with "Done. System: get info", which reports the mechanism
   * instead of the answer.
   *
   * The orchestrator only calls this once every step has verified, so this
   * method never has to reason about partial failure — and cannot be talked
   * into claiming something worked when it did not.
   */
  async summarise(request: SummaryRequest): Promise<string | undefined> {
    const steps = request.task.steps.filter((step) => step.status === 'succeeded');
    if (steps.length === 0) return undefined;

    const messages: LlmMessage[] = [{ role: 'user', text: request.task.instruction }];
    for (const step of steps) {
      messages.push({
        role: 'model',
        toolCalls: [{ id: step.id, name: step.tool, input: step.input }],
      });
      messages.push({
        role: 'tool',
        name: step.tool,
        result: step.result?.data ?? { ok: true },
      });
    }
    messages.push({
      role: 'user',
      text: 'Now answer my original question using those results. Do not describe the steps.',
    });

    // Routed to the fast model: this turn has no decisions in it, only phrasing
    // of facts already gathered, and it sits between the user and the answer —
    // so latency here is felt directly.
    const route = this.deps.router.select({ kind: 'summarise' });

    try {
      const response = await this.deps.provider.generate({
        model: route.model,
        system: [
          `You are SAMIX Agent reporting back to the person who asked. Answer their question directly`,
          `from the tool results provided, in one or two short sentences of plain prose.`,
          ``,
          `  - State only what the results actually show. Never add, estimate or infer a fact that`,
          `    is not in them, and never fill a gap with something plausible.`,
          `  - If the results do not answer the question, name the specific thing you could not`,
          `    determine — "I could not find out X" — rather than commenting on the results`,
          `    themselves. "The results do not answer the question" tells the reader nothing they`,
          `    can act on and is never an acceptable answer.`,
          `  - Do not narrate the steps, name the tools, or mention that you used any.`,
          `  - No preamble, no sign-off, no markdown.`,
        ].join('\n'),
        messages,
        tools: [],
        temperature: 0,
        maxOutputTokens: route.maxOutputTokens,
        signal: request.signal,
      });

      this.deps.logger.debug('wrote a summary', {
        model: response.model,
        durationMs: response.durationMs,
      });
      return response.text.trim() || undefined;
    } catch (cause) {
      if (cause instanceof LlmError && cause.kind === 'cancelled') throw cause;
      // The work already succeeded and is already verified. Failing to phrase
      // it is not a reason to report a failure, so the caller's mechanical
      // summary stands.
      this.deps.logger.warn('could not write a summary', { error: String(cause) });
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Shared conversation loop
  // -------------------------------------------------------------------------

  private async converse(args: {
    request: PlanRequest;
    messages: LlmMessage[];
    system: string;
    route: { model: string; temperature: number; maxOutputTokens: number; reason: string };
    tools: ReturnType<ToolRegistry['toLlmSchemas']>;
    config: AppConfig;
    phase: 'plan' | 'recover';
  }): Promise<PlanResult> {
    const { request, system, route, tools, phase } = args;
    const messages = [...args.messages];

    for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
      let response: LlmResponse;
      try {
        response = await this.deps.provider.generate({
          model: route.model,
          system,
          messages,
          tools,
          temperature: route.temperature,
          maxOutputTokens: route.maxOutputTokens,
          signal: request.signal,
        });
      } catch (cause) {
        return this.fromProviderError(cause, phase);
      }

      this.deps.logger.info('llm turn', {
        model: response.model,
        durationMs: response.durationMs,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        toolCalls: response.toolCalls.length,
        finishReason: response.finishReason,
      });

      // A truncated plan is not a plan. Executing the half of it that arrived is
      // how an agent deletes the source before finishing the copy.
      if (response.finishReason === 'max_tokens') {
        const message =
          'The plan was cut off before it finished, so I have not run any of it. ' +
          'Try a smaller instruction, or raise the output token limit in Settings.';
        return phase === 'plan' ? { kind: 'reply', message } : { kind: 'give-up', reason: message };
      }

      // ---- the model wants to ask the user something ------------------------
      const ask = response.toolCalls.find((call) => call.name === ASK_USER_FUNCTION);
      if (ask) {
        const parsed = AskUserArgs.safeParse(ask.input);
        if (parsed.success) {
          return {
            kind: 'clarify',
            question: parsed.data.question,
            ...(parsed.data.options && parsed.data.options.length > 0
              ? { options: parsed.data.options }
              : {}),
          };
        }
        // A malformed clarification still means "I need to ask" — falling
        // through to execute the other calls would act on the ambiguity the
        // model just flagged.
        return { kind: 'clarify', question: 'Could you rephrase that? I was not sure what you meant.' };
      }

      const realCalls = response.toolCalls.filter((call) => call.name !== ASK_USER_FUNCTION);

      // ---- no tools: a direct answer ---------------------------------------
      if (realCalls.length === 0) {
        const text = response.text.trim();
        if (phase === 'recover') {
          // During recovery a prose answer means "no way forward". Returning it
          // as a `reply` would drive the orchestrator to mark a task that
          // actually failed as completed.
          return {
            kind: 'give-up',
            reason: text || 'The model offered no way to recover from that failure.',
          };
        }
        return {
          kind: 'reply',
          message: text || 'I do not have anything to add.',
        };
      }

      // ---- validate every proposed call ------------------------------------
      const validation = this.validateCalls(realCalls, request.mode);
      if (validation.problems.length === 0) {
        return { kind: 'steps', steps: validation.steps };
      }

      this.deps.logger.warn('rejected proposed tool calls', {
        attempt: attempt + 1,
        problems: validation.problems,
      });

      if (attempt === MAX_REPAIR_ATTEMPTS) {
        const message =
          `I could not build a plan I trust. ${validation.problems[0]} ` +
          `I have not run anything.`;
        return phase === 'plan' ? { kind: 'reply', message } : { kind: 'give-up', reason: message };
      }

      // Feed the errors back verbatim and let the model correct itself. The
      // model's own call is echoed into the history so it can see what it sent.
      messages.push({
        role: 'model',
        ...(response.text ? { text: response.text } : {}),
        toolCalls: realCalls,
      });
      messages.push({
        role: 'user',
        text:
          `Those tool calls were rejected before running:\n` +
          validation.problems.map((problem) => `  - ${problem}`).join('\n') +
          `\n\nAvailable tools: ${request.availableTools.join(', ') || 'none'}.\n` +
          `Correct the calls, or explain in plain text why the task cannot be done.`,
      });
    }

    /* c8 ignore next */
    return { kind: 'reply', message: 'I could not produce a plan.' };
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  private validateCalls(
    calls: readonly LlmToolCall[],
    mode: AgentMode,
  ): { steps: PlannedStep[]; problems: string[] } {
    const steps: PlannedStep[] = [];
    const problems: string[] = [];

    // Availability is resolved against the CURRENT mode, not the whole
    // registry. A developer-only tool named while in `safe` mode is as invalid
    // as one that does not exist, and must be refused the same way.
    const available = new Set(this.deps.registry.availableIn(mode).map((tool) => tool.name));

    for (const call of calls) {
      const tool = this.deps.registry.get(call.name);
      if (!tool || !available.has(call.name)) {
        problems.push(
          `"${call.name}" is not a tool that is available right now, so I did not run it.`,
        );
        continue;
      }

      const parsed = (tool.inputSchema as z.ZodType).safeParse(call.input ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('; ');
        problems.push(`the arguments for "${call.name}" were not valid (${detail}).`);
        continue;
      }

      steps.push({
        description: describeStep(call.name, tool.description, parsed.data),
        tool: call.name,
        input: parsed.data,
      });
    }

    return { steps, problems };
  }

  // -------------------------------------------------------------------------
  // Prompting
  // -------------------------------------------------------------------------

  private buildSystemPrompt(mode: AgentMode, phase: 'plan' | 'recover'): string {
    const tools = this.deps.registry.describe(mode);
    const now = this.now();

    const catalogue = tools
      .map(
        (tool) =>
          `  - ${tool.name} (${tool.permission}, ${tool.reversibility})` +
          (tool.permission === 'destructive' || tool.permission === 'external'
            ? ' — the user is asked to confirm before this runs'
            : ''),
      )
      .join('\n');

    return [
      `You are the planner inside SAMIX Agent, which automates a Windows computer for its owner.`,
      ``,
      `Your only job is to decide which tools to call. You never perform actions yourself, and you`,
      `never see their results in this turn — a separate execution layer runs each call, checks that`,
      `it actually worked, and asks the user to confirm anything risky.`,
      ``,
      `Current context`,
      `  local time: ${now.toISOString()}`,
      `  platform:   ${process.platform}`,
      `  agent mode: ${mode}`,
      ``,
      `Tools available in this mode:`,
      catalogue || '  (none)',
      ``,
      `Rules, in priority order:`,
      ``,
      `1. Never claim an action has happened. You are proposing work, not reporting it. Do not say`,
      `   "I have copied" or "done" — the execution layer decides what actually succeeded.`,
      `2. Only call tools from the list above, spelled exactly as written. That list is complete and`,
      `   authoritative — it is everything you can do right now. Never call a tool to find out what`,
      `   you are capable of; you are already looking at the answer. If the task needs a capability`,
      `   that is not listed, call no tools at all and say in plain text what you cannot do and why.`,
      `   Never invent a tool, and never describe a capability you do not have as though you had it.`,
      `3. Call ${ASK_USER_FUNCTION} instead of guessing whenever the instruction is ambiguous. This is`,
      `   mandatory before anything that reaches another person, deletes, or overwrites: a wrong`,
      `   recipient or a wrong file cannot be undone by apologising afterwards.`,
      `4. Never invent a file path, a contact, an application name or an identifier. If you do not`,
      `   know it, find it with a tool or ask.`,
      `5. Prefer the fewest steps that genuinely accomplish the task. Do not pad a plan with`,
      `   verification steps — verification is automatic and is not your responsibility.`,
      `6. If the request needs no tools at all, just answer it in plain text.`,
      ...(phase === 'recover'
        ? [
            `7. A step has just failed. Read the error code and change your approach; repeating the`,
            `   identical call will fail identically. If nothing sensible remains, say so in plain`,
            `   text — that is a valid and useful answer, and better than a plan you do not believe in.`,
          ]
        : []),
    ].join('\n');
  }

  /**
   * Refuse before spending anything when the request is obviously too large.
   *
   * Deliberately a rough character estimate rather than a real tokeniser: it
   * exists to stop a runaway, not to bill accurately, and shipping a tokeniser
   * per provider to make a guardrail slightly tighter is a bad trade.
   */
  private checkContextBudget(
    system: string,
    messages: readonly LlmMessage[],
    tools: ReturnType<ToolRegistry['toLlmSchemas']>,
    config: AppConfig,
  ): { kind: 'reply'; message: string } | undefined {
    const characters =
      system.length +
      JSON.stringify(messages).length +
      JSON.stringify(tools).length;
    const estimate = Math.ceil(characters / CHARS_PER_TOKEN);

    if (estimate <= config.llm.maxContextTokens) return undefined;

    this.deps.logger.warn('refused a task over the context budget', {
      estimate,
      limit: config.llm.maxContextTokens,
    });
    return {
      kind: 'reply',
      message:
        `That request is too large for the configured context budget ` +
        `(about ${estimate.toLocaleString()} tokens against a limit of ${config.llm.maxContextTokens.toLocaleString()}). ` +
        `I have not sent it. Shorten the instruction or raise the limit in Settings.`,
    };
  }

  /** Turn a provider failure into an honest outcome rather than a stack trace. */
  private fromProviderError(cause: unknown, phase: 'plan' | 'recover'): PlanResult {
    const error =
      cause instanceof LlmError ? cause : new LlmError('server', String(cause), { cause });

    // Cancellation is the user's decision, not a fault. It is re-thrown so the
    // orchestrator's cancellation path handles it instead of reporting a
    // completed task with an apology in it.
    if (error.kind === 'cancelled') throw cause;

    this.deps.logger.error('llm request failed', {
      kind: error.kind,
      status: error.status,
      // The provider message can echo request content back, so it is logged
      // through the redacting logger and never surfaced raw to the user.
      message: error.message,
    });

    const message = error.userMessage();
    return phase === 'plan' ? { kind: 'reply', message } : { kind: 'give-up', reason: message };
  }
}

const AskUserArgs = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
});

/**
 * Build the short line shown next to a step in the UI and read back in the
 * final summary.
 *
 * Derived from the tool's **name** and its concrete arguments, deliberately not
 * from `tool.description`. That description is written for the model (see
 * `AgentTool.description`) and runs to several sentences of guidance about when
 * to choose the tool; surfacing it to the user produces lines like
 * "Done. Report facts about the computer the agent is running on: operating
 * system and version, CPU and memory, Node runti…", which describes the tool
 * rather than the work.
 *
 * Asking the model for a per-step rationale was the alternative and was
 * rejected: it means either a `_why` field polluting every tool schema or a
 * second round trip, and the answer could disagree with the call it labels.
 * A name-derived line costs nothing and cannot drift — the arguments shown are
 * the arguments that will execute.
 */
function describeStep(name: string, _description: string, input: unknown): string {
  const [namespace = name, method = ''] = name.split('.');
  const action = humanise(method) || humanise(namespace);
  const subject = capitalise(namespace);
  const summary = summariseArgs(input);

  return summary ? `${subject}: ${action} (${summary})` : `${subject}: ${action}`;
}

/** `getInfo` → `get info`; `listDirectory` → `list directory`. */
function humanise(identifier: string): string {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function summariseArgs(input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return '';
  const entries = Object.entries(input as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${formatValue(value)}`);
  return entries.join(', ');
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  if (Array.isArray(value)) {
    // Show the values when there are few and they are short — "sections: os,
    // hardware" tells the user what will happen, where "sections: [2]" does not.
    const scalars = value.filter((item) => typeof item === 'string' || typeof item === 'number');
    if (scalars.length === value.length && value.length <= 4) {
      const joined = scalars.join(', ');
      if (joined.length <= 60) return joined;
    }
    return `${value.length} items`;
  }
  if (typeof value === 'object' && value !== null) return '…';
  return String(value);
}
