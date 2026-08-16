import { z } from 'zod';
import {
  err,
  ok,
  verification,
  type AgentTool,
  type ToolResult,
  type Verification,
} from '@samix/shared';
import type { AppRegistry } from '../apps/app-registry.js';
import {
  closeWindow,
  focusWindow,
  getActiveWindow,
  isValidHandle,
  listWindows,
  waitForWindowToClose,
  type WindowInfo,
} from './ui-automation.js';

/**
 * Window tools (spec §13, §15, §17) — Phase 7.
 *
 * These are what make "this window", "the current window" and "close that" mean
 * anything. The design problem they solve is not the Win32 call — that is
 * `ui-automation.ts` — it is **what the user is pointing at**.
 *
 * ## The referent rule
 *
 * When no window is named, the target is:
 *
 *   1. the active window on the user's desktop, **never the agent's own**; then
 *   2. the application the agent most recently acted on.
 *
 * The exclusion in (1) is the whole point. The agent's window is very often the
 * foreground window at the moment an instruction arrives — the user just typed
 * or spoke into it — so a naive `GetForegroundWindow` makes "close this window"
 * close the agent. That is not a small bug; it is the agent destroying the
 * session in response to a routine request.
 *
 * ## Ambiguity is handled differently per tool, on purpose
 *
 * Two windows matching "chrome" is normal. For `window.focus`, which is
 * reversible and where z-order is genuinely informative, the topmost match wins.
 * For `window.close`, which is not reversible, ambiguity is refused and the
 * candidates are returned so the planner can ask (spec §21, §94). Applying one
 * rule to both would either make focusing needlessly chatty or make closing
 * dangerous.
 */

/** How the agent finds out what the user meant. Shared by focus and close. */
const TargetInput = {
  handle: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Exact window handle from window.list or screen.getActiveWindow. Most precise.'),
  title: z
    .string()
    .min(1)
    .optional()
    .describe('Part of the window title, case-insensitive, e.g. "Invoice" or "Inbox".'),
  app: z
    .string()
    .min(1)
    .optional()
    .describe('The application whose window this is, e.g. "Chrome" or "Notepad".'),
};

/** Names the agent has been given for "it" and "that" (see agent/context.ts). */
export interface WindowReferents {
  /** The application most recently acted on, as the user would name it. */
  readonly app?: string;
}

export type ReferentSource = () => WindowReferents;

/**
 * The window operations these tools need, as an interface.
 *
 * Injected rather than imported directly so the referent rules above can be
 * tested against a known desktop. Without the seam the only way to check that
 * "close this window" never picks the agent's own window would be to run
 * PowerShell against the developer's real screen and hope it had the right
 * windows on it — which is to say, not to check it at all.
 */
export interface WindowAutomation {
  list(): Promise<WindowInfo[]>;
  active(): Promise<{ window: WindowInfo; substituted: boolean } | undefined>;
  focus(handle: number): Promise<{ focused: boolean; active: WindowInfo | undefined }>;
  close(handle: number): Promise<{ requested: boolean; reason?: string }>;
  waitForClose(handle: number): Promise<boolean>;
}

/** The real thing: user32 through PowerShell. */
export const windowsAutomation: WindowAutomation = {
  list: () => listWindows(),
  active: () => getActiveWindow(),
  focus: (handle) => focusWindow(handle),
  close: (handle) => closeWindow(handle),
  waitForClose: (handle) => waitForWindowToClose(handle),
};

interface Resolution {
  readonly window: WindowInfo;
  /** Plain-language account of how this window was chosen, for the report. */
  readonly how: string;
}

interface Rejection {
  readonly code: 'WINDOW_NOT_FOUND';
  readonly message: string;
  readonly details: Record<string, unknown>;
}

function isRejection(value: Resolution | Rejection): value is Rejection {
  return 'code' in value;
}

/** Windows the user could plausibly mean: visible, titled, and not ours. */
async function candidates(uia: WindowAutomation): Promise<WindowInfo[]> {
  return (await uia.list()).filter((window) => !window.isOwn);
}

function summarise(windows: readonly WindowInfo[]): string[] {
  return windows.slice(0, 8).map((window) => `${window.title} (${window.processName})`);
}

/** Loose on purpose: `exactOptionalPropertyTypes` makes an absent field `undefined`. */
type Target = {
  readonly handle?: number | undefined;
  readonly title?: string | undefined;
  readonly app?: string | undefined;
};

