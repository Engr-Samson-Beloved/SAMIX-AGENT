import type { LlmConfig } from '@samix/shared';

/**
 * Model routing (spec §63, §91).
 *
 * ## Why this is not a cosmetic setting
 *
 * `pnpm check:gemini` measured, on this project's key, against a realistic tool
 * schema:
 *
 *   gemini-3.6-flash        2849ms
 *   gemini-3.5-flash-lite    712ms
 *
 * Spec §91 wants simple command planning under two seconds. The planner model
 * does not meet that; the fast model beats it by a factor of three. So the
 * `plannerModel`/`fastModel` split in config only buys anything if something
 * actually routes between them, and that something is this file.
 *
 * ## The bias, stated explicitly
 *
 * Routing down is a bet that a weaker model will plan a task correctly. Routing
 * up costs two seconds. Those are not symmetric when the agent is about to move
 * the user's files, so the router **defaults to the strong model** and steps
 * down only for instructions it can positively recognise as simple. An unclear
 * case is a strong-model case.
 *
 * ## Not an LLM call
 *
 * The classification is lexical and synchronous. Asking a model which model to
 * ask would add a round trip to every turn and spend most of the latency the
 * routing was meant to save.
 */

export type TurnKind =
  /** First planning turn for a new instruction. */
  | 'plan'
  /** Re-planning after a step failed (spec §30). */
  | 'recover'
  /** Interpreting a screenshot (Phase 11). */
  | 'vision'
  /** Writing the final answer from results already gathered (spec §77, REPORT). */
  | 'summarise'
  /** Cheap yes/no or labelling turn with no consequences. */
  | 'classify';

export interface RouteRequest {
  readonly kind: TurnKind;
  /** The user's words. Only consulted for `plan`. */
  readonly instruction?: string;
  /** Prior turns in this task. Any history at all implies a multi-step task. */
  readonly historyLength?: number;
}

export interface Route {
  readonly model: string;
  /** Why this model was chosen. Logged, and shown in the task detail pane. */
  readonly reason: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
}

/**
 * Words that mean the instruction is not a single action.
 *
 * Kept as whole-word patterns rather than substrings: "android" contains "and",
 * and matching that would push every mention of a phone up to the slow model.
 */
const COMPLEXITY_MARKERS: readonly RegExp[] = [
  /\b(and then|then|after that|afterwards|finally|next)\b/,
  /\b(for each|every|all of the|each of)\b/,
  /\b(if|unless|otherwise|in case|depending on|when it)\b/,
  /\b(compare|summari[sz]e|analy[sz]e|decide|figure out|work out|research)\b/,
  /\b(and|also|plus)\b.*\b(send|copy|move|delete|open|create|write|email|message)\b/,
];

/** Verbs whose single-clause form is a one-tool task. */
const SIMPLE_INTENTS: readonly RegExp[] = [
  /^(what|who|when|where|which|how much|how many)\b/,
  /^(show|list|tell me|find|search for|look up|check)\b/,
  /^(open|launch|start|close|quit)\b/,
  /^(hi|hello|hey|thanks|thank you)\b/,
  /\b(status|mode|version|uptime|which tools)\b/,
];

/** Above this many words, an instruction is treated as multi-part regardless. */
const SIMPLE_WORD_LIMIT = 12;

export class ModelRouter {
  constructor(private readonly config: () => LlmConfig) {}

  select(request: RouteRequest): Route {
    const llm = this.config();

    switch (request.kind) {
      case 'vision':
        return {
          model: llm.visionModel,
          reason: 'vision turn',
          temperature: 0,
          maxOutputTokens: llm.maxOutputTokens,
        };

      case 'summarise':
        return {
          model: llm.fastModel,
          // No decisions are made in this turn — the facts are already gathered
          // and verified, and all that remains is phrasing them. It also sits
          // directly between the user and their answer, so its latency is the
          // part they feel.
          reason: 'phrasing gathered results; fast model',
          temperature: 0,
          // Enough for a couple of sentences. A cap here also stops a model
          // that starts narrating from turning a one-line answer into an essay.
          maxOutputTokens: 512,
        };

      case 'classify':
        return {
          model: llm.fastModel,
          // Classification has no side effects — a wrong label is re-derivable,
          // so the cheap model is the right default here rather than a gamble.
          reason: 'classification has no consequences; fast model',
          temperature: 0,
          maxOutputTokens: 256,
        };

      case 'recover':
        return {
          model: llm.plannerModel,
          // Recovery is the hardest reasoning the agent does: something already
          // went wrong, and a weak re-plan tends to repeat the failure.
          reason: 'recovery reasoning always uses the planner model',
          temperature: 0.1,
          maxOutputTokens: llm.maxOutputTokens,
        };

      case 'plan': {
        const verdict = classifyInstruction(request.instruction ?? '', request.historyLength ?? 0);
        return {
          model: verdict.simple ? llm.fastModel : llm.plannerModel,
          reason: verdict.reason,
          // Planning is not a creative task. Determinism makes the agent
          // debuggable and makes the same instruction behave the same twice.
          temperature: 0,
          maxOutputTokens: llm.maxOutputTokens,
        };
      }
    }
  }
}

export interface InstructionVerdict {
  readonly simple: boolean;
  readonly reason: string;
}

/**
 * Decide whether an instruction is a single, self-contained action.
 *
 * Exported for testing, because this heuristic is the whole of the routing
 * decision and it is the part most likely to need tuning against real usage.
 */
export function classifyInstruction(instruction: string, historyLength = 0): InstructionVerdict {
  const text = instruction.toLowerCase().trim();

  if (text === '') return { simple: false, reason: 'empty instruction; planner model' };

  if (historyLength > 0) {
    // A follow-up turn depends on context the fast model handles worse, and by
    // then the task is already multi-step by definition.
    return { simple: false, reason: 'continuing an existing task; planner model' };
  }

  const words = text.split(/\s+/).length;
  if (words > SIMPLE_WORD_LIMIT) {
    return { simple: false, reason: `instruction is ${words} words; planner model` };
  }

  // More than one sentence is more than one request.
  if (/[.!?]\s+\S/.test(instruction.trim())) {
    return { simple: false, reason: 'instruction has multiple sentences; planner model' };
  }

  for (const marker of COMPLEXITY_MARKERS) {
    if (marker.test(text)) {
      return { simple: false, reason: 'instruction chains or conditions actions; planner model' };
    }
  }

  for (const intent of SIMPLE_INTENTS) {
    if (intent.test(text)) {
      return { simple: true, reason: 'single-clause instruction; fast model' };
    }
  }

  // Recognisably short, but not a shape we have positively identified. The
  // asymmetry in the header applies: pay the latency rather than the mistake.
  return { simple: false, reason: 'instruction shape not recognised as simple; planner model' };
}
