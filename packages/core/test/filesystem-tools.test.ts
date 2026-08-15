import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, describe, before, after } from 'node:test';
import {
  PathPolicy,
  createCopyTool,
  createCreateDirectoryTool,
  createDeleteTool,
  createListDirectoryTool,
  createMoveTool,
  createReadTextFileTool,
  createRenameTool,
  createSearchTool,
  toAbsolutePath,
} from '../dist/index.js';
import { tempDir } from './helpers.ts';

/**
 * Phase 4 filesystem tools.
 *
 * Every case runs inside a temp directory that is declared trusted for the
 * duration (spec §69: tests never touch real user data). The interesting cases
 * are the refusals — a tool that copies a file is easy; a tool that reliably
 * *declines* to write outside a trusted folder is the one worth testing.
 */

const workspace = tempDir('samix-fs-');
const root = fs.realpathSync(workspace.dir);
const outside = tempDir('samix-outside-');
const outsideRoot = fs.realpathSync(outside.dir);

/** Policy with the temp workspace trusted and a deny rule inside it. */
const policy = new PathPolicy({
  trustedFolders: [root],
  blockedPathPatterns: ['**/.ssh/**', '**/*.key', 'C:\\Windows'],
});

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

before(() => {
  fs.mkdirSync(at('docs'), { recursive: true });
  fs.mkdirSync(at('.ssh'), { recursive: true });
  fs.writeFileSync(at('docs', 'notes.txt'), 'hello from notes');
  fs.writeFileSync(at('docs', 'report.pdf'), 'PDF-ish bytes');
  fs.writeFileSync(at('.ssh', 'id_rsa'), 'super secret');
  fs.writeFileSync(at('secret.key'), 'also secret');
  fs.writeFileSync(path.join(outsideRoot, 'elsewhere.txt'), 'not yours');
});

after(() => {
  workspace.cleanup();
  outside.cleanup();
});

// ---------------------------------------------------------------------------

describe('reading', () => {
  test('lists a directory with sizes and types', async () => {
    const tool = createListDirectoryTool(policy);
    const result = await tool.execute({ path: at('docs') }, ctx);

    assert.equal(result.success, true);
    const names = result.data!.entries.map((entry) => entry.name).sort();
    assert.deepEqual(names, ['notes.txt', 'report.pdf']);
    assert.equal(result.data!.entries.every((entry) => entry.type === 'file'), true);
  });

  test('reads a text file', async () => {
    const tool = createReadTextFileTool(policy);
    const result = await tool.execute({ path: at('docs', 'notes.txt') }, ctx);

    assert.equal(result.success, true);
    assert.equal(result.data!.content, 'hello from notes');
    assert.equal(result.data!.truncated, false);
  });

  test('refuses a binary file rather than filling the context with mojibake', async () => {
    fs.writeFileSync(at('image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const tool = createReadTextFileTool(policy);

    const result = await tool.execute({ path: at('image.bin') }, ctx);

    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'INVALID_INPUT');
    assert.match(result.error!.message, /binary/i);
  });

  test('search finds by extension, newest first', async () => {
    const tool = createSearchTool(policy);
    const result = await tool.execute({ directory: root, extension: 'pdf' }, ctx);

    assert.equal(result.success, true);
    assert.equal(result.data!.matches.length, 1);
    assert.equal(result.data!.matches[0]!.name, 'report.pdf');
  });

  test('search never descends into a blocked subtree', async () => {
    const tool = createSearchTool(policy);
    const result = await tool.execute({ directory: root, query: 'id_rsa' }, ctx);

    assert.equal(result.success, true);
    assert.deepEqual(result.data!.matches, []);
  });

  test('reads outside a trusted folder, because refusing would make the agent useless', async () => {
    const tool = createListDirectoryTool(policy);
    const result = await tool.execute({ path: outsideRoot }, ctx);

    assert.equal(result.success, true);
  });
});

describe('the deny list beats trust', () => {
  test('a blocked file inside a trusted folder is still blocked', async () => {
    // Dropping an SSH key on a trusted Desktop must not expose it.
    const tool = createReadTextFileTool(policy);
    const result = await tool.execute({ path: at('.ssh', 'id_rsa') }, ctx);

    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'ACTION_BLOCKED');
    assert.equal(result.error?.recoverable, false);
  });

  test('a blocked pattern applies to deletion too', async () => {
    const tool = createDeleteTool(policy);
    const result = await tool.execute({ path: at('secret.key') }, ctx);

    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'ACTION_BLOCKED');
    assert.equal(fs.existsSync(at('secret.key')), true, 'the file must still be there');
  });

  test('traversal is collapsed before the deny list is consulted', async () => {
    // The path never mentions C:\Windows literally — it arrives there through
    // `..` segments. Matching before resolving would let this straight through.
    const tool = createReadTextFileTool(policy);
    const escape = 'C:\\Users\\someone\\Documents\\..\\..\\..\\Windows\\System32\\config\\SAM';

    const result = await tool.execute({ path: escape }, ctx);

    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'ACTION_BLOCKED');
    assert.equal(result.error?.recoverable, false);
  });
});

