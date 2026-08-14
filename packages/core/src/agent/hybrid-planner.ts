import type { Logger } from '../observability/logger.js';
import type { PlanRequest, PlanResult, Planner, RecoveryRequest } from './planner.js';

/**
 * Chooses between the LLM planner and the deterministic one, per turn.
 *
 * ## The problem it solves
 *
 * The API key lives in the secret store, and reading it is asynchronous, but the
 * composition root is synchronous — so the runtime cannot know at construction
 * time whether an LLM is available. Two bad options were available and rejected:
 *
 *  - Make `createRuntime` async. That ripples through `main.ts`, the smoke test
 *    and every test, to answer a question that can change later anyway.
 *  - Always build the LLM planner. Then a first run with no key configured
 *    answers every instruction with "the AI provider rejected the API key",
 *    which reads as broken rather than as unconfigured.
 *
 * Deciding per turn is also simply more correct: the user can paste a key into
 * Settings and have the very next instruction be planned by Gemini, with no
 * restart. Equally, if the key is removed the agent degrades to rule-based
 * behaviour instead of failing.
 *
 * ## Fallback is never silent
 *
 * Every fallback is logged, and `RuleBasedPlanner` already tells the user
 * plainly what it can and cannot do. An agent that quietly got stupider would be
 * worse than one that says so (spec §93).
 */
export class HybridPlanner implements Planner {
  readonly name: string;

  constructor(
    private readonly deps: {
      readonly llm: Planner;
      readonly fallback: Planner;
      /** Resolves true when an API key is configured. Consulted every turn. */
      readonly hasCredentials: () => Promise<boolean>;
      readonly logger: Logger;
    },
  ) {
    this.name = `${deps.llm.name}, falling back to ${deps.fallback.name}`;
  }

  async plan(request: PlanRequest): Promise<PlanResult> {
    return (await this.active()).plan(request);
  }

  async recover(request: RecoveryRequest): Promise<PlanResult> {
    const planner = await this.active();
    if (!planner.recover) {
      return { kind: 'give-up', reason: 'No recovery strategy is available.' };
    }
    return planner.recover(request);
  }

  private async active(): Promise<Planner> {
    let available = false;
    try {
      available = await this.deps.hasCredentials();
    } catch (cause) {
      // A secret store that throws must not take the agent down with it; the
      // deterministic planner still does useful work.
      this.deps.logger.warn('could not read LLM credentials', { error: String(cause) });
    }

    if (available) return this.deps.llm;

    this.deps.logger.info('no LLM credentials configured; using the deterministic planner');
    return this.deps.fallback;
  }
}
