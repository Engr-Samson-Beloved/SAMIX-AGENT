import type { AgentTool } from '@samix/shared';
import type { PathPolicy } from '../security/path-policy.js';
import { ToolRegistry } from './registry.js';
import { AppRegistry } from './apps/app-registry.js';
import {
  createBrowserOpenUrlTool,
  createBrowserSearchTool,
} from './apps/browser.js';
import {
  createAppCloseTool,
  createAppLaunchTool,
  createAppListTool,
  processListTool,
} from './apps/tools.js';
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
export { formatBytes, guardPath, shorthandNames, toAbsolutePath } from './filesystem/guard.js';
export type { GuardedPath, PathIntent } from './filesystem/guard.js';

export interface ToolRegistryDeps {
  readonly statusProvider: StatusProvider;
  readonly pathPolicy: PathPolicy;
  /** Injectable so tests can supply a fake instead of scanning Program Files. */
  readonly apps?: AppRegistry;
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
export function createToolRegistry(deps: ToolRegistryDeps): ToolRegistry {
  const registry = new ToolRegistry();
  const apps = deps.apps ?? new AppRegistry();
  const policy = deps.pathPolicy;

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

    // --- Phase 6 (partial): showing web pages to the user --------------------
    erase(createBrowserOpenUrlTool(apps) as unknown as AgentTool<never, never>),
    erase(createBrowserSearchTool(apps) as unknown as AgentTool<never, never>),
  ]);

  return registry;
}
