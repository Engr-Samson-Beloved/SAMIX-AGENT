import { z } from 'zod';
import type { AgentMode, AppConfig } from '@samix/shared';
import { ASK_USER_FUNCTION, CONTROL_FUNCTIONS, PROPOSE_ACTION_FUNCTION } from '../ai/google.js';
import type { ModelRouter } from '../ai/model-router.js';
import { LlmError, type LlmMessage, type LlmProvider, type LlmResponse, type LlmToolCall } from '../ai/types.js';
import type { Logger } from '../observability/logger.js';
import type { ToolRegistry } from '../tools/registry.js';
import { describeReferents } from './context.js';
import type {
  ContinueRequest,
  ConversationTurn,
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
    const route = this.deps.router.select({
      kind: 'plan',
      instruction: request.task.instruction,
      historyLength: request.history.length,
    });

    const messages: LlmMessage[] = [
      ...toConversationMessages(request.history),
      { role: 'user', text: request.task.instruction },
    ];
    const system = this.buildSystemPrompt(request.mode, 'plan', request.referents);

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

    const system = this.buildSystemPrompt(request.mode, 'recover', request.referents);
    const budget = this.checkContextBudget(system, messages, tools, config);
    if (budget) {
      return { kind: 'give-up', reason: budget.kind === 'reply' ? budget.message : 'Context budget exceeded.' };
    }

    this.deps.logger.debug('recovering', { model: route.model, code: request.error.code });

    return this.converse({ request, messages, system, route, tools, config, phase: 'recover' });
  }

  // -------------------------------------------------------------------------
  // Continuation — the observe-then-act round (see Planner.continue)
  // -------------------------------------------------------------------------

  async continue(request: ContinueRequest): Promise<PlanResult> {
    const config = this.deps.config();
    const tools = this.deps.registry.toLlmSchemas(request.mode);
    const route = this.deps.router.select({
      kind: 'plan',
      instruction: request.task.instruction,
      historyLength: request.history.length,
    });

    // Replay every step that has actually run, with its real result — the same
    // shape `summarise()` uses, because this is the same idea: show the model
    // what it could not have known when it planned. The difference is what
    // happens next: `summarise()` asks for prose, this asks for either more
    // calls or prose, so the loop can keep going.
    const messages: LlmMessage[] = [
      ...toConversationMessages(request.history),
      { role: 'user', text: request.task.instruction },
    ];
    for (const step of request.completedSteps) {
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
      text:
        `Those calls have run, and you can now see their real results above — including anything you ` +
        `could not have known before they ran, such as an element reference, a tree hash, or an id from ` +
        `a search. Look at what you now know:\n\n` +
        `  - If the task needs more tool calls, make them now using those real results. Never guess a ` +
        `value that a result above already gave you.\n` +
        `  - If the task is now fully accomplished, do not call any tool at all: reply in plain text ` +
        `saying only that it can now be treated as done — a separate step writes the actual report to ` +
        `the user from these results, so do not compose that here.`,
    });

    const system = this.buildSystemPrompt(request.mode, 'continue', request.referents);
    const budget = this.checkContextBudget(system, messages, tools, config);
    if (budget) return budget;

    this.deps.logger.debug('continuing', {
      model: route.model,
      routing: route.reason,
      tools: tools.length,
      completedSteps: request.completedSteps.length,
    });

    return this.converse({ request, messages, system, route, tools, config, phase: 'continue' });
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
      text: 'Now report back on that, using those results. Do not describe the steps.',
    });

    // Routed to the fast model: this turn has no decisions in it, only phrasing
    // of facts already gathered, and it sits between the user and the answer —
    // so latency here is felt directly.
    const route = this.deps.router.select({ kind: 'summarise' });

    try {
      const response = await this.deps.provider.generate({
        model: route.model,
        system: [
          `You are SAMIX Agent reporting back to the person who asked, in one or two short`,
          `sentences of plain prose.`,
          ``,
          `First decide which kind of instruction you are reporting on:`,
          ``,
          `  - They asked for INFORMATION ("what is my CPU?", "find my latest PDF") — answer the`,
          `    question directly from the tool results.`,
          `  - They asked you to DO something ("open Notepad", "close it", "copy that file") —`,
          `    say what was done, naming the specific thing acted on. There is no question to`,
          `    answer here, so never report that you could not find one.`,
          ``,
          `In both cases:`,
          ``,
          `  - State only what the results actually show. Never add, estimate or infer a fact that`,
          `    is not in them, and never fill a gap with something plausible.`,
          `  - If they asked for information and the results do not contain it, name the specific`,
          `    thing you could not determine — "I could not find out X". Never comment on the`,
          `    results themselves; "the results do not answer the question" tells the reader`,
          `    nothing they can act on.`,
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
    phase: 'plan' | 'recover' | 'continue';
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

      // ---- the model wants to offer rather than act -------------------------
      // Checked after `ask_user` — a model that is both unsure and full of ideas
      // must resolve the ambiguity first — and before real calls, so an offer is
      // never executed alongside the work it was only proposing.
      const offer = response.toolCalls.find((call) => call.name === PROPOSE_ACTION_FUNCTION);
      if (offer && phase !== 'recover') {
        const proposal = this.parseProposal(offer, request.mode);
        if (proposal) return proposal;
        // An unparseable offer is not worth a repair round-trip: the model was
        // not going to act this turn anyway, so its prose is the honest outcome.
        return {
          kind: 'reply',
          message: response.text.trim() || 'I have a suggestion, but I could not phrase it as an action.',
        };
      }

      const realCalls = response.toolCalls.filter((call) => !CONTROL_FUNCTIONS.has(call.name));

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

  /**
   * Turn a `propose_action` call into a stored offer, or reject it.
   *
   * Held to exactly the same standard as a call the model wanted to run now:
   * the tool must exist in this mode and the arguments must satisfy its real Zod
   * schema. That is the point — the whole value of a stored proposal is that
   * agreeing to it later skips re-planning, so it must be as trustworthy at
   * storage time as an executed call is at execution time. A proposal validated
   * loosely would be a way to smuggle an unvalidated call past the planner and
   * into the next turn.
   */
  private parseProposal(call: LlmToolCall, mode: AgentMode): PlanResult | undefined {
    const parsedArgs = ProposeArgs.safeParse(call.input);
    if (!parsedArgs.success) return undefined;
    const { offer, tool: toolName, arguments: rawArguments } = parsedArgs.data;

    let input: unknown;
    try {
      input = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
    } catch {
      this.deps.logger.warn('proposed action had unparseable arguments', { tool: toolName });
      return undefined;
    }

    const validated = this.validateCalls([{ id: call.id, name: toolName, input }], mode);
    if (validated.problems.length > 0 || !validated.steps[0]) {
      this.deps.logger.warn('rejected a proposed action', {
        tool: toolName,
        problems: validated.problems,
      });
      return undefined;
    }

    return { kind: 'propose', message: offer, step: validated.steps[0] };
  }

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

  private buildSystemPrompt(
    mode: AgentMode,
    phase: 'plan' | 'recover' | 'continue',
    referents: PlanRequest['referents'] = {},
  ): string {
    const tools = this.deps.registry.describe(mode);
    const now = this.now();
    const observed = describeReferents(referents);

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
      `Your only job is to decide which tools to call. You never perform actions yourself — a separate`,
      `execution layer runs each call, checks that it actually worked, and asks the user to confirm`,
      `anything risky.`,
      phase === 'continue'
        ? `The calls you made earlier in this task are shown below along with their real results: you are`
        : `You do not see a call's result in the same turn you make it — the results of anything you call`,
      phase === 'continue'
        ? `seeing what actually happened, not planning blind.`
        : `now will be shown to you afterwards, in a later turn, if there is more to decide.`,
      ``,
      `Current context`,
      `  local time: ${now.toISOString()}`,
      `  platform:   ${process.platform}`,
      `  agent mode: ${mode}`,
      ...(observed
        ? [
            ``,
            `What the user's words probably point at (observed during earlier steps, not guessed):`,
            observed,
          ]
        : []),
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
      `7. Earlier turns of this conversation are shown above, and they are yours. Resolve "it",`,
      `   "that", "this one" and "do it then" against them and against the observed context above,`,
      `   instead of asking what the user means. Only ask when neither settles it. Note the dialogue`,
      `   is memory, not a record of the machine's current state: re-check anything that may have`,
      `   changed since.`,
      `8. "This window", "this app" and "the current window" mean whatever the user is looking at on`,
      `   their own screen — never this agent's own window. Read the active window with a tool rather`,
      `   than assuming.`,
      `9. Use ${PROPOSE_ACTION_FUNCTION} when you want to suggest something the user has not asked for`,
      `   yet, rather than describing the suggestion in prose. Prose offers are forgotten; a proposal`,
      `   is remembered, so "yes, do that" next turn runs exactly what you offered. Never use it for`,
      `   work already asked for — call the tool.`,
      ...(phase === 'recover'
        ? [
            `10. A step has just failed. Read the error code and change your approach; repeating the`,
            `   identical call will fail identically. If nothing sensible remains, say so in plain`,
            `   text — that is a valid and useful answer, and better than a plan you do not believe in.`,
          ]
        : []),
      ...(phase === 'continue'
        ? [
            `10. Some steps have already run this task; their real results are shown above. Use those`,
            `   results directly — an element reference, a tree hash, an id from a search — never a`,
            `   value you are inferring or recalling from the instruction. If the task is fully done,`,
            `   call no tool and say only that it is done; a later step writes the actual report.`,
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
  private fromProviderError(cause: unknown, phase: 'plan' | 'recover' | 'continue'): PlanResult {
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

/** Longest prior reply replayed verbatim. Older turns matter less than the current one. */
const MAX_HISTORY_REPLY = 320;

/**
 * Replay earlier exchanges as alternating turns.
 *
 * The tool names are appended to the model's own turn rather than sent as
 * `toolCalls`, on purpose. A real `toolCalls` turn must be followed by a matching
 * tool-result turn or the provider rejects the conversation as malformed, and
 * replaying full results is exactly the unbounded growth this is avoiding.
 * Naming the tools in prose gives the model what it needs to resolve "close it"
 * — which application it opened — at a fraction of the size.
 */
function toConversationMessages(history: readonly ConversationTurn[]): LlmMessage[] {
  const messages: LlmMessage[] = [];

  for (const turn of history) {
    messages.push({ role: 'user', text: turn.instruction });

    const used = [...new Set(turn.tools)];
    const note = used.length > 0 ? ` [used: ${used.join(', ')}]` : '';
    const reply =
      turn.reply.length > MAX_HISTORY_REPLY
        ? `${turn.reply.slice(0, MAX_HISTORY_REPLY - 1)}…`
        : turn.reply;

    messages.push({ role: 'model', text: `${reply}${note}` });
  }

  return messages;
}

const AskUserArgs = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
});

const ProposeArgs = z.object({
  offer: z.string().min(1),
  tool: z.string().min(1),
  /** JSON text; see PROPOSE_ACTION_DECLARATION for why it is not an object. */
  arguments: z.string(),
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
