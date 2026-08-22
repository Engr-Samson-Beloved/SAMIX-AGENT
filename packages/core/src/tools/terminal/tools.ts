import fs from 'node:fs/promises';
import { z } from 'zod';
import { err, ok, verification, type AgentTool, type ToolResult, type Verification } from '@samix/shared';
import type { CommandPolicy } from '../../security/command-policy.js';
import type { PathPolicy } from '../../security/path-policy.js';
import { guardPath, toAbsolutePath } from '../filesystem/guard.js';
import { run } from './run.js';

/**
 * `terminal.execute` (spec §22, §40) — Phase 10.
 *
 * The one deliberately generic escape hatch into the machine's toolchain, and
 * everything about its shape exists to keep that hatch narrow:
 *
 *  - `command` is a bare name checked against `CommandPolicy` — never a path,
 *    never a shell (see `security/command-policy.ts` for why that boundary
 *    holds without a dangerous-command blacklist).
 *  - `args` is an array, passed straight to `child_process.spawn` with
 *    `shell: false`. There is no shell string for injection to hide in.
 *  - `permission: 'system'` — the one level the permission engine never
 *    auto-approves, in any mode. Every call is confirmed, and the prompt
 *    shows the literal command and arguments before anything runs.
 *  - `availableInModes: ['developer']` — not offered to the planner at all
 *    outside DEVELOPER mode, so it cannot be planned around by accident.
 *
 * A nonzero exit code is not a tool failure: running `npm test` and observing
 * the tests fail is the tool doing exactly its job. The exit code and full
 * output are returned as data for the planner to read and report honestly;
 * only a genuine execution failure — the executable does not exist, the
 * command was refused by policy, it timed out — is a `ToolResult` failure.
 */

const ExecuteInput = z
  .object({
    command: z
      .string()
      .min(1)
      .describe('Bare executable name from the allowed list, e.g. "git", "npm", "pnpm", "node" — never a path.'),
    args: z
      .array(z.string())
      .default([])
      .describe('Arguments, each its own array entry — never one shell string.'),
    cwd: z
      .string()
      .min(1)
      .describe('Directory to run the command in — a real path, or a shorthand like "home" or "desktop".'),
  })
  .strict();
type ExecuteInput = z.infer<typeof ExecuteInput>;

export interface TerminalExecuteResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncatedStdout: boolean;
  readonly truncatedStderr: boolean;
  readonly durationMs: number;
}

export function createTerminalExecuteTool(
  policy: CommandPolicy,
  pathPolicy: PathPolicy,
): AgentTool<ExecuteInput, TerminalExecuteResult> {
  return {
    name: 'terminal.execute',
    description:
      'Run one allow-listed development command — such as git, node, npm, pnpm or npx — with ' +
      'explicit arguments and a working directory, and report its exit code plus captured output. ' +
      'There is no shell: arguments are passed exactly as given and never interpreted, and no other ' +
      'executable can be named. A nonzero exit code is not an error to avoid reporting — it is the ' +
      'answer, e.g. failing tests. Use this for building, testing or installing dependencies; prefer ' +
      'the dedicated git.* tools for reading repository state.',
    permission: 'system',
    reversibility: 'unknown',
    inputSchema: ExecuteInput,
    verification: 'explicit',
    availableInModes: ['developer'],
    // Comfortably above TerminalConfigSchema's own timeoutMs ceiling, so the
    // executor's wrapper timeout never races the policy-driven internal
    // timeout in `run()` into reporting the wrong cause for a kill.
    timeoutMs: 650_000,

    describeEffect(input): string {
      const argStr = input.args.length > 0 ? ` ${input.args.join(' ')}` : '';
      return `Run "${input.command}${argStr}" in ${toAbsolutePath(input.cwd)}.`;
    },

    async execute(input, ctx): Promise<ToolResult<TerminalExecuteResult>> {
      const decision = policy.evaluate(input.command);
      if (!decision.allowed) {
        return err('ACTION_BLOCKED', decision.reason ?? 'That command is not allowed.', {
          recoverable: false,
        });
      }

      const guarded = guardPath(pathPolicy, input.cwd, 'read');
      if ('error' in guarded) return guarded.error as ToolResult<never>;
      const cwd = guarded.path.absolute;

      try {
        const stat = await fs.stat(cwd);
        if (!stat.isDirectory()) {
          return err('FILE_NOT_FOUND', `${cwd} is not a directory.`, { recoverable: false });
        }
      } catch {
        return err('FILE_NOT_FOUND', `${cwd} does not exist.`, { recoverable: false });
      }

      const outcome = await run(input.command, input.args, {
        cwd,
        timeoutMs: policy.timeoutMs,
        maxOutputBytes: policy.maxOutputBytes,
        signal: ctx.signal,
      });

      if (outcome.spawnError) {
        return err('APP_NOT_FOUND', `Could not run "${input.command}": ${outcome.spawnError}`, {
          recoverable: false,
        });
      }
      if (outcome.cancelled) {
        return err('USER_CANCELLED', `"${input.command}" was cancelled.`, { recoverable: false });
      }
      if (outcome.timedOut) {
        return err(
          'TIMEOUT',
          `"${input.command}" did not finish within ${policy.timeoutMs}ms and was stopped.`,
          { recoverable: false },
        );
      }

      return ok({
        command: input.command,
        args: input.args,
        cwd,
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        truncatedStdout: outcome.truncatedStdout,
        truncatedStderr: outcome.truncatedStderr,
        durationMs: outcome.durationMs,
      });
    },

    async verify(_input, result): Promise<Verification> {
      if (!result.success || !result.data) {
        return verification('not-applicable', 'The command did not run, so there is nothing to check.');
      }
      const { exitCode, truncatedStdout, truncatedStderr } = result.data;
      const truncNote = truncatedStdout || truncatedStderr ? ' Output was truncated.' : '';
      return verification(
        'verified',
        `The command ran to completion and exited with code ${exitCode ?? 'unknown'}.${truncNote}`,
      );
    },
  };
}