async function resolveTarget(
  input: Target,
  apps: AppRegistry,
  referents: WindowReferents,
  ambiguity: 'pick-topmost' | 'refuse',
  uia: WindowAutomation,
): Promise<Resolution | Rejection> {
  const open = await candidates(uia);

  // --- 1. An exact handle ---------------------------------------------------
  if (input.handle !== undefined) {
    const match = open.find((window) => window.handle === input.handle);
    if (match) return { window: match, how: `the window you identified (${match.title})` };
    return {
      code: 'WINDOW_NOT_FOUND',
      message: `No open window has the handle ${input.handle}. It may have been closed since it was listed.`,
      details: { open: summarise(open) },
    };
  }

  // --- 2. A title fragment --------------------------------------------------
  if (input.title !== undefined) {
    const needle = input.title.toLowerCase();
    const matched = open.filter((window) => window.title.toLowerCase().includes(needle));
    const decided = decide(matched, ambiguity, `titles matching "${input.title}"`);
    if (decided) return decided;
    return {
      code: 'WINDOW_NOT_FOUND',
      message:
        matched.length === 0
          ? `No open window has "${input.title}" in its title.`
          : `${matched.length} open windows match "${input.title}", so I did not guess which you meant.`,
      details: { matched: summarise(matched), open: summarise(open) },
    };
  }

  // --- 3. An application name ----------------------------------------------
  if (input.app !== undefined) {
    const matched = await windowsOfApp(input.app, open, apps);
    const decided = decide(matched, ambiguity, `windows belonging to ${input.app}`);
    if (decided) return decided;
    return {
      code: 'WINDOW_NOT_FOUND',
      message:
        matched.length === 0
          ? `${input.app} has no open window.`
          : `${input.app} has ${matched.length} open windows, so I did not guess which you meant.`,
      details: { matched: summarise(matched), open: summarise(open) },
    };
  }

  // --- 4. Nothing named: the active window, never our own -------------------
  const active = await uia.active();
  if (active) {
    return {
      window: active.window,
      how: active.substituted
        ? `the window in front on your desktop (${active.window.title}) — the agent’s own window was ` +
          `in focus, and that is not what "this window" means`
        : `the active window (${active.window.title})`,
    };
  }

  // --- 5. Still nothing: whatever the agent last acted on -------------------
  if (referents.app) {
    const matched = await windowsOfApp(referents.app, open, apps);
    const decided = decide(matched, 'pick-topmost', '');
    if (decided) {
      return {
        window: decided.window,
        how: `the ${referents.app} window, which is what you were last working with`,
      };
    }
  }

  return {
    code: 'WINDOW_NOT_FOUND',
    message:
      open.length === 0
        ? 'There are no ordinary windows open on this desktop.'
        : 'I could not tell which window you meant, and nothing was in focus.',
    details: { open: summarise(open) },
  };
}

/**
 * Match an application name to its windows.
 *
 * Goes through the application registry first so that what a person says
 * ("VS Code") reaches the image name Windows reports (`Code.exe` → `Code`).
 * Falls back to a substring of the process name, which catches applications the
 * registry has never heard of.
 */
async function windowsOfApp(
  name: string,
  open: readonly WindowInfo[],
  apps: AppRegistry,
): Promise<WindowInfo[]> {
  const needle = name.trim().toLowerCase().replace(/\.exe$/, '');
  const resolved = await apps.resolve(name).catch(() => undefined);
  const image = resolved?.imageName.toLowerCase().replace(/\.exe$/, '');

  const exact = open.filter((window) => {
    const process = window.processName.toLowerCase();
    return process === needle || (image !== undefined && process === image);
  });
  if (exact.length > 0) return exact;

  return open.filter((window) => window.processName.toLowerCase().includes(needle));
}

function decide(
  matched: readonly WindowInfo[],
  ambiguity: 'pick-topmost' | 'refuse',
  label: string,
): Resolution | undefined {
  if (matched.length === 0) return undefined;
  if (matched.length === 1) return { window: matched[0]!, how: `"${matched[0]!.title}"` };
  if (ambiguity === 'refuse') return undefined;

  // `listWindows` is z-ordered, so the first match is the one nearest the front
  // — the one a person looking at their screen would call "the" window.
  const top = matched[0]!;
  return {
    window: top,
    how: label
      ? `the frontmost of ${matched.length} ${label} ("${top.title}")`
      : `"${top.title}"`,
  };
}

