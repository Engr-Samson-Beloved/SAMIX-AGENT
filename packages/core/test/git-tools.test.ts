import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, before, after } from 'node:test';
import {
  PathPolicy,
  createGitBranchTool,
  createGitDiffTool,
  createGitLogTool,
  createGitStatusTool,
} from '../dist/index.js';
import { tempDir } from './helpers.ts';

/**
 * `git.status`, `git.diff`, `git.log`, `git.branch` (spec §22, §23) — Phase 10.
 *
 * Against a real repository this test builds and owns, never the project's
 * own — spec §69. Fixture setup goes straight through `git` via `spawnSync`
 * rather than through the tools under test, so a bug in `git.status` cannot
 * make its own fixture look correct.
 */

const workspace = tempDir('samix-git-');
const repo = fs.realpathSync(workspace.dir);
after(() => workspace.cleanup());

function git(args: string[], cwd = repo): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

before(() => {
  git(['init', '-q']);
  git(['config', 'user.email', 'test@samix.local']);
  git(['config', 'user.name', 'SAMIX Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial commit']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture, changed\n');
});

const pathPolicy = new PathPolicy({ trustedFolders: [repo], blockedPathPatterns: ['C:\\Windows'] });

const ctx = {
  taskId: 'task_test',
  stepId: 'step_test',
  signal: new AbortController().signal,
  timeoutMs: 15_000,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};

describe('git.status', () => {
  test('reports the modified file', async () => {
    const result = await createGitStatusTool(pathPolicy).execute({ cwd: repo }, ctx);
    assert.equal(result.success, true);
    assert.equal(result.data!.exitCode, 0);
    assert.match(result.data!.stdout, /README\.md/);
  });

  test('is read-only, always available without confirmation, developer-mode only', () => {
    const tool = createGitStatusTool(pathPolicy);
    assert.equal(tool.permission, 'read');
    assert.equal(tool.verification, 'intrinsic');
    assert.deepEqual(tool.availableInModes, ['developer']);
  });

  test('a directory with no repository is a plain, honest answer — not a tool failure', async () => {
    const outside = tempDir('samix-not-a-repo-');
    const pol = new PathPolicy({ trustedFolders: [outside.dir], blockedPathPatterns: [] });
    const result = await createGitStatusTool(pol).execute({ cwd: outside.dir }, ctx);
    assert.equal(result.success, true);
    assert.notEqual(result.data!.exitCode, 0);
    assert.match(result.data!.stderr, /not a git repository/i);
    outside.cleanup();
  });
});

describe('git.diff', () => {
  test('shows the unstaged change', async () => {
    const result = await createGitDiffTool(pathPolicy).execute({ cwd: repo, staged: false }, ctx);
    assert.equal(result.success, true);
    assert.match(result.data!.stdout, /changed/);
  });

  test('shows nothing staged before anything is added', async () => {
    const result = await createGitDiffTool(pathPolicy).execute({ cwd: repo, staged: true }, ctx);
    assert.equal(result.success, true);
    assert.equal(result.data!.stdout.trim(), '');
  });
});

describe('git.log', () => {
  test('shows the initial commit', async () => {
    const result = await createGitLogTool(pathPolicy).execute({ cwd: repo, limit: 5 }, ctx);
    assert.equal(result.success, true);
    assert.match(result.data!.stdout, /initial commit/);
  });

  test('respects the limit', async () => {
    git(['add', '.']);
    git(['commit', '-q', '-m', 'second commit']);
    const result = await createGitLogTool(pathPolicy).execute({ cwd: repo, limit: 1 }, ctx);
    assert.equal(result.success, true);
    const lines = result.data!.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /second commit/);
  });
});

describe('git.branch', () => {
  test('lists the current branch', async () => {
    const result = await createGitBranchTool(pathPolicy).execute({ cwd: repo }, ctx);
    assert.equal(result.success, true);
    assert.equal(result.data!.exitCode, 0);
    assert.match(result.data!.stdout, /\*/); // current-branch marker
  });
});
