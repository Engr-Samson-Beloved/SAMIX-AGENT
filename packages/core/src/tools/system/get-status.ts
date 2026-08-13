import { z } from 'zod';
import { ok, type AgentTool, type ToolResult } from '@samix/shared';

/**
 * `agent.getStatus` — the agent's own operating state.
 *
 * Lets the user ask "what mode are you in?", "what can you actually do right
 * now?" or "why did that need my approval?" and get a truthful answer from the
 * live runtime rather than from the model's assumptions. That matters for
 * spec §7 Principle 7 (observable): the agent should be able to explain itself.
 *
 * The status snapshot is injected rather than imported so this tool has no
 * dependency on the orchestrator — which would otherwise be a cycle, since the
 * orchestrator owns the registry.
 */

const InputSchema = z.object({}).strict();
type Input = z.infer<typeof InputSchema>;

export interface AgentStatusReport {
  mode: string;
  state: string;
  toolCount: number;
  availableTools: string[];
  autoApprovedCeiling: string;
  uptimeSeconds: number;
  // `detail?: string | undefined` rather than `detail?: string` because
  // exactOptionalPropertyTypes distinguishes "absent" from "present and
  // undefined", and the status snapshot legitimately produces the latter.
  subsystems: Array<{ name: string; status: string; detail?: string | undefined }>;
}

export type StatusProvider = () => AgentStatusReport;

export function createAgentGetStatusTool(provider: StatusProvider): AgentTool<Input, AgentStatusReport> {
  return {
    name: 'agent.getStatus',
    description:
      "Report the agent's own current state: operating mode (SAFE, CONTROLLED, AUTONOMOUS or DEVELOPER), which tools are available in that mode, which permission levels run without asking, subsystem readiness, and uptime. Use this to answer questions about what the agent can currently do or why an action required confirmation.",
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: InputSchema,
    verification: 'intrinsic',
    timeoutMs: 2_000,

    execute(): Promise<ToolResult<AgentStatusReport>> {
      return Promise.resolve(ok(provider()));
    },
  };
}