describe('writing is confined to trusted folders', () => {
  test('refuses to write outside every trusted folder', async () => {
    const tool = createCreateDirectoryTool(policy);
    const result = await tool.execute({ path: path.join(outsideRoot, 'new') }, ctx);

    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'PERMISSION_DENIED');
    assert.equal(fs.existsSync(path.join(outsideRoot, 'new')), false);
  });

  test('creates a directory inside a trusted folder and verifies it', async () => {
    const tool = createCreateDirectoryTool(policy);
    const input = { path: at('made', 'deeply') };

    const result = await tool.execute(input, ctx);
    const verified = await tool.verify!(input, result, ctx);

    assert.equal(result.success, true);
    assert.equal(verified.status, 'verified');
    assert.equal(fs.statSync(at('made', 'deeply')).isDirectory(), true);
  });
});

describe('copy', () => {
  test('copies into a folder and verifies by comparing sizes', async () => {
    const tool = createCopyTool(policy);
    // Destination is a folder, so the file is copied *into* it — what a user
    // means by "copy it to the Desktop".
    const input = { source: at('docs', 'notes.txt'), destination: root };

    const result = await tool.execute(input, ctx);
    const verified = await tool.verify!(input, result, ctx);

    assert.equal(result.success, true);
    assert.equal(result.data!.destination, at('notes.txt'));
    assert.equal(verified.status, 'verified');
    assert.match(verified.detail, /matches the source/);
  });

  test('refuses to overwrite unless told to', async () => {
    const tool = createCopyTool(policy);
    const input = { source: at('docs', 'notes.txt'), destination: at('notes.txt') };

    const result = await tool.execute(input, ctx);

    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'INVALID_INPUT');
    assert.match(result.error!.message, /already exists/);
  });

  test('the verifier catches a truncated copy the tool believed succeeded', async () => {
    // The scenario ADR-0004 exists for: execute() returned success, and the
    // world disagrees. Simulated by corrupting the destination after the copy.
    const tool = createCopyTool(policy);
    const input = { source: at('docs', 'notes.txt'), destination: at('truncated.txt') };

    const result = await tool.execute(input, ctx);
    fs.writeFileSync(at('truncated.txt'), 'short');
    const verified = await tool.verify!(input, result, ctx);

    assert.equal(result.success, true, 'the tool itself reported success');
    assert.equal(verified.status, 'failed', 'and the verifier must overrule it');
    assert.match(verified.detail, /incomplete/);
  });
});

describe('move and rename', () => {
  test('moves a file and confirms both ends', async () => {
    fs.writeFileSync(at('movable.txt'), 'move me');
    const tool = createMoveTool(policy);
    const input = { source: at('movable.txt'), destination: at('docs', 'moved.txt') };

    const result = await tool.execute(input, ctx);
    const verified = await tool.verify!(input, result, ctx);

    assert.equal(result.success, true);
    assert.equal(verified.status, 'verified');
    assert.equal(fs.existsSync(at('movable.txt')), false);
    assert.equal(fs.existsSync(at('docs', 'moved.txt')), true);
  });

  test('rename refuses a name that is really a path', async () => {
    fs.writeFileSync(at('renamable.txt'), 'x');
    const tool = createRenameTool(policy);

    const result = await tool.execute(
      { path: at('renamable.txt'), newName: '..\\escaped.txt' },
      ctx,
    );

    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'INVALID_INPUT');
    assert.equal(fs.existsSync(path.join(root, '..', 'escaped.txt')), false);
  });
});

describe('delete', () => {
  test('will not empty a folder without being told to', async () => {
    fs.mkdirSync(at('full'), { recursive: true });
    fs.writeFileSync(at('full', 'a.txt'), 'a');
    const tool = createDeleteTool(policy);

    const result = await tool.execute({ path: at('full') }, ctx);

    assert.equal(result.success, false);
    assert.match(result.error!.message, /not empty/);
    assert.equal(fs.existsSync(at('full', 'a.txt')), true);
  });

  test('deletes recursively when told, and reports the count it destroyed', async () => {
    const tool = createDeleteTool(policy);
    const input = { path: at('full'), recursive: true };

    const result = await tool.execute(input, ctx);
    const verified = await tool.verify!(input, result, ctx);

    assert.equal(result.success, true);
    assert.equal(result.data!.filesDeleted, 1);
    assert.equal(verified.status, 'verified');
    assert.equal(fs.existsSync(at('full')), false);
  });

  test('the confirmation sentence names the path and says it cannot be undone', async () => {
    // Spec §95: the prompt is the user's last chance to notice the wrong target.
    const tool = createDeleteTool(policy);

    const effect = tool.describeEffect!({ path: at('docs'), recursive: true });

    assert.match(effect, /Permanently delete/);
    assert.ok(effect.includes(at('docs')), 'the exact path must appear');
    assert.match(effect, /cannot be undone/);
    assert.match(effect, /Recycle Bin/);
  });
});

describe('path shorthands', () => {
  test('resolves the folders a planner would otherwise have to guess', () => {
    const desktop = toAbsolutePath('desktop');

    assert.ok(path.isAbsolute(desktop));
    assert.match(desktop, /Desktop$/i);
  });

  test('expands ~ and collapses traversal', () => {
    const resolved = toAbsolutePath('~/Documents/../Documents');

    assert.ok(path.isAbsolute(resolved));
    assert.ok(!resolved.includes('..'));
  });
});
