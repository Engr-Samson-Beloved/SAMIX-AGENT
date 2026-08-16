/**
 * Classify a whole instruction as an answer to something the agent just offered
 * (spec §80).
 *
 * ## Why this is not a job for the LLM
 *
 * It could be, and the planner already gets the conversation history. But the
 * failure this fixes — "yes do that then" coming back as a request for
 * clarification — is a *planning* failure, and asking the same planner to
 * recognise its own offer is asking it to be reliable at exactly the thing it
 * was observed being unreliable at. A structured proposal plus a deterministic
 * yes/no test removes the model from the loop entirely for the one turn where
 * removing it is cheap and obviously correct.
 *
 * ## Why it is deliberately narrow
 *
 * Resolving an affirmative *executes a stored tool call without re-planning*.
 * That is only safe if the utterance carries no new information, so the test is
 * whole-string and allow-listed rather than a keyword search: every token must
 * be an affirmative or a filler word, and at least one must be a real
 * affirmative. Anything else — "yes, but use Firefox", "yes and then close it" —
 * falls through to the planner, which is the outcome that can handle new
 * content.
 *
 * Getting this wrong in the permissive direction means running a stored action
 * for an instruction that meant something else. Getting it wrong in the strict
 * direction means one extra planning round-trip. The asymmetry decides the
 * design.
 */

export type Response = 'affirmative' | 'negative' | 'other';

/**
 * Words that carry the agreement. At least one must be present, so a bare
 * "please" or "then" is not treated as consent to run something.
 */
const AFFIRMATIVE_CORE: ReadonlySet<string> = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'ya',
  'sure',
  'ok',
  'okay',
  'okey',
  'alright',
  'aight',
  'absolutely',
  'definitely',
  'certainly',
  'affirmative',
  'confirmed',
  'confirm',
  'proceed',
  'continue',
  'correct',
  'right',
  'exactly',
  'indeed',
  'agreed',
]);

/**
 * Words that may accompany an affirmative without changing what was agreed to.
 *
 * Note what is *absent*: no verbs that name an action ("open", "send",
 * "delete"), no nouns, no adjectives. "yes open chrome" is therefore not an
 * affirmative — it is a new instruction that happens to start with "yes", and it
 * must reach the planner so the named application is the one that opens.
 */
const FILLER: ReadonlySet<string> = new Set([
  'do',
  'does',
  'that',
  'this',
  'it',
  'them',
  'those',
  'the',
  'thing',
  'one',
  'then',
  'now',
  'please',
  'pls',
  'plz',
  'go',
  'ahead',
  'on',
  'for',
  'me',
  'us',
  'and',
  'so',
  'lets',
  'let',
  'we',
  'you',
  'can',
  'could',
  'would',
  'will',
  'thanks',
  'thank',
  'cheers',
  'good',
  'great',
  'fine',
  'cool',
  'perfect',
  'i',
  'my',
  'a',
  'to',
  'be',
  'is',
]);

const NEGATIVE_CORE: ReadonlySet<string> = new Set([
  'no',
  'nope',
  'nah',
  'never',
  'dont',
  'don',
  'cancel',
  'stop',
  'abort',
  'forget',
  'nevermind',
  'skip',
  'leave',
  'wait',
  'hold',
  'not',
]);

/** Longest utterance considered. A sentence this long is carrying new content. */
const MAX_TOKENS = 8;

/**
 * Decide whether an instruction is a plain yes, a plain no, or something else.
 *
 * Apostrophes are stripped rather than split on, so "don't" becomes one token
 * `dont` and matches the negative list; splitting would produce `don` + `t` and
 * leak a stray token that fails the all-tokens-known test for the wrong reason.
 */
export function classifyResponse(instruction: string): Response {
  const tokens = instruction
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z]+/)
    .filter((token) => token !== '');

  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return 'other';

  // Negatives are checked first and are allowed to appear anywhere: "yeah no,
  // don't" is a refusal, and reading it as consent is the expensive mistake.
  if (tokens.some((token) => NEGATIVE_CORE.has(token))) return 'negative';

  let sawCore = false;
  for (const token of tokens) {
    if (AFFIRMATIVE_CORE.has(token)) {
      sawCore = true;
      continue;
    }
    if (!FILLER.has(token)) return 'other';
  }

  // "do it" and "go ahead" carry agreement without any word from the core list.
  if (!sawCore) {
    const joined = tokens.join(' ');
    if (/\b(do|go)\b/.test(joined) && /\b(it|that|this|ahead|on|them)\b/.test(joined)) {
      sawCore = true;
    }
  }

  return sawCore ? 'affirmative' : 'other';
}
