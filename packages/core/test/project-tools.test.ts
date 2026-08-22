import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, after } from 'node:test';
import {
  AppRegistry,
  PathPolicy,
  createProjectDetectTool,
  createProjectOpenTool,
  type DiscoveredApp,
} from '../dist/index.js';
import { tempDir } from './helpers.ts';

/**
 * `project.detect` and `project.open` (spec §23) — Phase 10.
 *
 * `project.open` actually launching an editor is deliberately untested here,
 * matching `app-tools.test.ts`'s own restraint: nothing in this suite spawns
 * a real process. Only the resolution boundaries are exercised — unknown
 * editor, wrong kind, bad path — the same shape `app.launch`'s own tests
 * cover for the same reason.
 */

const workspace = tempDir('samix-project-');
const root = fs.realpathSync(workspace.dir);
after(() => workspace.cleanup());

const pathPolicy = new PathPolicy({ trustedFolders: [root], blockedPathPatterns: ['C:\\Windows'] });

const ctx = {
  taskId: 'task_test',
  stepId: 'step_test',
  signal: new AbortController().signal,
  timeoutMs: 15_000,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};

function at(...segments: string[]): string {
  return path.join(root, ...segments);
}

describe('project.detect', () => {
  test('detects a Node/pnpm project and reads its scripts', async () => {
    const dir = at('node-app');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'my-app', scripts: { build: 'tsc', test: 'node --test' } }),
    );
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    const result = await createProjectDetectTool(pathPolicy).execute({ path: dir }, ctx);

    assert.equal(result.success, true);
    assert.deepEqual(result.data!.kinds, ['node']);
    assert.equal(result.data!.name, 'my-app');
    assert.equal(result.data!.packageManager, 'pnpm');
    assert.deepEqual(result.data!.scripts, { build: 'tsc', test: 'node --test' });
    assert.equal(result.data!.hasGit, false);
  });

  test('detects a Rust project by Cargo.toml', async () => {
    const dir = at('rust-app');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "sidecar"\nversion = "0.1.0"\n');

    const result = await createProjectDetectTool(pathPolicy).execute({ path: dir }, ctx);

    assert.equal(result.success, true);
    assert.deepEqual(result.data!.kinds, ['rust']);
    assert.equal(result.data!.name, 'sidecar');
  });

  test('detects a mixed-toolchain project and a git repository', async () => {
    const dir = at('mixed-app');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mixed' }));
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# mixed\n');

    const result = await createProjectDetectTool(pathPolicy).execute({ path: dir }, ctx);

    assert.equal(result.success, true);
    assert.deepEqual(result.data!.kinds.sort(), ['node', 'python']);
    assert.equal(result.data!.hasGit, true);
    assert.equal(result.data!.hasReadme, true);
  });

  test('reports no kinds for an ordinary folder, honestly rather than guessing', async () => {
    const dir = at('not-a-project');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');

    const result = await createProjectDetectTool(pathPolicy).execute({ path: dir }, ctx);

    assert.equal(result.success, true);
    assert.deepEqual(result.data!.kinds, []);
  });

  test('refuses a path that does not exist', async () => {
    const result = await createProjectDetectTool(pathPolicy).execute({ path: at('nope') }, ctx);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'FILE_NOT_FOUND');
  });
});

describe('project.open', () => {
  const fakeApps: DiscoveredApp[] = [
    {
      id: 'vscode',
      displayName: 'Visual Studio Code',
      executablePath: 'C:\\fake\\Code.exe',
      imageName: 'Code.exe',
      kind: 'editor',
      aliases: ['vs code', 'code'],
    },
    {
      id: 'chrome',
      displayName: 'Google Chrome',
      executablePath: 'C:\\fake\\chrome.exe',
      imageName: 'chrome.exe',
      kind: 'browser',
      aliases: [],
    },
  ];
  const apps = new AppRegistry(() => Promise.resolve(fakeApps));

  test('is a write-permission tool the user can simply close, not something irreversible', () => {
    const tool = createProjectOpenTool(apps, pathPolicy);
    assert.equal(tool.permission, 'write');
    assert.equal(tool.reversibility, 'reversible');
  });

  test('refuses an editor name that resolves to nothing, with suggestions', async () => {
    const tool = createProjectOpenTool(apps, pathPolicy);
    const dir = at('node-app');
    const result = await tool.execute({ path: dir, editor: 'notarealide' }, ctx);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'APP_NOT_FOUND');
    assert.deepEqual(result.error?.details?.['installed'], ['Visual Studio Code', 'Google Chrome']);
  });

  test('refuses an application that is not an editor', async () => {
    const tool = createProjectOpenTool(apps, pathPolicy);
    const result = await tool.execute({ path: at('node-app'), editor: 'chrome' }, ctx);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'INVALID_INPUT');
  });

  test('refuses a folder that does not exist', async () => {
    const tool = createProjectOpenTool(apps, pathPolicy);
    const result = await tool.execute({ path: at('does-not-exist') }, ctx);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'FILE_NOT_FOUND');
  });

  test('refuses a path that is a file, not a folder', async () => {
    const tool = createProjectOpenTool(apps, pathPolicy);
    const file = at('a-file.txt');
    fs.writeFileSync(file, 'hi');
    const result = await tool.execute({ path: file }, ctx);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'INVALID_INPUT');
  });
});
