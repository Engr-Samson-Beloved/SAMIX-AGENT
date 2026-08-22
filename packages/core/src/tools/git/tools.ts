import fs from 'node:fs/promises';
import { z } from 'zod';
import { err, ok, type AgentTool, type ToolResult } from '@samix/shared';
import type { PathPolicy } from '../../security/path-policy.js';
import { guardPath } from '../filesystem/guard.js';
import { run, type RunOutcome } from '../terminal/run.js';

/**
 * Read-only git tools (spec §22, §23) — Phase 10.
 *
 * Structured, single-purpose wrappers rather than routing "what changed?"
 * through `terminal.execute`: each one runs exactly one fixed git subcommand,
 * so it can be `permission: 'read'` (never confirmed) instead of `'system'`
 * — the same "APIs over pixels" argument the rest of the tool system makes
 * for filesystem and browser access applies here. `git` is still spawned
 * through the shared `run()` helper with `shell: false` and an argv array;
 * nothing here accepts an arbitrary subcommand or flag from the planner.
 *
 * A nonzero exit — most commonly "not a git repository" outside one — is
 * still `ok()`, not a tool error: it is git's own honest answer, and the
 * planner can read it from `stderr` the same way it reads any other result.
 * Only a genuine execution failure (git itself is missing, the directory
 * does not exist, a timeout) is a `ToolResult` failure.
 */

const CwdInput = {
  cwd: z
    .string()
    .min(1)
    .describe('The repository directory — a real path, or a shorthand like "home" or "desktop".'),
};

export interface GitCommandResult {
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/** Shared execution path for every tool in this module. */
async function runGit(
  pathPolicy: PathPolicy,
  cwd: string,
  args: readonly string[],
  ctx: { readonly signal: AbortSignal },
): Promise<{ result: ToolResult<GitCommandResult> } | { resolved: string; outcome: RunOutcome }> {
  const guarded = guardPath(pathPolicy, cwd, 'read');
  if ('error' in guarded) return { result: guarded.error as ToolResult<never> };
  const resolved = guarded.path.absolute;

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return { result: err('FILE_NOT_FOUND', `${resolved} is not a directory.`, { recoverable: false }) };
    }
  } catch {
    return { result: err('FILE_NOT_FOUND', `${resolved} does not exist.`, { recoverable: false }) };
  }

  const outcome = await run('git', args, {
    cwd: resolved,
    timeoutMs: 20_000,
    maxOutputBytes: 200_000,
    signal: ctx.signal,
  });

  if (outcome.spawnError) {
    return {
      result: err('APP_NOT_FOUND', `Could not run git: ${outcome.spawnError}. Is Git installed?`, {
        recoverable: false,
      }),
    };
  }
  if (outcome.cancelled) {
    return { result: err('USER_CANCELLED', 'git was cancelled.', { recoverable: false }) };
  }
  if (outcome.timedOut) {
    return { result: err('TIMEOUT', 'git did not finish in time.', { recoverable: false }) };
  }

  return { resolved, outcome };
}

function toToolResult(resolved: string, outcome: RunOutcome): ToolResult<GitCommandResult> {
  return ok({
    cwd: resolved,
    exitCode: outcome.exitCode,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    truncated: outcome.truncatedStdout || outcome.truncatedStderr,
  });
}

// ---------------------------------------------------------------------------
// git.status
// ---------------------------------------------------------------------------

const StatusInput = z.object({ ...CwdInput }).strict();
type StatusInput = z.infer<typeof StatusInput>;

export function createGitStatusTool(pathPolicy: PathPolicy): AgentTool<StatusInput, GitCommandResult> {
  return {
    name: 'git.status',
    description:
      'Show which files are staged, modified or untracked in a git repository, and which branch ' +
      'it is on. Read-only.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: StatusInput,
    verification: 'intrinsic',
    availableInModes: ['developer'],
    timeoutMs: 25_000,

    async execute(input, ctx): Promise<ToolResult<GitCommandResult>> {
      const attempt = await runGit(pathPolicy, input.cwd, ['status'], ctx);
      if ('result' in attempt) return attempt.result;
      return toToolResult(attempt.resolved, attempt.outcome);
    },
  };
}

// ---------------------------------------------------------------------------
// git.diff
// ---------------------------------------------------------------------------

const DiffInput = z
  .object({
    ...CwdInput,
    staged: z.boolean().default(false).describe('Show staged changes (git diff --staged) instead of unstaged ones.'),
  })
  .strict();
type DiffInput = z.infer<typeof DiffInput>;

export function createGitDiffTool(pathPolicy: PathPolicy): AgentTool<DiffInput, GitCommandResult> {
  return {
    name: 'git.diff',
    description: 'Show the actual line changes not yet committed in a git repository. Read-only.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: DiffInput,
    verification: 'intrinsic',
    availableInModes: ['developer'],
    timeoutMs: 25_000,

    async execute(input, ctx): Promise<ToolResult<GitCommandResult>> {
      const args = input.staged ? ['diff', '--staged'] : ['diff'];
      const attempt = await runGit(pathPolicy, input.cwd, args, ctx);
      if ('result' in attempt) return attempt.result;
      return toToolResult(attempt.resolved, attempt.outcome);
    },
  };
}

// ---------------------------------------------------------------------------
// git.log
// ---------------------------------------------------------------------------

const LogInput = z
  .object({
    ...CwdInput,
    limit: z.number().int().min(1).max(100).default(10).describe('How many recent commits to show.'),
  })
  .strict();
type LogInput = z.infer<typeof LogInput>;

export function createGitLogTool(pathPolicy: PathPolicy): AgentTool<LogInput, GitCommandResult> {
  return {
    name: 'git.log',
    description: 'Show recent commits in a git repository — hash, date, author and message. Read-only.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: LogInput,
    verification: 'intrinsic',
    availableInModes: ['developer'],
    timeoutMs: 25_000,

    async execute(input, ctx): Promise<ToolResult<GitCommandResult>> {
      const args = [
        'log',
        `-n`,
        String(input.limit),
        '--date=short',
        '--pretty=format:%h  %ad  %an  %s',
      ];
      const attempt = await runGit(pathPolicy, input.cwd, args, ctx);
      if ('result' in attempt) return attempt.result;
      return toToolResult(attempt.resolved, attempt.outcome);
    },
  };
}

// ---------------------------------------------------------------------------
// git.branch
// ---------------------------------------------------------------------------

const BranchInput = z.object({ ...CwdInput }).strict();
type BranchInput = z.infer<typeof BranchInput>;

export function createGitBranchTool(pathPolicy: PathPolicy): AgentTool<BranchInput, GitCommandResult> {
  return {
    name: 'git.branch',
    description:
      'List branches in a git repository, marking the current one and what each tracks. Read-only.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: BranchInput,
    verification: 'intrinsic',
    availableInModes: ['developer'],
    timeoutMs: 25_000,

    async execute(input, ctx): Promise<ToolResult<GitCommandResult>> {
      const attempt = await runGit(pathPolicy, input.cwd, ['branch', '-vv'], ctx);
      if ('result' in attempt) return attempt.result;
      return toToolResult(attempt.resolved, attempt.outcome);
    },
  };
}
