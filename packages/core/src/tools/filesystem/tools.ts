import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  err,
  ok,
  verification,
  type AgentTool,
  type ToolResult,
  type Verification,
} from '@samix/shared';
import type { PathPolicy } from '../../security/path-policy.js';
import { formatBytes, guardPath, shorthandNames, toAbsolutePath } from './guard.js';

/**
 * Filesystem tools (spec §12) — Phase 4.
 *
 * This is the first namespace whose verifiers do real work. `system.getInfo` is
 * `intrinsic` — its return value is the observation — so until now nothing had
 * ever re-opened the world to check a claim. Here a copy is confirmed by stat-ing
 * the destination and comparing its size to the source, which is the pattern
 * ADR-0004 was written in anticipation of.
 *
 * Every tool is a factory taking the {@link PathPolicy}, because policy is
 * user-configurable at runtime and a tool holding a stale copy would enforce
 * yesterday's trusted folders.
 */

const PATH_HINT =
  `An absolute path such as C:\\Users\\me\\Documents\\report.pdf, or one of the shorthands ` +
  `${shorthandNames().join(', ')}. ~ and %ENVVAR% are expanded.`;

/** Directories that make a recursive search useless if walked. */
const SEARCH_NOISE = /^(node_modules|\.git|\.svn|__pycache__|\$recycle\.bin|system volume information)$/i;

/** Reading a file into the planner's context has to be bounded. */
const MAX_READ_BYTES = 256 * 1024;

interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'directory' | 'other';
  readonly sizeBytes?: number;
  readonly modified?: string;
}

async function describeEntry(full: string, name: string): Promise<FileEntry> {
  try {
    const stats = await fs.lstat(full);
    const type = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
    return {
      name,
      path: full,
      type,
      ...(type === 'file' ? { sizeBytes: stats.size } : {}),
      modified: stats.mtime.toISOString(),
    };
  } catch {
    // A file can vanish between readdir and lstat. Reporting it as unreadable
    // beats failing the whole listing.
    return { name, path: full, type: 'other' };
  }
}

/** Map a Node fs error onto the closed taxonomy the planner branches on. */
function fromNodeError(cause: unknown, target: string): ToolResult<never> {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
      return err('FILE_NOT_FOUND', `${target} does not exist.`, { details: { path: target } });
    case 'EACCES':
    case 'EPERM':
      return err('PERMISSION_DENIED', `Windows denied access to ${target}.`, {
        recoverable: false,
        details: { path: target },
      });
    case 'ENOTDIR':
      return err('INVALID_INPUT', `${target} is not a directory.`, { recoverable: false });
    case 'EEXIST':
      return err('INVALID_INPUT', `${target} already exists.`, { recoverable: false });
    case 'EBUSY':
      return err('ACTION_BLOCKED', `${target} is in use by another program.`);
    default:
      return err('INTERNAL_ERROR', `${target}: ${String(cause)}`);
  }
}

// ---------------------------------------------------------------------------
// listDirectory
// ---------------------------------------------------------------------------

