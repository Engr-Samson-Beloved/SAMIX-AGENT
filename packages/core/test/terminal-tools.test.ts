import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test, after } from 'node:test';
import { CommandPolicy, PathPolicy, createTerminalExecuteTool } from '../dist/index.js';
import { tempDir } from './helpers.ts';

/**
 * `terminal.execute` (spec §22, §40) — Phase 10.
 *
 * Runs real `node` child processes (always present in this dev environment)
 * rather than mocking `child_process`, on the same reasoning `check-desktop`
 * and `dev:browser` use for their subsystems: the real risks — a shell
 * reinterpreting an argument, a timeout that does not actually kill the
 * process, output that is buffered without bound — live in the boundary with
 * the OS, which a mock cannot exercise.
 */

const workspace = tempDir('samix-terminal-');
const root = fs.realpathSync(workspace.dir);
after(() => workspace.cleanup());

const pathPolicy = new PathPolicy({ trustedFolders: [root], blockedPathPatterns: ['C:\\Windows'] });

function ctx(signal: AbortSignal = new AbortController().signal) {
  return {
    taskId: 'task_test',
    stepId: 'step_test',
    signal,
    timeoutMs: 15_000,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

function tool(overrides: Partial<{ allowedCommands: string[]; timeoutMs: number; maxOutputBytes: number }> = {}) {
  const policy = new CommandPolicy({
    allowedCommands: ['node'],
    timeoutMs: 15_000,
    maxOutputBytes: 200_000,
    ...overrides,
  });
  return createTerminalExecuteTool(policy, pathPolicy);
}

describe('terminal.execute', () => {
  test('runs an allowed command and captures its exit code and output', async () => {
    const result = await tool().execute(
      { command: 'node', args: ['-e', "console.log('hello from the sandbox')"], cwd: root },
      ctx(),
    );
    assert.equal(result.success, true);
    assert.equal(result.data!.exitCode, 0);
    assert.match(result.data!.stdout, /hello from the sandbox/);
  });

  test('a nonzero exit is reported as data, not as a tool failure', async () => {
    const result = await tool().execute(
      { command: 'node', args: ['-e', 'process.exit(3)'], cwd: root },
      ctx(),
    );
    // The point of the tool: running `npm test` and finding failing tests is a
    // successful use of it, not a malfunction of the agent.
    assert.equal(result.success, true);
    assert.equal(result.data!.exitCode, 3);
  });

  test('verify() reads the exit code plainly, never claiming pass or fail of its own accord', async () => {
    const t = tool();
    const result = await t.execute({ command: 'node', args: ['-e', 'process.exit(1)'], cwd: root }, ctx());
    const verdict = await t.verify!({ command: 'node', args: [], cwd: root }, result, ctx());
    assert.equal(verdict.status, 'verified');
    assert.match(verdict.detail, /exited with code 1/);
  });

  test('refuses a command that is not on the allow list, without spawning anything', async () => {
    const result = await tool({ allowedCommands: ['git'] }).execute(
      { command: 'node', args: ['-e', '1'], cwd: root },
      ctx(),
    );
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'ACTION_BLOCKED');
  });

  test('refuses a working directory blocked by security policy', async () => {
    const result = await tool().execute(
      { command: 'node', args: ['-v'], cwd: 'C:\\Windows' },
      ctx(),
    );
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'ACTION_BLOCKED');
  });

  test('refuses a working directory that does not exist', async () => {
    const result = await tool().execute(
      { command: 'node', args: ['-v'], cwd: `${root}\\does-not-exist` },
      ctx(),
    );
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'FILE_NOT_FOUND');
  });

  test('truncates output past the configured cap and says so', async () => {
    const result = await tool({ maxOutputBytes: 50 }).execute(
      { command: 'node', args: ['-e', "process.stdout.write('x'.repeat(2000))"], cwd: root },
      ctx(),
    );
    assert.equal(result.success, true);
    assert.equal(result.data!.stdout.length, 50);
    assert.equal(result.data!.truncatedStdout, true);
  });

  test('kills a command that outlasts its timeout and reports TIMEOUT', async () => {
    const result = await tool({ timeoutMs: 200 }).execute(
      { command: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'], cwd: root },
      ctx(),
    );
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'TIMEOUT');
  });

  test('stops the process on cancellation and reports USER_CANCELLED', async () => {
    const controller = new AbortController();
    const promise = tool().execute(
      { command: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'], cwd: root },
      ctx(controller.signal),
    );
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'USER_CANCELLED');
  });

  test('reports APP_NOT_FOUND when the allowed command does not actually exist on this machine', async () => {
    // "npx-imaginary" is on the allow list but is not a real executable — the
    // allow list only says a name MAY run, not that it exists.
    const result = await tool({ allowedCommands: ['npx-imaginary'] }).execute(
      { command: 'npx-imaginary', args: [], cwd: root },
      ctx(),
    );
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'APP_NOT_FOUND');
  });

  test('is declared system-permission, developer-mode-only, and always explicitly verified', () => {
    const t = tool();
    assert.equal(t.permission, 'system');
    assert.deepEqual(t.availableInModes, ['developer']);
    assert.equal(t.verification, 'explicit');
  });
});
