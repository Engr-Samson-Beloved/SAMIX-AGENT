import path from 'node:path';
import type { AgentTool } from '@samix/shared';
import type { PathPolicy } from '../security/path-policy.js';
import { ToolRegistry } from './registry.js';
import { AppRegistry } from './apps/app-registry.js';
import { BrowserSession } from './browser/session.js';
import {
  createBrowserClickTool,
  createBrowserCloseTool,
  createBrowserExtractTextTool,
  createBrowserGotoTool,
  createBrowserScreenshotTool,
  createBrowserScrollTool,
  createBrowserSearchTool,
} from './browser/tools.js';
import {
  createAppCloseTool,
  createAppLaunchTool,
  createAppListTool,
  processListTool,
} from './apps/tools.js';
import {
  createScreenGetActiveWindowTool,
  createWindowCloseTool,
  createWindowFocusTool,
  createWindowListTool,
  windowsAutomation,
  type ReferentSource,
  type WindowAutomation,
} from './windows/tools.js';
import {
  createCopyTool,
  createCreateDirectoryTool,
  createDeleteTool,
  createListDirectoryTool,
  createMetadataTool,
  createMoveTool,
  createReadTextFileTool,
  createRenameTool,
  createSearchTool,
} from './filesystem/tools.js';
import { DesktopContext } from './desktop/context.js';
import {
  createDesktopFindElementTool,
  createDesktopInvokeTool,
  createDesktopSetValueTool,
  createDesktopSnapshotTool,
} from './desktop/tools.js';
import type { DesktopSidecar } from './desktop/sidecar.js';
import { systemGetInfoTool } from './system/get-info.js';
import { createAgentGetStatusTool, type StatusProvider } from './system/get-status.js';

export { ToolRegistry, ToolRegistrationError } from './registry.js';
export { systemGetInfoTool } from './system/get-info.js';
export { createAgentGetStatusTool } from './system/get-status.js';
export type { SystemInfo } from './system/get-info.js';
export type { AgentStatusReport, StatusProvider } from './system/get-status.js';

export { AppRegistry, discoverApps, isLaunchable } from './apps/app-registry.js';
export type { AppKind, DiscoveredApp } from './apps/app-registry.js';
export { closeProcess, isProcessRunning, isValidImageName, listProcesses } from './windows/processes.js';
export type { RunningProcess } from './windows/processes.js';
export {
  getActiveWindow,
  isValidHandle,
  listWindows,
  WindowQueryError,
} from './windows/ui-automation.js';
export type { WindowInfo } from './windows/ui-automation.js';
export {
  createScreenGetActiveWindowTool,
  createWindowCloseTool,
  createWindowFocusTool,
  createWindowListTool,
  windowsAutomation,
} from './windows/tools.js';
export type { ReferentSource, WindowAutomation, WindowReferents } from './windows/tools.js';
export { BrowserSession, BrowserSessionError, DEFAULT_DEBUG_PORT } from './browser/session.js';
export type { ProfileKind, SessionStatus } from './browser/session.js';
export {
  createBrowserClickTool,
  createBrowserCloseTool,
  createBrowserExtractTextTool,
  createBrowserGotoTool,
  createBrowserScreenshotTool,
  createBrowserScrollTool,
  createBrowserSearchTool,
  parseWebUrl,
} from './browser/tools.js';
export { formatBytes, guardPath, shorthandNames, toAbsolutePath } from './filesystem/guard.js';
export type { GuardedPath, PathIntent } from './filesystem/guard.js';

export interface ToolRegistryDeps {
  readonly statusProvider: StatusProvider;
  readonly pathPolicy: PathPolicy;
  /** Injectable so tests can supply a fake instead of scanning Program Files. */
  readonly apps?: AppRegistry;
  /** Root for screenshots and the agent's browser profile. */
  readonly cacheDir: string;
  /**
   * What "it" and "this window" currently point at. Supplied by the agent's
   * context so window tools can fall back to the last application acted on
   * (spec §80) without the tools layer depending on the agent.
   */
  readonly referents?: ReferentSource;
  /** Injectable so tests never start a browser. */
  readonly browser?: BrowserSession;
  /**
   * How the window tools reach `user32`. Defaults to the PowerShell path, which
   * is what makes the desktop sidecar optional rather than required: the runtime
   * substitutes a sidecar-backed implementation when one can be started, and
   * these four tools cannot tell the difference.
   */
  readonly windows?: WindowAutomation;
  /**
   * The desktop control sidecar. When absent the four element tools are not
   * registered at all, rather than registered and failing: a capability the
   * planner never hears about is one it cannot try to use.
   */
  readonly desktop?: DesktopSidecar;
}

export interface ToolSet {
  readonly registry: ToolRegistry;
  /** Held so the runtime can release the browser connection at shutdown. */
  readonly browser: BrowserSession;
}

