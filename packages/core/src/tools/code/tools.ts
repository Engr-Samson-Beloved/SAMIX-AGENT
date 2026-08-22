import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { err, ok, verification, type AgentTool, type ToolResult, type Verification } from '@samix/shared';
import type { PathPolicy } from '../../security/path-policy.js';
import { guardPath, shorthandNames } from '../filesystem/guard.js';

/**
 * Code-reading and code-editing tools (spec §23) — Phase 10.
 *
 * `code.search` and `code.read` are read-only and deliberately separate from
 * the Phase 4 filesystem tools rather than extensions of them:
 * `filesystem.search` finds files by *name*; this finds files by *content*.
 * `filesystem.readTextFile` returns a content blob; `code.read` numbers the
 * lines, because a planner that is about to propose a `code.edit` needs to
 * quote existing text back exactly, and a line number is what lets a person
 * reading the transcript find the same spot.
 *
 * `code.edit` is the one tool here that writes, and it takes the narrowest
 * shape that can: an exact, unique block of existing text and its
 * replacement — never "here is the whole new file". Requiring uniqueness
 * forces whatever proposed the edit to have actually read the surrounding
 * text, and confines one call's damage to one located block rather than
 * everything a confidently wrong full-file rewrite could destroy. It cannot
 * create a new file — `filesystem.writeTextFile` is the still-missing tool
 * for that (tracked in TODO.md); this one edits what already exists.
 */

const PATH_HINT =
  `An absolute path, or one of the shorthands ${shorthandNames().join(', ')}. ` +
  `~ and %ENVVAR% are expanded.`;

/** Directories never worth walking for source: build output, dependencies, VCS internals. */
const CODE_SEARCH_NOISE =
  /^(node_modules|\.git|\.svn|\.hg|dist|build|out|target|__pycache__|\.venv|venv|\.next|\.cache|\$recycle\.bin|system volume information)$/i;

/** Above this, a file is skipped rather than read — source files do not get this large. */
const MAX_SEARCHABLE_BYTES = 2 * 1024 * 1024;
const MAX_READABLE_BYTES = 1024 * 1024;
const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;

/** Same test `filesystem.readTextFile` uses: a NUL byte means "not text". */
function looksBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

