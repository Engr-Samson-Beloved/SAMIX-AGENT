import type { AgentTool } from '@samix/shared';
import { ToolRegistry } from './registry.js';
import { systemGetInfoTool } from './system/get-info.js';
import { createAgentGetStatusTool, type StatusProvider } from './system/get-status.js';

export { ToolRegistry, ToolRegistrationError } from './registry.js';
export { systemGetInfoTool } from './system/get-info.js';
export { createAgentGetStatusTool } from './system/get-status.js';
export type { SystemInfo } from './system/get-info.js';
export type { AgentStatusReport, StatusProvider } from './system/get-status.js';

/**
 * Build the Phase 1 tool set.
 *
 * Later phases add their namespaces here — filesystem (Phase 4), process and
 * applications (Phase 5), browser (Phase 6) and so on. Registration stays
 * centralised so that "what can this agent do?" has exactly one answer, findable
 * in one file, rather than being scattered across modules that self-register on
 * import.
 */
export function createToolRegistry(deps: { statusProvider: StatusProvider }): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll([
    systemGetInfoTool as unknown as AgentTool<never, unknown>,
    createAgentGetStatusTool(deps.statusProvider) as unknown as AgentTool<never, unknown>,
  ]);
  return registry;
}
