import type { ToolLogger } from '@samix/shared';
import {
  isValidHandle,
  type ActiveWindow,
  type WindowInfo,
} from '../windows/ui-automation.js';
import type { WindowAutomation } from '../windows/tools.js';
import type { DesktopSidecar } from './sidecar.js';

/**
 * The four window operations, over the sidecar, with the PowerShell path behind
 * them (Phase 7 §8 step 2).
 *
 * ## This is a port, not a redesign
 *
 * `window.list`, `window.focus`, `window.close` and `screen.getActiveWindow`
 * already work. Their names, schemas, confirmation behaviour and verification
 * behaviour are fixed, and the tools themselves are not touched by this file —
 * they take a `WindowAutomation` by injection and neither knows nor cares which
 * implementation it got.
 *
 * So the only thing that changes is how long a call takes: several seconds of
 * PowerShell startup and C# compilation per call, against one round trip to a
 * process that is already running.
 *
 * ## Where the substitution rule lives
 *
 * `active()` decides whether the foreground window is the agent's own and, if it
 * is, reports the window behind it and says that it did. That rule is
 * implemented here, once, over data both back ends return in the same shape —
 * rather than in each of them. It is the rule that stops "close this window"
 * closing the agent, and two copies of it is one copy too many.
 *
 * ## Falling back is per call, not per session
 *
 * Any failure from the sidecar — it would not start, it crashed, it timed out —
 * falls through to PowerShell for that call and logs once. It is not latched:
 * the sidecar may be perfectly healthy on the next call, and a transient failure
 * should not condemn the session to five-second window queries. The one latched
 * case is `DesktopSidecar` marking itself `degraded` after its respawn ceiling,
 * which this checks before even trying.
 *
 * Domain answers are NOT failures and never trigger a fallback. Focusing a
 * window that has since closed returns `{focused: false, reason: 'no-such-window'}`
 * from both back ends; only transport-level problems are errors.
 */

export type WindowPath = 'sidecar' | 'powershell';

export interface WindowAutomationStatus {
  /** Which implementation served the most recent call. */
  readonly path: WindowPath;
  /** True once a sidecar call has fallen back at least once this session. */
  readonly everFellBack: boolean;
  readonly detail: string;
}

export interface ResilientWindowAutomation extends WindowAutomation {
  status(): WindowAutomationStatus;
}

export interface ResilientOptions {
  readonly sidecar: DesktopSidecar;
  /** The existing PowerShell implementation. */
  readonly fallback: WindowAutomation;
  readonly logger: ToolLogger;
  /** Per-call budget for the sidecar before it is abandoned for PowerShell. */
  readonly timeoutMs?: number;
  /**
   * Called when the serving implementation changes, so `/status` can say which
   * path window management is actually on.
   *
   * A callback rather than something the runtime polls: the answer only changes
   * when a call is made, and nothing about this subsystem should cost anything
   * while the agent is idle.
   */
  readonly onPathChange?: (status: WindowAutomationStatus) => void;
}

/** Shapes the sidecar returns. Validated structurally, never trusted. */
interface RawWindow {
  handle?: unknown;
  title?: unknown;
  processId?: unknown;
  processName?: unknown;
  isActive?: unknown;
  isMinimized?: unknown;
  isOwn?: unknown;
}

function toWindow(value: unknown): WindowInfo | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as RawWindow;
  const handle = Number(raw.handle);
  if (!isValidHandle(handle)) return undefined;
  return {
    handle,
    title: typeof raw.title === 'string' ? raw.title : '',
    processId: Number(raw.processId) || 0,
    processName: typeof raw.processName === 'string' ? raw.processName : '',
    isActive: raw.isActive === true,
    isMinimized: raw.isMinimized === true,
    isOwn: raw.isOwn === true,
  };
}

function toWindows(value: unknown): WindowInfo[] {
  if (!Array.isArray(value)) return [];
  return value.map(toWindow).filter((window): window is WindowInfo => window !== undefined);
}

/**
 * Decide what "the window the user is looking at" means, given every window and
 * whichever one currently holds the foreground.
 *
 * Exported because it is the rule, and a rule worth testing directly rather than
 * only through whichever back end happens to be installed.
 */
