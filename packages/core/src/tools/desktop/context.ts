import type { ActionTarget } from '@samix/shared';
import type { Snapshot, SnapshotElement } from './protocol.js';

/**
 * What the agent last saw in each window (Phase 7 §5).
 *
 * ## Why this exists
 *
 * `AgentTool.describeTarget` is synchronous, because a permission decision must
 * not depend on a round trip that can hang or time out. But the question it has
 * to answer — "which application, and what does the button say?" — is about the
 * user's screen.
 *
 * The reconciliation is that the question has *already been answered*. A `ref`
 * is meaningless without the snapshot that produced it, so by the time any
 * action can be attempted, the window has been read. This records what that read
 * saw, and `describeTarget` answers from it.
 *
 * ## A miss is not permission
 *
 * If nothing is remembered for a handle, `describe()` returns an empty target
 * and the engine treats it as the least trusted case: unknown application,
 * confirm. That is the only safe direction. A cache that answered "no target
 * information, carry on" would turn every missed lookup into a skipped prompt,
 * and cache misses are exactly what happens when something unexpected is going
 * on.
 *
 * ## Bounded and short-lived
 *
 * Entries expire, and only a handful are kept. A snapshot is a description of a
 * moment; one from ten minutes ago describes a window that has almost certainly
 * moved on, and answering a security question from it would be worse than
 * admitting ignorance.
 */

export interface RememberedElement {
  readonly ref: number;
  readonly name: string;
  readonly role: string;
  readonly patterns: readonly string[];
  readonly enabled: boolean;
}

export interface RememberedWindow {
  readonly handle: number;
  readonly title: string;
  readonly processName: string;
  readonly processId: number;
  readonly isOwn: boolean;
  /** Structure hash of the snapshot this was built from. */
  readonly tree: string;
  readonly elements: ReadonlyMap<number, RememberedElement>;
  readonly at: number;
}

/** How long a remembered snapshot may inform a permission decision. */
export const CONTEXT_TTL_MS = 2 * 60_000;

/** How many windows to remember. Small on purpose; this is not a data store. */
const MAX_WINDOWS = 8;

export class DesktopContext {
  private readonly windows = new Map<number, RememberedWindow>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Record what a snapshot or search saw. */
  remember(snapshot: {
    window: Snapshot['window'];
    tree: string;
    elements: readonly SnapshotElement[];
  }): void {
    const elements = new Map<number, RememberedElement>();
    for (const element of snapshot.elements) {
      elements.set(element.ref, {
        ref: element.ref,
        name: element.name,
        role: element.role,
        patterns: element.patterns,
        enabled: element.enabled,
      });
    }

    this.windows.set(snapshot.window.handle, {
      handle: snapshot.window.handle,
      title: snapshot.window.title,
      processName: snapshot.window.processName,
      processId: snapshot.window.processId,
      isOwn: snapshot.window.isOwn === true,
      tree: snapshot.tree,
      elements,
      at: this.now(),
    });

    // Oldest out first. Map preserves insertion order, and `set` above moves a
    // re-snapshotted window to the end only if it was deleted first — which it
    // was not, so re-reading the same window does not extend its place in the
    // queue. That is fine: it is a size bound, not an LRU.
    while (this.windows.size > MAX_WINDOWS) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
  }

  /** The most recently remembered window, if anything is still fresh. */
  latest(): RememberedWindow | undefined {
    let best: RememberedWindow | undefined;
    for (const window of this.windows.values()) {
      if (this.stale(window)) continue;
      if (!best || window.at > best.at) best = window;
    }
    return best;
  }

  window(handle?: number): RememberedWindow | undefined {
    if (handle === undefined) return this.latest();
    const found = this.windows.get(handle);
    return found && !this.stale(found) ? found : undefined;
  }

  /**
   * Describe what an action would touch, for the permission engine.
   *
   * Returns `{}` — not `undefined` — when nothing is known. The difference
   * matters: `undefined` means "this tool has no target", which is right for a
   * file copy; `{}` means "this tool acts on someone's user interface and we
   * cannot say whose", which must confirm.
   */
  describe(handle: number | undefined, ref: number | undefined): ActionTarget {
    const window = this.window(handle);
    if (!window) return {};

    const target: {
      application?: string;
      elementName?: string;
      ownWindow?: boolean;
    } = { application: window.processName };
    if (window.isOwn) target.ownWindow = true;

    if (ref !== undefined) {
      const element = window.elements.get(ref);
      // A name we do not have must not become a name we invent. Leaving it
      // absent means the dangerous-word floor cannot match — which is why the
      // unknown-application rule above already forces a prompt in this case.
      if (element && element.name !== '') target.elementName = element.name;
    }

    return target;
  }

  forget(handle: number): void {
    this.windows.delete(handle);
  }

  clear(): void {
    this.windows.clear();
  }

  private stale(window: RememberedWindow): boolean {
    return this.now() - window.at > CONTEXT_TTL_MS;
  }
}