/**
 * Build the tool set.
 *
 * Registration stays centralised so that "what can this agent do?" has exactly
 * one answer, findable in one file, rather than being scattered across modules
 * that self-register on import.
 *
 * The cast to `AgentTool<never, unknown>` is load-bearing rather than lazy:
 * `AgentTool<TInput>` is invariant in `TInput` because the type appears in both
 * `execute` and `inputSchema`, so a heterogeneous array of differently-typed
 * tools has no common supertype. The registry re-validates every input against
 * the tool's own schema before calling it, so the erased type is recovered at
 * exactly the point it matters.
 */
export function createToolRegistry(deps: ToolRegistryDeps): ToolSet {
  const registry = new ToolRegistry();
  const apps = deps.apps ?? new AppRegistry();
  const policy = deps.pathPolicy;
  const referents: ReferentSource = deps.referents ?? ((): Record<string, never> => ({}));
  const uia: WindowAutomation = deps.windows ?? windowsAutomation;

  // One session shared by every browser tool. Two sessions would mean two page
  // handles, and `browser.extractText` would read a page that `browser.goto`
  // never navigated — the bug that makes browser automation feel haunted.
  const browser =
    deps.browser ??
    new BrowserSession({ apps, profileDir: path.join(deps.cacheDir, 'browser-profile') });

  // Warm the application cache in the background. Discovery scans Program Files
  // and takes a noticeable second or two; paying it here means the user pays it
  // during startup, where nothing is waiting, rather than inside their first
  // "open Chrome" — where it was measured adding seconds to a launch that
  // otherwise takes milliseconds. Failure is ignored on purpose: the tools call
  // `list()` themselves and will simply discover then.
  void apps.list().catch(() => undefined);

  const erase = (tool: AgentTool<never, never>): AgentTool<never, unknown> =>
    tool as unknown as AgentTool<never, unknown>;

  registry.registerAll([
    // --- Phase 1: read-only proof of the loop ------------------------------
    erase(systemGetInfoTool as unknown as AgentTool<never, never>),
    erase(createAgentGetStatusTool(deps.statusProvider) as unknown as AgentTool<never, never>),

    // --- Phase 4: filesystem ------------------------------------------------
    erase(createListDirectoryTool(policy) as unknown as AgentTool<never, never>),
    erase(createSearchTool(policy) as unknown as AgentTool<never, never>),
    erase(createMetadataTool(policy) as unknown as AgentTool<never, never>),
    erase(createReadTextFileTool(policy) as unknown as AgentTool<never, never>),
    erase(createCreateDirectoryTool(policy) as unknown as AgentTool<never, never>),
    erase(createCopyTool(policy) as unknown as AgentTool<never, never>),
    erase(createMoveTool(policy) as unknown as AgentTool<never, never>),
    erase(createRenameTool(policy) as unknown as AgentTool<never, never>),
    erase(createDeleteTool(policy) as unknown as AgentTool<never, never>),

    // --- Phase 5: applications and processes --------------------------------
    erase(createAppListTool(apps) as unknown as AgentTool<never, never>),
    erase(createAppLaunchTool(apps) as unknown as AgentTool<never, never>),
    erase(createAppCloseTool(apps) as unknown as AgentTool<never, never>),
    erase(processListTool as unknown as AgentTool<never, never>),

    // --- Phase 6: browser automation over the DevTools protocol --------------
    erase(createBrowserGotoTool(browser) as unknown as AgentTool<never, never>),
    erase(createBrowserSearchTool(browser) as unknown as AgentTool<never, never>),
    erase(createBrowserScrollTool(browser) as unknown as AgentTool<never, never>),
    erase(createBrowserClickTool(browser) as unknown as AgentTool<never, never>),
    erase(createBrowserExtractTextTool(browser) as unknown as AgentTool<never, never>),
    erase(
      createBrowserScreenshotTool(
        browser,
        path.join(deps.cacheDir, 'screenshots'),
      ) as unknown as AgentTool<never, never>,
    ),
    erase(createBrowserCloseTool(browser) as unknown as AgentTool<never, never>),

    // --- Phase 7: windows on the user's desktop ------------------------------
    erase(createWindowListTool(apps, uia) as unknown as AgentTool<never, never>),
    erase(createScreenGetActiveWindowTool(uia) as unknown as AgentTool<never, never>),
    erase(createWindowFocusTool(apps, referents, uia) as unknown as AgentTool<never, never>),
    erase(createWindowCloseTool(apps, referents, uia) as unknown as AgentTool<never, never>),
  ]);

  // --- Phase 7: the controls inside those windows --------------------------
  // Registered only when a sidecar exists. `DesktopContext` is what makes the
  // permission engine able to answer "which application, and what does the
  // button say?" synchronously — see context.ts.
  if (deps.desktop) {
    const context = new DesktopContext();
    registry.registerAll([
      erase(createDesktopSnapshotTool(deps.desktop, context) as unknown as AgentTool<never, never>),
      erase(
        createDesktopFindElementTool(deps.desktop, context) as unknown as AgentTool<never, never>,
      ),
      erase(createDesktopInvokeTool(deps.desktop, context) as unknown as AgentTool<never, never>),
      erase(createDesktopSetValueTool(deps.desktop, context) as unknown as AgentTool<never, never>),
    ]);
  }

  return { registry, browser };
}
