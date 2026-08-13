import os from 'node:os';
import { z } from 'zod';
import { ok, type AgentTool, type ToolResult } from '@samix/shared';

/**
 * `system.getInfo` — read-only machine facts.
 *
 * Phase 1 ships two real tools whose only job is to prove the runtime end to
 * end: registry → permission engine → executor → verification → audit → event
 * bus → UI. They are genuinely useful (the planner will want machine context in
 * later phases) but carry no risk, so the loop can be exercised on a real user's
 * machine without any possibility of damage.
 *
 * Deliberately NOT a filesystem tool: filesystem work is Phase 4, and proving
 * the loop does not require the ability to modify anything.
 */

const InputSchema = z
  .object({
    /** Restrict the response to specific sections; omit for all of them. */
    sections: z
      .array(z.enum(['os', 'hardware', 'runtime', 'user']))
      .optional()
      .describe('Which groups of information to return. Omit to return everything.'),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export interface SystemInfo {
  os?: { platform: string; release: string; version: string; arch: string };
  hardware?: { cpuModel: string; cpuCount: number; totalMemoryMb: number; freeMemoryMb: number };
  runtime?: { node: string; pid: number; uptimeSeconds: number };
  user?: { username: string; homeDirectory: string; hostname: string };
}

export const systemGetInfoTool: AgentTool<Input, SystemInfo> = {
  name: 'system.getInfo',
  description:
    'Report facts about the computer the agent is running on: operating system and version, CPU and memory, Node runtime, and the current user account and home directory. Use this to answer questions about the machine itself, or to establish context before planning file or application work.',
  permission: 'read',
  reversibility: 'reversible',
  inputSchema: InputSchema,
  // A pure read: the returned value IS the observation, so there is nothing
  // separate to re-check. See ToolRegistry's registration rules.
  verification: 'intrinsic',
  timeoutMs: 5_000,

  execute(input: Input): Promise<ToolResult<SystemInfo>> {
    const wanted = new Set(input.sections ?? ['os', 'hardware', 'runtime', 'user']);
    const info: SystemInfo = {};

    if (wanted.has('os')) {
      info.os = {
        platform: os.platform(),
        release: os.release(),
        version: os.version(),
        arch: os.arch(),
      };
    }
    if (wanted.has('hardware')) {
      const cpus = os.cpus();
      info.hardware = {
        cpuModel: cpus[0]?.model.trim() ?? 'unknown',
        cpuCount: cpus.length,
        totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
        freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
      };
    }
    if (wanted.has('runtime')) {
      info.runtime = {
        node: process.version,
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
      };
    }
    if (wanted.has('user')) {
      // userInfo() can throw on systems with no passwd entry (containers).
      // Degrade to environment values rather than failing a read-only call.
      try {
        const user = os.userInfo();
        info.user = { username: user.username, homeDirectory: user.homedir, hostname: os.hostname() };
      } catch {
        info.user = {
          username: process.env['USERNAME'] ?? 'unknown',
          homeDirectory: os.homedir(),
          hostname: os.hostname(),
        };
      }
    }

    return Promise.resolve(ok(info));
  },
};
