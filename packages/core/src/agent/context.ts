import type { TaskStep } from '@samix/shared';

/**
 * Conversational context that outlives a single task (spec §53, §61, §80).
 *
 * The orchestrator is single-flight and every task is planned from scratch, so
 * without something like this the agent forgets, between one instruction and the
 * next, both what it offered to do and what it just acted on. Two concrete
 * failures came from that gap:
 *
 *  - The agent says "I can open that in Chrome if you like", the user says
 *    "yes do that then", and the next turn — having only prose to work from —
 *    asks what they meant. Fixed by {@link pendingProposal}: an offer is stored
 *    as the *structured call it would have made*, so agreement runs the exact
 *    thing that was offered rather than something re-derived from a sentence.
 *  - "Close this window" resolves to nothing, or worse to the agent's own
 *    console. Fixed by {@link referents}: the last application, window, page and
 *    path the agent actually touched.
 *
 * This is deliberately **in-memory and small**. Durable memory is Phase 9; the
 * job here is to make the current session coherent, not to remember yesterday.
 */

/**
 * An action the agent described but did not run.
 *
 * The structured `tool` + `input` pair is the whole point. Storing the offer as
 * text would mean re-planning it on agreement, which can produce a *different*
 * action from the one the user said yes to — the failure mode that makes
 * confirmation meaningless.
 */
export interface PendingProposal {
  readonly tool: string;
  readonly input: unknown;
  /** The sentence the user was shown. Replayed if they agree, so they see the same words. */
  readonly offer: string;
  /** Short step label, used in the plan and the timeline. */
  readonly description: string;
  /** The task that made the offer, for the audit trail. */
  readonly taskId: string;
  readonly offeredAt: number;
}

/**
 * How long an offer stays answerable.
 *
 * Long enough that a user who wandered off mid-thought still lands on the thing
 * they were told about; short enough that a stray "sure" an hour later does not
 * launch something they have forgotten was ever suggested.
 */
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;

/** Things "it", "that", "this window" and "there" can point at (spec §80). */
export interface Referents {
  /** Last application named in a successful step, as the user would say it. */
  readonly app?: string;
  /** Last window the agent focused or reported on. */
  readonly window?: { readonly handle: number; readonly title: string };
  /** Last web page the browser session was driven to. */
  readonly url?: string;
  /** Last file or directory acted on. */
  readonly path?: string;
}

export class AgentContext {
  private proposal: PendingProposal | undefined;
  private mutableReferents: Referents = {};

  constructor(private readonly now: () => number = Date.now) {}

  // -------------------------------------------------------------------------
  // Pending proposals
  // -------------------------------------------------------------------------

  /** The live offer, or undefined if there is none or it has expired. */
  get pendingProposal(): PendingProposal | undefined {
    if (!this.proposal) return undefined;
    if (this.now() - this.proposal.offeredAt > PROPOSAL_TTL_MS) {
      this.proposal = undefined;
      return undefined;
    }
    return this.proposal;
  }

  propose(proposal: Omit<PendingProposal, 'offeredAt'>): void {
    this.proposal = { ...proposal, offeredAt: this.now() };
  }

  clearProposal(): void {
    this.proposal = undefined;
  }

  /**
   * Read the offer and consume it in one operation.
   *
   * Consuming matters: an offer that survived being accepted could be accepted
   * again by the next stray "ok", running the same action twice. One offer, one
   * answer.
   */
  takeProposal(): PendingProposal | undefined {
    const proposal = this.pendingProposal;
    this.proposal = undefined;
    return proposal;
  }

  // -------------------------------------------------------------------------
  // Referents
  // -------------------------------------------------------------------------

  get referents(): Referents {
    return { ...this.mutableReferents };
  }

  note(patch: Referents): void {
    // Undefined must not erase a known referent: a step that touches a file
    // should not make the agent forget which window it was working in.
    const next: Referents = { ...this.mutableReferents };
    if (patch.app !== undefined) (next as { app?: string }).app = patch.app;
    if (patch.window !== undefined) (next as { window?: Referents['window'] }).window = patch.window;
    if (patch.url !== undefined) (next as { url?: string }).url = patch.url;
    if (patch.path !== undefined) (next as { path?: string }).path = patch.path;
    this.mutableReferents = next;
  }

  /**
   * Learn what a completed step was about.
   *
   * Reads the step's **input** for names the user would recognise and its
   * **result** for facts only execution could know (the URL a redirect actually
   * landed on, the window handle that was focused). Deliberately driven by tool
   * name here rather than by each tool reporting its own referents: a tool that
   * forgot to would silently degrade pronoun resolution, and this file is where
   * someone looks when "close it" closes the wrong thing.
   */
  observe(step: TaskStep): void {
    if (step.status !== 'succeeded' && step.status !== 'succeeded_unverified') return;

    const input = asRecord(step.input);
    const data = asRecord(step.result?.data);
    const [namespace] = step.tool.split('.');

    switch (namespace) {
      case 'app': {
        // `app.list` names nothing in particular; only acting on one app counts.
        if (step.tool === 'app.list') break;
        const name = str(data['app']) ?? str(input['name']);
        if (name) this.note({ app: name });
        break;
      }
      case 'window':
      case 'screen': {
        const handle = num(data['handle']);
        const title = str(data['title']);
        if (handle !== undefined && title !== undefined) {
          this.note({ window: { handle, title } });
        }
        const app = str(data['processName']) ?? str(data['app']);
        if (app) this.note({ app });
        break;
      }
      case 'browser': {
        const url = str(data['url']);
        if (url) this.note({ url });
        break;
      }
      case 'filesystem': {
        const path =
          str(data['path']) ??
          str(data['destination']) ??
          str(input['destination']) ??
          str(input['path']);
        if (path) this.note({ path });
        break;
      }
      default:
        break;
    }
  }

  /** Forget everything. Used when the user explicitly starts over. */
  reset(): void {
    this.proposal = undefined;
    this.mutableReferents = {};
  }
}

/**
 * Build the short context block shown to the planner.
 *
 * Kept to one line per known referent, and omitted entirely when nothing is
 * known, because an empty "Recent context:" header is tokens spent teaching the
 * model that this section is usually noise.
 */
export function describeReferents(referents: Referents): string | undefined {
  const lines: string[] = [];
  if (referents.app) lines.push(`  last application acted on: ${referents.app}`);
  if (referents.window) lines.push(`  last window: "${referents.window.title}"`);
  if (referents.url) lines.push(`  last web page: ${referents.url}`);
  if (referents.path) lines.push(`  last file or folder: ${referents.path}`);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