const ListInput = z
  .object({
    path: z.string().min(1).describe(`The folder to list. ${PATH_HINT}`),
    includeHidden: z.boolean().optional().describe('Include entries beginning with a dot.'),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
type ListInput = z.infer<typeof ListInput>;

export function createListDirectoryTool(
  policy: PathPolicy,
): AgentTool<ListInput, { path: string; entries: FileEntry[]; truncated: boolean }> {
  return {
    name: 'filesystem.listDirectory',
    description:
      'List the files and folders directly inside a folder, with their sizes and modification ' +
      'times. Use this to see what is in a known location. To find something whose location you ' +
      'do not know, use filesystem.search instead.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: ListInput,
    verification: 'intrinsic',
    timeoutMs: 15_000,

    async execute(input) {
      const guarded = guardPath(policy, input.path, 'read');
      if ('error' in guarded) return guarded.error;

      try {
        const names = await fs.readdir(guarded.path.absolute);
        const visible = input.includeHidden ? names : names.filter((n) => !n.startsWith('.'));
        const limit = input.limit ?? 100;

        const entries = await Promise.all(
          visible
            .slice(0, limit)
            .map((name) => describeEntry(path.join(guarded.path.absolute, name), name)),
        );

        return ok({
          path: guarded.path.absolute,
          entries,
          truncated: visible.length > limit,
        });
      } catch (cause) {
        return fromNodeError(cause, guarded.path.absolute);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const SearchInput = z
  .object({
    query: z
      .string()
      .optional()
      .describe('Case-insensitive text that must appear in the file name. Omit to match everything.'),
    directory: z.string().optional().describe(`Where to search. ${PATH_HINT} Defaults to home.`),
    extension: z.string().optional().describe('File extension filter, e.g. "pdf" or ".pdf".'),
    maxDepth: z.number().int().min(0).max(8).optional().describe('Folder depth to descend. Default 4.'),
    maxResults: z.number().int().min(1).max(200).optional(),
    sortBy: z
      .enum(['modified', 'name', 'size'])
      .optional()
      .describe('Ordering. "modified" (newest first) is the default and answers "my latest X".'),
  })
  .strict();
type SearchInput = z.infer<typeof SearchInput>;

export function createSearchTool(
  policy: PathPolicy,
): AgentTool<SearchInput, { matches: FileEntry[]; searched: string; scanned: number }> {
  return {
    name: 'filesystem.search',
    description:
      'Find files by name, extension or recency underneath a folder. This is the tool for ' +
      '"find my latest PDF", "where is my CV" or "what spreadsheets do I have". Returns matches ' +
      'newest-first by default, so the first result answers "the latest one".',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: SearchInput,
    verification: 'intrinsic',
    timeoutMs: 45_000,

    async execute(input, ctx) {
      const guarded = guardPath(policy, input.directory ?? 'home', 'read');
      if ('error' in guarded) return guarded.error;

      const needle = input.query?.toLowerCase();
      const extension = input.extension
        ? `.${input.extension.replace(/^\./, '').toLowerCase()}`
        : undefined;
      const maxResults = input.maxResults ?? 50;
      const maxDepth = input.maxDepth ?? 4;

      const matches: FileEntry[] = [];
      let scanned = 0;

      const walk = async (directory: string, depth: number): Promise<void> => {
        // Cancellation is checked per directory rather than per file: a deep
        // scan must stop promptly on emergency stop, but stat-ing one more file
        // is cheaper than an abort check per entry.
        if (depth > maxDepth || ctx.signal.aborted) return;

        let entries: Awaited<ReturnType<typeof fs.readdir>>;
        try {
          entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
          return; // Unreadable subtree — normal, and not worth failing over.
        }

        for (const entry of entries) {
          if (ctx.signal.aborted) return;
          const full = path.join(directory, entry.name);

          if (entry.isDirectory()) {
            if (SEARCH_NOISE.test(entry.name)) continue;
            // Never descend into a blocked subtree, even while only reading.
            if (policy.isBlocked(full)) continue;
            await walk(full, depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;

          scanned++;
          if (extension && !entry.name.toLowerCase().endsWith(extension)) continue;
          if (needle && !entry.name.toLowerCase().includes(needle)) continue;

          matches.push(await describeEntry(full, entry.name));
        }
      };

      await walk(guarded.path.absolute, 0);

      const sortBy = input.sortBy ?? 'modified';
      matches.sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name);
        if (sortBy === 'size') return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
        return (b.modified ?? '').localeCompare(a.modified ?? '');
      });

      return ok({
        matches: matches.slice(0, maxResults),
        searched: guarded.path.absolute,
        scanned,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// getMetadata
// ---------------------------------------------------------------------------

const MetadataInput = z
  .object({ path: z.string().min(1).describe(`The file or folder to inspect. ${PATH_HINT}`) })
  .strict();
type MetadataInput = z.infer<typeof MetadataInput>;

export function createMetadataTool(policy: PathPolicy): AgentTool<MetadataInput, FileEntry & { exists: true }> {
  return {
    name: 'filesystem.getMetadata',
    description:
      'Report the size, type and modification time of one file or folder, and confirm it exists. ' +
      'Use this to check something is there before acting on it.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: MetadataInput,
    verification: 'intrinsic',
    timeoutMs: 10_000,

    async execute(input) {
      const guarded = guardPath(policy, input.path, 'read');
      if ('error' in guarded) return guarded.error;

      try {
        const entry = await describeEntry(
          guarded.path.absolute,
          path.basename(guarded.path.absolute),
        );
        await fs.access(guarded.path.absolute);
        return ok({ ...entry, exists: true as const });
      } catch (cause) {
        return fromNodeError(cause, guarded.path.absolute);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// readTextFile
// ---------------------------------------------------------------------------

const ReadInput = z
  .object({
    path: z.string().min(1).describe(`The text file to read. ${PATH_HINT}`),
    maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).optional(),
  })
  .strict();
type ReadInput = z.infer<typeof ReadInput>;

export function createReadTextFileTool(
  policy: PathPolicy,
): AgentTool<ReadInput, { path: string; content: string; truncated: boolean; sizeBytes: number }> {
  return {
    name: 'filesystem.readTextFile',
    description:
      'Read the contents of a text file so you can answer questions about it. Only for text — ' +
      'source code, notes, CSV, JSON, logs. Binary files such as PDFs, images and Office documents ' +
      'cannot be read this way. Large files are truncated.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: ReadInput,
    verification: 'intrinsic',
    timeoutMs: 15_000,

    async execute(input) {
      const guarded = guardPath(policy, input.path, 'read');
      if ('error' in guarded) return guarded.error;

      const limit = input.maxBytes ?? MAX_READ_BYTES;
      try {
        const stats = await fs.stat(guarded.path.absolute);
        if (stats.isDirectory()) {
          return err('INVALID_INPUT', `${guarded.path.absolute} is a folder, not a file.`, {
            recoverable: false,
          });
        }

        const handle = await fs.open(guarded.path.absolute, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(limit, stats.size));
          await handle.read(buffer, 0, buffer.length, 0);

          // A NUL byte in the first block is the practical test for "this is not
          // text". Decoding a PDF as UTF-8 produces pages of replacement
          // characters that waste the planner's context and answer nothing.
          if (buffer.includes(0)) {
            return err(
              'INVALID_INPUT',
              `${path.basename(guarded.path.absolute)} is a binary file and cannot be read as text.`,
              { recoverable: false, details: { path: guarded.path.absolute } },
            );
          }

          return ok({
            path: guarded.path.absolute,
            content: buffer.toString('utf8'),
            truncated: stats.size > buffer.length,
            sizeBytes: stats.size,
          });
        } finally {
          await handle.close();
        }
      } catch (cause) {
        return fromNodeError(cause, guarded.path.absolute);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// createDirectory
// ---------------------------------------------------------------------------

const CreateDirInput = z
  .object({ path: z.string().min(1).describe(`The folder to create. ${PATH_HINT}`) })
  .strict();
type CreateDirInput = z.infer<typeof CreateDirInput>;

export function createCreateDirectoryTool(
  policy: PathPolicy,
): AgentTool<CreateDirInput, { path: string; created: boolean }> {
  return {
    name: 'filesystem.createDirectory',
    description:
      'Create a folder, including any missing parent folders. Succeeds harmlessly if it already exists.',
    permission: 'write',
    reversibility: 'reversible',
    inputSchema: CreateDirInput,
    verification: 'explicit',
    timeoutMs: 10_000,

    async execute(input) {
      const guarded = guardPath(policy, input.path, 'modify');
      if ('error' in guarded) return guarded.error;

      try {
        const existed = await fs
          .stat(guarded.path.absolute)
          .then(() => true)
          .catch(() => false);
        await fs.mkdir(guarded.path.absolute, { recursive: true });
        return ok({ path: guarded.path.absolute, created: !existed });
      } catch (cause) {
        return fromNodeError(cause, guarded.path.absolute);
      }
    },

    async verify(input): Promise<Verification> {
      const absolute = toAbsolutePath(input.path);
      try {
        const stats = await fs.stat(absolute);
        return stats.isDirectory()
          ? verification('verified', `${absolute} exists and is a folder.`)
          : verification('failed', `${absolute} exists but is not a folder.`);
      } catch {
        return verification('failed', `${absolute} does not exist.`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

const CopyInput = z
  .object({
    source: z.string().min(1).describe(`The file to copy. ${PATH_HINT}`),
    destination: z
      .string()
      .min(1)
      .describe('Destination path. If it names an existing folder, the file is copied into it.'),
    overwrite: z.boolean().optional().describe('Replace the destination if it already exists.'),
  })
  .strict();
type CopyInput = z.infer<typeof CopyInput>;

/** Copying onto a folder means "into it" — what a user means by "copy to Desktop". */
async function resolveDestination(source: string, destination: string): Promise<string> {
  const stats = await fs.stat(destination).catch(() => undefined);
  return stats?.isDirectory() ? path.join(destination, path.basename(source)) : destination;
}

export function createCopyTool(
  policy: PathPolicy,
): AgentTool<CopyInput, { source: string; destination: string; sizeBytes: number }> {
  return {
    name: 'filesystem.copy',
    description:
      'Copy a file to another location. The original is left untouched. If the destination is an ' +
      'existing folder the file is copied into it, keeping its name. Refuses to overwrite unless ' +
      'told to.',
    permission: 'write',
    reversibility: 'reversible',
    inputSchema: CopyInput,
    verification: 'explicit',
    timeoutMs: 60_000,

    async execute(input) {
      const from = guardPath(policy, input.source, 'read');
      if ('error' in from) return from.error;
      const to = guardPath(policy, input.destination, 'modify');
      if ('error' in to) return to.error;

      try {
        const target = await resolveDestination(from.path.absolute, to.path.absolute);
        const exists = await fs
          .stat(target)
          .then(() => true)
          .catch(() => false);
        if (exists && input.overwrite !== true) {
          return err('INVALID_INPUT', `${target} already exists. Set overwrite to replace it.`, {
            recoverable: false,
            details: { destination: target },
          });
        }

        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(from.path.absolute, target);
        const stats = await fs.stat(target);

        return ok({ source: from.path.absolute, destination: target, sizeBytes: stats.size });
      } catch (cause) {
        return fromNodeError(cause, from.path.absolute);
      }
    },

    /**
     * The verification ADR-0004 was written for: re-open both files and compare.
     * "copyFile did not throw" is the tool's claim; "the destination exists and
     * is the same size as the source" is an observation of the world.
     */
    async verify(_input, result): Promise<Verification> {
      if (!result.success || !result.data) {
        return verification('not-applicable', 'Nothing was copied.');
      }
      const { source, destination } = result.data;
      try {
        const [sourceStats, destStats] = await Promise.all([fs.stat(source), fs.stat(destination)]);
        if (sourceStats.size !== destStats.size) {
          return verification(
            'failed',
            `${destination} is ${formatBytes(destStats.size)} but the source is ` +
              `${formatBytes(sourceStats.size)} — the copy is incomplete.`,
          );
        }
        return verification(
          'verified',
          `${destination} exists and matches the source at ${formatBytes(destStats.size)}.`,
        );
      } catch (cause) {
        return verification('failed', `Could not confirm the copy: ${String(cause)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

const MoveInput = z
  .object({
    source: z.string().min(1).describe(`The file or folder to move. ${PATH_HINT}`),
    destination: z.string().min(1).describe('Where to move it. An existing folder means "into it".'),
    overwrite: z.boolean().optional(),
  })
  .strict();
type MoveInput = z.infer<typeof MoveInput>;

export function createMoveTool(
  policy: PathPolicy,
): AgentTool<MoveInput, { source: string; destination: string }> {
  return {
    name: 'filesystem.move',
    description:
      'Move a file or folder to another location. The original location no longer has it, so this ' +
      'cannot be undone automatically. To change only the name of something, use filesystem.rename.',
    permission: 'write',
    // The bytes are not lost, but "put it back" is a second operation the user
    // has to ask for. `unknown` would understate it; this is not a copy.
    reversibility: 'irreversible',
    inputSchema: MoveInput,
    verification: 'explicit',
    timeoutMs: 60_000,

    describeEffect(input): string {
      return `Move ${input.source} to ${input.destination}.`;
    },

    async execute(input) {
      const from = guardPath(policy, input.source, 'modify');
      if ('error' in from) return from.error;
      const to = guardPath(policy, input.destination, 'modify');
      if ('error' in to) return to.error;

      try {
        const target = await resolveDestination(from.path.absolute, to.path.absolute);
        const exists = await fs
          .stat(target)
          .then(() => true)
          .catch(() => false);
        if (exists && input.overwrite !== true) {
          return err('INVALID_INPUT', `${target} already exists. Set overwrite to replace it.`, {
            recoverable: false,
          });
        }

        await fs.mkdir(path.dirname(target), { recursive: true });
        try {
          await fs.rename(from.path.absolute, target);
        } catch (cause) {
          // Renaming across volumes fails with EXDEV; copy-then-delete is the
          // documented fallback and is what every file manager does.
          if ((cause as NodeJS.ErrnoException).code !== 'EXDEV') throw cause;
          await fs.copyFile(from.path.absolute, target);
          await fs.unlink(from.path.absolute);
        }

        return ok({ source: from.path.absolute, destination: target });
      } catch (cause) {
        return fromNodeError(cause, from.path.absolute);
      }
    },

    async verify(_input, result): Promise<Verification> {
      if (!result.success || !result.data) {
        return verification('not-applicable', 'Nothing was moved.');
      }
      const { source, destination } = result.data;

      const arrived = await fs
        .stat(destination)
        .then(() => true)
        .catch(() => false);
      const departed = await fs
        .stat(source)
        .then(() => false)
        .catch(() => true);

      if (arrived && departed) {
        return verification('verified', `${destination} exists and ${source} no longer does.`);
      }
      if (arrived && !departed) {
        // The dangerous half-state, and the reason both ends are checked.
        return verification('failed', `${destination} exists but ${source} is still there too.`);
      }
      return verification('failed', `${destination} does not exist — the move did not take effect.`);
    },
  };
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

const RenameInput = z
  .object({
    path: z.string().min(1).describe(`The file or folder to rename. ${PATH_HINT}`),
    newName: z
      .string()
      .min(1)
      .describe('The new name only, not a path. The item stays in the same folder.'),
  })
  .strict();
type RenameInput = z.infer<typeof RenameInput>;

export function createRenameTool(
  policy: PathPolicy,
): AgentTool<RenameInput, { from: string; to: string }> {
  return {
    name: 'filesystem.rename',
    description:
      'Change the name of a file or folder, leaving it where it is. Use this rather than ' +
      'filesystem.move when only the name changes.',
    permission: 'write',
    reversibility: 'reversible',
    inputSchema: RenameInput,
    verification: 'explicit',
    timeoutMs: 15_000,

    async execute(input) {
      const guarded = guardPath(policy, input.path, 'modify');
      if ('error' in guarded) return guarded.error;

      // A "name" containing a separator is a move wearing a disguise, and would
      // escape the folder this tool promises to stay inside.
      if (/[\\/]/.test(input.newName) || input.newName === '.' || input.newName === '..') {
        return err('INVALID_INPUT', `"${input.newName}" is a path, not a name. Use filesystem.move.`, {
          recoverable: false,
        });
      }

      const target = path.join(path.dirname(guarded.path.absolute), input.newName);
      const targetGuard = guardPath(policy, target, 'modify');
      if ('error' in targetGuard) return targetGuard.error;

      try {
        const taken = await fs
          .stat(target)
          .then(() => true)
          .catch(() => false);
        if (taken) {
          return err('INVALID_INPUT', `${input.newName} already exists in that folder.`, {
            recoverable: false,
          });
        }
        await fs.rename(guarded.path.absolute, target);
        return ok({ from: guarded.path.absolute, to: target });
      } catch (cause) {
        return fromNodeError(cause, guarded.path.absolute);
      }
    },

    async verify(_input, result): Promise<Verification> {
      if (!result.success || !result.data) return verification('not-applicable', 'Nothing was renamed.');
      const { from, to } = result.data;
      const arrived = await fs
        .stat(to)
        .then(() => true)
        .catch(() => false);
      const departed = await fs
        .stat(from)
        .then(() => false)
        .catch(() => true);
      return arrived && departed
        ? verification('verified', `${to} exists and the old name is gone.`)
        : verification('failed', `The rename did not take effect.`);
    },
  };
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

const DeleteInput = z
  .object({
    path: z.string().min(1).describe(`The file or folder to delete permanently. ${PATH_HINT}`),
    recursive: z
      .boolean()
      .optional()
      .describe('Required to delete a folder that has anything in it.'),
  })
  .strict();
type DeleteInput = z.infer<typeof DeleteInput>;

/** Count what a recursive delete would destroy, for the confirmation prompt. */
async function countContents(target: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      files++;
      bytes += await fs
        .stat(full)
        .then((s) => s.size)
        .catch(() => 0);
    }
  };

  const stats = await fs.stat(target).catch(() => undefined);
  if (!stats) return { files: 0, bytes: 0 };
  if (stats.isFile()) return { files: 1, bytes: stats.size };
  await walk(target, 0);
  return { files, bytes };
}

export function createDeleteTool(
  policy: PathPolicy,
): AgentTool<DeleteInput, { path: string; filesDeleted: number; bytesFreed: number }> {
  return {
    name: 'filesystem.delete',
    description:
      'Permanently delete a file or folder. This does NOT use the Recycle Bin — the data is gone ' +
      'and cannot be recovered. Always confirm the exact path with the user before calling this if ' +
      'there is any ambiguity about what they meant.',
    permission: 'destructive',
    reversibility: 'irreversible',
    inputSchema: DeleteInput,
    verification: 'explicit',
    timeoutMs: 60_000,

    /**
     * Spec §95 wants the *scale* in the prompt, not just the path: "this will
     * permanently delete 184 files" is the sentence that stops a bad delete.
     *
     * `describeEffect` is synchronous by contract, so it cannot stat the tree;
     * the count is produced during execute and logged, while the prompt states
     * the irreversibility plainly. Making this async is tracked in TODO.md.
     */
    describeEffect(input): string {
      const what = input.recursive === true ? 'and everything inside it' : '';
      return `Permanently delete ${toAbsolutePath(input.path)} ${what}`.trim() +
        '. This does not use the Recycle Bin and cannot be undone.';
    },

    async execute(input) {
      const guarded = guardPath(policy, input.path, 'modify');
      if ('error' in guarded) return guarded.error;

      try {
        const stats = await fs.stat(guarded.path.absolute);
        const { files, bytes } = await countContents(guarded.path.absolute);

        if (stats.isDirectory()) {
          const entries = await fs.readdir(guarded.path.absolute);
          if (entries.length > 0 && input.recursive !== true) {
            return err(
              'INVALID_INPUT',
              `${guarded.path.absolute} is not empty (${files} files). ` +
                `Set recursive to delete it and everything inside.`,
              { recoverable: false, details: { files } },
            );
          }
          await fs.rm(guarded.path.absolute, { recursive: true, force: false });
        } else {
          await fs.unlink(guarded.path.absolute);
        }

        return ok({ path: guarded.path.absolute, filesDeleted: files, bytesFreed: bytes });
      } catch (cause) {
        return fromNodeError(cause, guarded.path.absolute);
      }
    },

    async verify(_input, result): Promise<Verification> {
      if (!result.success || !result.data) return verification('not-applicable', 'Nothing was deleted.');
      const target = result.data.path;
      const stillThere = await fs
        .stat(target)
        .then(() => true)
        .catch(() => false);
      return stillThere
        ? verification('failed', `${target} still exists.`)
        : verification(
            'verified',
            `${target} no longer exists (${result.data.filesDeleted} files, ` +
              `${formatBytes(result.data.bytesFreed)} freed).`,
          );
    },
  };
}
