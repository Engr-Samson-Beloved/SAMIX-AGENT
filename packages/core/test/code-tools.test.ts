import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, before, after } from 'node:test';
import { PathPolicy, createCodeEditTool, createCodeReadTool, createCodeSearchTool } from '../dist/index.js';
import { tempDir } from './helpers.ts';

/**
 * `code.search`, `code.read`, `code.edit` (spec §23) — Phase 10.
 *
 * `code.edit`'s contract is the one worth testing hardest: it must refuse
 * when the exact text is not found, refuse when it is ambiguous, and — when
 * it does write — the file on disk must end up exactly as intended, which
 * `verify()` re-checks by re-reading and hashing rather than trusting the
 * write call not to have thrown.
 */

const workspace = tempDir('samix-code-');
const root = fs.realpathSync(workspace.dir);
after(() => workspace.cleanup());

const policy = new PathPolicy({ trustedFolders: [root], blockedPathPatterns: ['C:\\Windows'] });

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
  fs.mkdirSync(at('src'), { recursive: true });
  fs.mkdirSync(at('node_modules', 'noise'), { recursive: true });
  fs.writeFileSync(at('src', 'a.ts'), 'export const TOKEN = "findme";\nconst other = 1;\n');
  fs.writeFileSync(at('src', 'b.ts'), 'const nothingHere = true;\n// FINDME in a comment too\n');
  fs.writeFileSync(at('node_modules', 'noise', 'c.ts'), 'const TOKEN = "findme";\n');
  fs.writeFileSync(at('image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x66, 0x69, 0x6e, 0x64, 0x6d, 0x65]));
});

describe('code.search', () => {
  test('finds matches with file, line number and text, case-insensitively', async () => {
    const result = await createCodeSearchTool(policy).execute({ directory: root, query: 'findme' }, ctx);
    assert.equal(result.success, true);
    const paths = result.data!.matches.map((m) => m.path).sort();
    assert.deepEqual(paths, [at('src', 'a.ts'), at('src', 'b.ts')]);
    const aMatch = result.data!.matches.find((m) => m.path === at('src', 'a.ts'));
    assert.equal(aMatch?.line, 1);
    assert.match(aMatch!.text, /TOKEN = "findme"/);
  });

  test('never descends into node_modules', async () => {
    const result = await createCodeSearchTool(policy).execute({ directory: root, query: 'findme' }, ctx);
    assert.equal(result.success, true);
    assert.ok(!result.data!.matches.some((m) => m.path.includes('node_modules')));
  });

  test('skips binary files without erroring', async () => {
    const result = await createCodeSearchTool(policy).execute({ directory: root, query: 'find' }, ctx);
    assert.equal(result.success, true);
    assert.ok(!result.data!.matches.some((m) => m.path === at('image.bin')));
  });
});

describe('code.read', () => {
  test('numbers every line starting at 1', async () => {
    const result = await createCodeReadTool(policy).execute({ path: at('src', 'a.ts') }, ctx);
    assert.equal(result.success, true);
    assert.equal(
      result.data!.content,
      '1\texport const TOKEN = "findme";\n2\tconst other = 1;\n3\t',
    );
    assert.equal(result.data!.totalLines, 3);
  });

  test('restricts to a line range', async () => {
    const result = await createCodeReadTool(policy).execute(
      { path: at('src', 'b.ts'), startLine: 2, endLine: 2 },
      ctx,
    );
    assert.equal(result.success, true);
    assert.equal(result.data!.content, '2\t// FINDME in a comment too');
  });

  test('refuses a binary file', async () => {
    const result = await createCodeReadTool(policy).execute({ path: at('image.bin') }, ctx);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'INVALID_INPUT');
  });

  test('refuses a file that does not exist', async () => {
    const result = await createCodeReadTool(policy).execute({ path: at('nope.ts') }, ctx);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'FILE_NOT_FOUND');
  });
});

describe('code.edit', () => {
  test('replaces a unique block and verifies the file matches exactly afterwards', async () => {
    const file = at('edit-unique.ts');
    fs.writeFileSync(file, 'function greet() {\n  return "hello";\n}\n');
    const tool = createCodeEditTool(policy);

    const args = { path: file, oldText: 'return "hello";', newText: 'return "hi";' };
    const result = await tool.execute(args, ctx);
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'function greet() {\n  return "hi";\n}\n');

    const verdict = await tool.verify!(args, result, ctx);
    assert.equal(verdict.status, 'verified');
  });

  test('supports deleting a block with an empty newText', async () => {
    const file = at('edit-delete.ts');
    fs.writeFileSync(file, 'const a = 1;\n// TODO remove me\nconst b = 2;\n');
    const tool = createCodeEditTool(policy);

    const result = await tool.execute(
      { path: file, oldText: '// TODO remove me\n', newText: '' },
      ctx,
    );
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'const a = 1;\nconst b = 2;\n');
  });

  test('refuses when the exact text is not found', async () => {
    const file = at('edit-missing.ts');
    fs.writeFileSync(file, 'const a = 1;\n');
    const tool = createCodeEditTool(policy);

    const result = await tool.execute({ path: file, oldText: 'const b = 2;', newText: 'x' }, ctx);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'INVALID_INPUT');
    assert.match(result.error!.message, /not found/);
    // Nothing was touched.
    assert.equal(fs.readFileSync(file, 'utf8'), 'const a = 1;\n');
  });

  test('refuses when the text is ambiguous, rather than guessing which occurrence', async () => {
    const file = at('edit-ambiguous.ts');
    fs.writeFileSync(file, 'const x = 1;\nconst x = 1;\n');
    const tool = createCodeEditTool(policy);

    const result = await tool.execute({ path: file, oldText: 'const x = 1;', newText: 'x' }, ctx);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'INVALID_INPUT');
    assert.match(result.error!.message, /more than once/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'const x = 1;\nconst x = 1;\n');
  });

  test('refuses to edit a file that does not exist — this tool never creates one', async () => {
    const tool = createCodeEditTool(policy);
    const result = await tool.execute(
      { path: at('brand-new.ts'), oldText: 'a', newText: 'b' },
      ctx,
    );
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'FILE_NOT_FOUND');
  });

  test('refuses a binary file', async () => {
    const tool = createCodeEditTool(policy);
    const result = await tool.execute({ path: at('image.bin'), oldText: 'a', newText: 'b' }, ctx);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'INVALID_INPUT');
  });

  test('verify() catches a mismatch if the file changed underneath the edit', async () => {
    const file = at('edit-tampered.ts');
    fs.writeFileSync(file, 'const a = 1;\n');
    const tool = createCodeEditTool(policy);

    const args = { path: file, oldText: 'const a = 1;', newText: 'const a = 2;' };
    const result = await tool.execute(args, ctx);
    assert.equal(result.success, true);

    // Simulate something else touching the file between execute and verify.
    fs.writeFileSync(file, 'something else entirely\n');
    const verdict = await tool.verify!(args, result, ctx);
    assert.equal(verdict.status, 'failed');
  });

  test('is write-permission, irreversible, and always explicitly verified', () => {
    const tool = createCodeEditTool(policy);
    assert.equal(tool.permission, 'write');
    assert.equal(tool.reversibility, 'irreversible');
    assert.equal(tool.verification, 'explicit');
    assert.match(tool.describeEffect!({ path: at('x.ts'), oldText: 'a', newText: 'b' }), /x\.ts/);
  });
});