export function resolveActive(
  windows: readonly WindowInfo[],
  active: WindowInfo | undefined,
): ActiveWindow | undefined {
  if (active && !active.isOwn) return { window: active, substituted: false };
  // z-ordered, so the first window that is not ours is the one immediately
  // behind the agent's.
  const behind = windows.find((window) => !window.isOwn);
  if (!behind) return undefined;
  return { window: behind, substituted: true };
}

/** `WindowAutomation` served entirely by the sidecar. */
export function createSidecarWindowAutomation(
  sidecar: DesktopSidecar,
  timeoutMs = 8_000,
): WindowAutomation {
  const call = <T>(op: string, params: Record<string, unknown> = {}): Promise<T> =>
    sidecar.call<T>(op, params, timeoutMs);

  const exists = async (handle: number): Promise<boolean> => {
    const result = await call<{ exists?: boolean }>('window.exists', { handle });
    return result.exists === true;
  };

  return {
    async list(): Promise<WindowInfo[]> {
      const result = await call<{ windows?: unknown }>('window.list');
      return toWindows(result.windows);
    },

    async active(): Promise<ActiveWindow | undefined> {
      const result = await call<{ windows?: unknown; active?: unknown }>('window.active');
      return resolveActive(toWindows(result.windows), toWindow(result.active));
    },

    async focus(handle: number): Promise<{ focused: boolean; active: WindowInfo | undefined }> {
      const result = await call<{ focused?: boolean; active?: unknown }>('window.focus', { handle });
      return { focused: result.focused === true, active: toWindow(result.active) };
    },

    async close(handle: number): Promise<{ requested: boolean; reason?: string }> {
      const result = await call<{ requested?: boolean; reason?: string }>('window.close', { handle });
      return {
        requested: result.requested === true,
        ...(result.reason ? { reason: result.reason } : {}),
      };
    },

    /**
     * Wait for a window to disappear, or give up.
     *
     * Polls, deliberately, and identically to the PowerShell path: a graceful
     * close is not instantaneous, and a single check after a fixed delay reports
     * "still open" for windows that were closing perfectly well. This is bounded
     * work inside one task, not the idle polling the sidecar design forbids.
     */
    async waitForClose(handle: number, timeout = 6_000): Promise<boolean> {
      const deadline = Date.now() + timeout;
      for (;;) {
        if (!(await exists(handle))) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    },
  };
}

/** The sidecar, with the PowerShell implementation behind it. */
export function createResilientWindowAutomation(
  options: ResilientOptions,
): ResilientWindowAutomation {
  const { sidecar, fallback, logger } = options;
  const fast = createSidecarWindowAutomation(sidecar, options.timeoutMs ?? 8_000);

  let path: WindowPath = 'sidecar';
  let everFellBack = false;
  let detail = 'not used yet';
  let announced = '';

  const status = (): WindowAutomationStatus => ({ path, everFellBack, detail });

  function announce(): void {
    const summary = `${path}:${detail}`;
    if (summary === announced) return;
    announced = summary;
    options.onPathChange?.(status());
  }

  async function via<T>(
    op: string,
    quick: () => Promise<T>,
    slow: () => Promise<T>,
  ): Promise<T> {
    if (sidecar.isUsable()) {
      try {
        const value = await quick();
        path = 'sidecar';
        detail = sidecar.status().detail;
        announce();
        return value;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // Logged at warn the first time and debug afterwards: a sidecar that is
        // genuinely absent would otherwise write a warning for every window
        // query for the rest of the session.
        const log = everFellBack ? logger.debug : logger.warn;
        log.call(logger, 'window query fell back to PowerShell', { op, reason: message });
        everFellBack = true;
        detail = `PowerShell — the sidecar failed: ${message}`;
      }
    } else {
      detail = `PowerShell — ${sidecar.status().detail}`;
    }
    path = 'powershell';
    announce();
    return slow();
  }

  return {
    list: () => via('window.list', () => fast.list(), () => fallback.list()),
    active: () => via('window.active', () => fast.active(), () => fallback.active()),
    focus: (handle) => via('window.focus', () => fast.focus(handle), () => fallback.focus(handle)),
    close: (handle) => via('window.close', () => fast.close(handle), () => fallback.close(handle)),
    waitForClose: (handle) =>
      via('window.exists', () => fast.waitForClose(handle), () => fallback.waitForClose(handle)),
    status,
  };
}