// ---------------------------------------------------------------------------
// window.list
// ---------------------------------------------------------------------------

const ListInput = z
  .object({
    app: z.string().optional().describe('Only windows belonging to this application.'),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
type ListInput = z.infer<typeof ListInput>;

export interface WindowSummary {
  readonly handle: number;
  readonly title: string;
  readonly app: string;
  readonly active: boolean;
  readonly minimised: boolean;
}

export function createWindowListTool(
  apps: AppRegistry,
  uia: WindowAutomation = windowsAutomation,
): AgentTool<ListInput, { windows: WindowSummary[] }> {
  return {
    name: 'window.list',
    description:
      'List the windows currently open on the user’s desktop, front to back, with a handle you can ' +
      'pass to window.focus or window.close. Use this to find out what the user is working with, or ' +
      'when a title or application name might match more than one window. The agent’s own window is ' +
      'never included.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: ListInput,
    verification: 'intrinsic',
    timeoutMs: 30_000,

    async execute(input): Promise<ToolResult<{ windows: WindowSummary[] }>> {
      try {
        const open = await candidates(uia);
        const filtered = input.app ? await windowsOfApp(input.app, open, apps) : open;

        return ok({
          windows: filtered.slice(0, input.limit ?? 30).map((window) => ({
            handle: window.handle,
            title: window.title,
            app: window.processName,
            active: window.isActive,
            minimised: window.isMinimized,
          })),
        });
      } catch (cause) {
        return err('UNSUPPORTED_PLATFORM', String(cause), { recoverable: false });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// screen.getActiveWindow
// ---------------------------------------------------------------------------

const ActiveWindowInput = z.object({}).strict();
type ActiveWindowInput = z.infer<typeof ActiveWindowInput>;

export interface ActiveWindowResult {
  readonly handle: number;
  readonly title: string;
  readonly app: string;
  readonly processName: string;
  /** True when the foreground window was the agent's and this is the one behind it. */
  readonly behindAgentWindow: boolean;
}

export function createScreenGetActiveWindowTool(
  uia: WindowAutomation = windowsAutomation,
): AgentTool<ActiveWindowInput, ActiveWindowResult> {
  return {
    name: 'screen.getActiveWindow',
    description:
      'Find out which window the user is currently looking at, with its title and application. This is ' +
      'what "this window", "the current window" and "what am I looking at?" refer to. It never reports ' +
      'the agent’s own window: if that is in front, the window behind it is reported instead.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: ActiveWindowInput,
    verification: 'intrinsic',
    timeoutMs: 30_000,

    async execute(): Promise<ToolResult<ActiveWindowResult>> {
      try {
        const active = await uia.active();
        if (!active) {
          return err('WINDOW_NOT_FOUND', 'There are no ordinary windows open on this desktop.', {
            recoverable: false,
          });
        }
        return ok({
          handle: active.window.handle,
          title: active.window.title,
          app: active.window.processName,
          processName: active.window.processName,
          behindAgentWindow: active.substituted,
        });
      } catch (cause) {
        return err('UNSUPPORTED_PLATFORM', String(cause), { recoverable: false });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// window.focus
// ---------------------------------------------------------------------------

const FocusInput = z.object(TargetInput).strict();
type FocusInput = z.infer<typeof FocusInput>;

export interface FocusResult {
  readonly handle: number;
  readonly title: string;
  readonly processName: string;
  readonly focused: boolean;
  readonly how: string;
}

export function createWindowFocusTool(
  apps: AppRegistry,
  referents: ReferentSource,
  uia: WindowAutomation = windowsAutomation,
): AgentTool<FocusInput, FocusResult> {
  return {
    name: 'window.focus',
    description:
      'Bring a window to the front on the user’s screen, restoring it if it is minimised. Identify it ' +
      'by handle, by part of its title, or by application. With none of those, the window the user is ' +
      'currently looking at is used. Use this before typing into or reading a specific application.',
    permission: 'write',
    // Nothing is lost: the user can switch back, and the previous window is
    // still exactly where it was.
    reversibility: 'reversible',
    inputSchema: FocusInput,
    verification: 'explicit',
    timeoutMs: 40_000,

    async execute(input): Promise<ToolResult<FocusResult>> {
      let resolved: Resolution | Rejection;
      try {
        resolved = await resolveTarget(input, apps, referents(), 'pick-topmost', uia);
      } catch (cause) {
        return err('UNSUPPORTED_PLATFORM', String(cause), { recoverable: false });
      }
      if (isRejection(resolved)) {
        return err(resolved.code, resolved.message, { details: resolved.details });
      }

      const outcome = await uia.focus(resolved.window.handle);
      return ok({
        handle: resolved.window.handle,
        title: resolved.window.title,
        processName: resolved.window.processName,
        focused: outcome.focused,
        how: resolved.how,
      });
    },

    async verify(_input, result): Promise<Verification> {
      if (!result.success || !result.data) {
        return verification('not-applicable', 'No window was brought forward.');
      }
      const { handle, title } = result.data;

      try {
        const active = await uia.active();
        if (active?.window.handle === handle) {
          return verification('verified', `"${title}" is now the window in front.`);
        }
        // Windows can refuse a foreground change outright — a full-screen game,
        // an elevated window, or an application that grabs focus back. Saying so
        // is more useful than a bare failure, because the user can see it.
        return verification(
          'unverified',
          `Asked Windows to bring "${title}" forward — the window in front is now ` +
            `"${active?.window.title ?? 'unknown'}", so it may not have taken focus.`,
        );
      } catch (cause) {
        return verification('unverified', `Could not read the active window: ${String(cause)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// window.close
// ---------------------------------------------------------------------------

const CloseWindowInput = z.object(TargetInput).strict();
type CloseWindowInput = z.infer<typeof CloseWindowInput>;

export interface CloseWindowResult {
  readonly handle: number;
  readonly title: string;
  readonly processName: string;
  readonly how: string;
}

export function createWindowCloseTool(
  apps: AppRegistry,
  referents: ReferentSource,
  uia: WindowAutomation = windowsAutomation,
): AgentTool<CloseWindowInput, CloseWindowResult> {
  return {
    name: 'window.close',
    description:
      'Close one window — not the whole application. Identify it by handle, by part of its title, or ' +
      'by application; with none of those, the window the user is currently looking at is closed. This ' +
      'asks the window to close, so it may show a "save changes?" prompt and stay open, which is ' +
      'reported honestly. Use app.close to close an entire application instead.',
    permission: 'destructive',
    // Whatever was on screen, and anything unsaved in it, does not come back.
    reversibility: 'irreversible',
    inputSchema: CloseWindowInput,
    verification: 'explicit',
    timeoutMs: 40_000,

    describeEffect(input): string {
      const named = input.title ?? input.app ?? (input.handle ? `window ${input.handle}` : undefined);
      return named
        ? `Close the ${named} window. Any unsaved work in it may be lost.`
        : 'Close the window you are currently looking at. Any unsaved work in it may be lost.';
    },

    async execute(input): Promise<ToolResult<CloseWindowResult>> {
      let resolved: Resolution | Rejection;
      try {
        // 'refuse': closing is irreversible, so an ambiguous "close the Chrome
        // window" must come back as a question rather than a coin toss.
        resolved = await resolveTarget(input, apps, referents(), 'refuse', uia);
      } catch (cause) {
        return err('UNSUPPORTED_PLATFORM', String(cause), { recoverable: false });
      }
      if (isRejection(resolved)) {
        return err(resolved.code, resolved.message, { details: resolved.details });
      }

      const outcome = await uia.close(resolved.window.handle);
      if (!outcome.requested) {
        return err('WINDOW_NOT_FOUND', `"${resolved.window.title}" could not be asked to close.`, {
          details: { reason: outcome.reason ?? 'unknown' },
        });
      }

      return ok({
        handle: resolved.window.handle,
        title: resolved.window.title,
        processName: resolved.window.processName,
        how: resolved.how,
      });
    },

    async verify(_input, result): Promise<Verification> {
      if (!result.success || !result.data) {
        return verification('not-applicable', 'Nothing was closed.');
      }
      const { handle, title } = result.data;

      try {
        const gone = await uia.waitForClose(handle);
        return gone
          ? verification('verified', `The "${title}" window is closed.`)
          : verification(
              'failed',
              // Deliberately does not assert why. "It is asking you to save" is
              // the obvious guess and is often wrong, and a confident wrong
              // reason sends the user looking for a dialog that is not there.
              `"${title}" is still open. It may be waiting on a prompt, or it may not respond to ` +
                `a close request.`,
            );
      } catch (cause) {
        return verification('unverified', `Could not re-check the window: ${String(cause)}`);
      }
    },
  };
}

export { isValidHandle };