async function readIfText(file: string, capBytes: number): Promise<Buffer | undefined> {
  const handle = await fs.open(file, 'r');
  try {
    const stats = await handle.stat();
    if (stats.size > capBytes) return undefined;
    const buffer = Buffer.alloc(stats.size);
    await handle.read(buffer, 0, buffer.length, 0);
    if (looksBinary(buffer)) return undefined;
    return buffer;
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// code.search
// ---------------------------------------------------------------------------

const SearchInput = z
  .object({
    directory: z.string().min(1).describe(`Where to search, recursively. ${PATH_HINT}`),
    query: z.string().min(1).describe('Case-insensitive text to find inside files.'),
    maxDepth: z.number().int().min(0).max(12).optional().describe('Folder depth to descend. Default 8.'),
    maxResults: z.number().int().min(1).max(500).optional().describe('Default 50.'),
  })
  .strict();
type SearchInput = z.infer<typeof SearchInput>;

export interface CodeMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export function createCodeSearchTool(
  policy: PathPolicy,
): AgentTool<SearchInput, { matches: CodeMatch[]; filesScanned: number; truncated: boolean }> {
  return {
    name: 'code.search',
    description:
      'Search inside files under a folder for a piece of text, returning the file, line number and ' +
      'matching line for each hit — this is "search the project for X", not "find a file named X" ' +
      '(use filesystem.search for that). Skips dependency and build directories automatically. Binary ' +
      'and oversized files are skipped, not read.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: SearchInput,
    verification: 'intrinsic',
    timeoutMs: 45_000,

    async execute(input, ctx): Promise<ToolResult<{ matches: CodeMatch[]; filesScanned: number; truncated: boolean }>> {
      const guarded = guardPath(policy, input.directory, 'read');
      if ('error' in guarded) return guarded.error;

      const needle = input.query.toLowerCase();
      const maxDepth = input.maxDepth ?? 8;
      const maxResults = input.maxResults ?? 50;

      const matches: CodeMatch[] = [];
      let filesScanned = 0;
      let truncated = false;

      const walk = async (directory: string, depth: number): Promise<void> => {
        if (depth > maxDepth || ctx.signal.aborted || matches.length >= maxResults) return;

        let entries: Dirent[];
        try {
          entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          if (ctx.signal.aborted || matches.length >= maxResults) {
            if (matches.length >= maxResults) truncated = true;
            return;
          }
          const full = path.join(directory, entry.name);

          if (entry.isDirectory()) {
            if (CODE_SEARCH_NOISE.test(entry.name)) continue;
            if (policy.isBlocked(full)) continue;
            await walk(full, depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;
          if (policy.isBlocked(full)) continue;

          let buffer: Buffer | undefined;
          try {
            buffer = await readIfText(full, MAX_SEARCHABLE_BYTES);
          } catch {
            continue;
          }
          if (!buffer) continue;
          filesScanned++;

          const lines = buffer.toString('utf8').split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) {
              truncated = true;
              break;
            }
            const line = lines[i]!;
            if (line.toLowerCase().includes(needle)) {
              matches.push({
                path: full,
                line: i + 1,
                text: line.length > 300 ? `${line.slice(0, 297)}…` : line,
              });
            }
          }
        }
      };

      await walk(guarded.path.absolute, 0);

      return ok({ matches, filesScanned, truncated });
    },
  };
}

// ---------------------------------------------------------------------------
// code.read
// ---------------------------------------------------------------------------

const ReadInput = z
  .object({
    path: z.string().min(1).describe(`The file to read. ${PATH_HINT}`),
    startLine: z.number().int().min(1).optional().describe('First line to include, 1-based. Omit to start at line 1.'),
    endLine: z.number().int().min(1).optional().describe('Last line to include. Omit to read to the end (bounded).'),
  })
  .strict();
type ReadInput = z.infer<typeof ReadInput>;

const MAX_LINES = 2000;

export function createCodeReadTool(
  policy: PathPolicy,
): AgentTool<ReadInput, { path: string; content: string; totalLines: number; truncated: boolean }> {
  return {
    name: 'code.read',
    description:
      'Read a source file with line numbers, optionally restricted to a line range for a large file. ' +
      'Use the exact line-numbered output as the source of the exact text code.edit needs. Binary ' +
      'files cannot be read this way.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: ReadInput,
    verification: 'intrinsic',
    timeoutMs: 15_000,

    async execute(input): Promise<ToolResult<{ path: string; content: string; totalLines: number; truncated: boolean }>> {
      const guarded = guardPath(policy, input.path, 'read');
      if ('error' in guarded) return guarded.error;

      let stats;
      try {
        stats = await fs.stat(guarded.path.absolute);
      } catch {
        return err('FILE_NOT_FOUND', `${guarded.path.absolute} does not exist.`, { recoverable: false });
      }
      if (stats.isDirectory()) {
        return err('INVALID_INPUT', `${guarded.path.absolute} is a folder, not a file.`, {
          recoverable: false,
        });
      }
      if (stats.size > MAX_READABLE_BYTES) {
        return err(
          'INVALID_INPUT',
          `${guarded.path.absolute} is too large to read in one call. Use startLine/endLine to read a range.`,
          { recoverable: false },
        );
      }

      const buffer = await fs.readFile(guarded.path.absolute).catch(() => undefined);
      if (!buffer) {
        return err('INTERNAL_ERROR', `Could not read ${guarded.path.absolute}.`, { recoverable: false });
      }
      if (looksBinary(buffer)) {
        return err(
          'INVALID_INPUT',
          `${path.basename(guarded.path.absolute)} is a binary file and cannot be read as text.`,
          { recoverable: false },
        );
      }

      const allLines = buffer.toString('utf8').split('\n');
      const start = Math.max(1, input.startLine ?? 1);
      const requestedEnd = input.endLine ?? allLines.length;
      const end = Math.min(allLines.length, requestedEnd, start + MAX_LINES - 1);

      const numbered = allLines
        .slice(start - 1, end)
        .map((line, i) => `${start + i}\t${line}`)
        .join('\n');

      return ok({
        path: guarded.path.absolute,
        content: numbered,
        totalLines: allLines.length,
        truncated: end < requestedEnd || end < allLines.length,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// code.edit
// ---------------------------------------------------------------------------

const EditInput = z
  .object({
    path: z.string().min(1).describe(`The file to edit. Must already exist. ${PATH_HINT}`),
    oldText: z
      .string()
      .min(1)
      .describe('The exact existing text to replace. Must appear exactly once in the file.'),
    newText: z.string().describe('The text to put in its place. May be empty, to delete oldText.'),
  })
  .strict();
type EditInput = z.infer<typeof EditInput>;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function preview(text: string, limit = 160): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

export function createCodeEditTool(
  policy: PathPolicy,
): AgentTool<EditInput, { path: string; occurrences: 1; expectedHash: string }> {
  return {
    name: 'code.edit',
    description:
      'Replace one exact, unique block of text in an existing file with new text. Read the file with ' +
      'code.read first and quote its content back exactly — the call is refused if oldText does not ' +
      'appear in the file, or appears more than once, rather than guessing which occurrence was meant. ' +
      'Cannot create a new file.',
    permission: 'write',
    // No version history is consulted, so "put it back" is a second edit the
    // user has to compose themselves — the same reasoning filesystem.move
    // uses for content that is not simply where it used to be.
    reversibility: 'irreversible',
    inputSchema: EditInput,
    verification: 'explicit',
    timeoutMs: 20_000,

    describeEffect(input): string {
      return (
        `Edit ${input.path}: replace "${preview(input.oldText)}" with ` +
        `"${input.newText === '' ? '(nothing)' : preview(input.newText)}".`
      );
    },

    async execute(input): Promise<ToolResult<{ path: string; occurrences: 1; expectedHash: string }>> {
      const guarded = guardPath(policy, input.path, 'modify');
      if ('error' in guarded) return guarded.error;

      let stats;
      try {
        stats = await fs.stat(guarded.path.absolute);
      } catch {
        return err(
          'FILE_NOT_FOUND',
          `${guarded.path.absolute} does not exist. code.edit only modifies existing files.`,
          { recoverable: false },
        );
      }
      if (stats.isDirectory()) {
        return err('INVALID_INPUT', `${guarded.path.absolute} is a folder, not a file.`, {
          recoverable: false,
        });
      }
      if (stats.size > MAX_EDITABLE_BYTES) {
        return err('INVALID_INPUT', `${guarded.path.absolute} is too large to edit through this tool.`, {
          recoverable: false,
        });
      }

      const buffer = await fs.readFile(guarded.path.absolute).catch(() => undefined);
      if (!buffer) {
        return err('INTERNAL_ERROR', `Could not read ${guarded.path.absolute}.`, { recoverable: false });
      }
      if (looksBinary(buffer)) {
        return err(
          'INVALID_INPUT',
          `${path.basename(guarded.path.absolute)} is a binary file and cannot be edited as text.`,
          { recoverable: false },
        );
      }

      const content = buffer.toString('utf8');
      const first = content.indexOf(input.oldText);
      if (first === -1) {
        return err(
          'INVALID_INPUT',
          `That exact text was not found in ${path.basename(guarded.path.absolute)}. ` +
            `Read the file again with code.read and quote it exactly.`,
          { recoverable: true },
        );
      }
      const second = content.indexOf(input.oldText, first + input.oldText.length);
      if (second !== -1) {
        return err(
          'INVALID_INPUT',
          `That text appears more than once in ${path.basename(guarded.path.absolute)}, so which ` +
            `occurrence was meant is ambiguous. Include more surrounding context to identify exactly one.`,
          { recoverable: true },
        );
      }

      const newContent =
        content.slice(0, first) + input.newText + content.slice(first + input.oldText.length);

      try {
        await fs.writeFile(guarded.path.absolute, newContent, 'utf8');
      } catch (cause) {
        return err('PERMISSION_DENIED', `Could not write ${guarded.path.absolute}: ${String(cause)}`, {
          recoverable: false,
        });
      }

      return ok({
        path: guarded.path.absolute,
        occurrences: 1,
        // The expected content's hash, not the content itself — keeps the
        // result (and the logs and audit trail it flows into) small even for
        // a large file, while still letting `verify` catch a real mismatch.
        expectedHash: sha256(newContent),
      });
    },

    async verify(_input, result): Promise<Verification> {
      if (!result.success || !result.data) {
        return verification('not-applicable', 'Nothing was edited.');
      }
      const { path: file, expectedHash } = result.data;
      try {
        const rewritten = await fs.readFile(file, 'utf8');
        return sha256(rewritten) === expectedHash
          ? verification('verified', `${file} now contains exactly the intended change.`)
          : verification(
              'failed',
              `${file} was written, but reading it back does not match what was intended — ` +
                `something else may have changed it at the same time.`,
            );
      } catch (cause) {
        return verification('unverified', `Could not re-read ${file} to confirm: ${String(cause)}`);
      }
    },
  };
}
