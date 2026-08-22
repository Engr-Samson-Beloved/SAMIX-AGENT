import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { err, ok, verification, type AgentTool, type ToolResult, type Verification } from '@samix/shared';
import type { AppRegistry } from '../apps/app-registry.js';
import { launchDetached, verifyRunning } from '../apps/tools.js';
import type { PathPolicy } from '../../security/path-policy.js';
import { guardPath, shorthandNames } from '../filesystem/guard.js';

/**
 * Project tools (spec §23) — Phase 10.
 *
 * `project.detect` answers "what kind of project is this, and how do I build
 * it" from structural signals already on disk — no memory or configuration
 * lookup, because nothing resolves "my SkoolConnect project" to a path yet
 * (that arrives with Phase 9). Until then the planner must be given, or must
 * find, the path itself; this tool starts from there.
 *
 * `project.open` is a narrow, deliberate exception to `app.launch`'s "never
 * takes an argument" rule (see apps/tools.ts) — an editor opened with no
 * folder is not what "open my project" means. It stays a separate tool
 * rather than widening `app.launch`, so that invariant holds for everything
 * else that calls it.
 */

const PATH_HINT =
  `An absolute path such as C:\\Projects\\my-app, or one of the shorthands ` +
  `${shorthandNames().join(', ')}. ~ and %ENVVAR% are expanded.`;

// ---------------------------------------------------------------------------
// project.detect
// ---------------------------------------------------------------------------

const DetectInput = z
  .object({ path: z.string().min(1).describe(`The project folder to inspect. ${PATH_HINT}`) })
  .strict();
type DetectInput = z.infer<typeof DetectInput>;

export type ProjectKind = 'node' | 'rust' | 'python' | 'go' | 'dotnet';

export interface ProjectInfo {
  readonly path: string;
  /** More than one when a repo mixes toolchains — this one does (TS + Python). */
  readonly kinds: ProjectKind[];
  readonly name?: string;
  readonly packageManager?: 'pnpm' | 'npm' | 'yarn';
  /** `package.json`'s `scripts`, unfiltered — the planner decides which is relevant. */
  readonly scripts?: Record<string, string>;
  readonly hasGit: boolean;
  readonly hasReadme: boolean;
}

/** Best-effort `name = "..."` extraction from a Cargo.toml `[package]` table. */
function extractCargoName(toml: string): string | undefined {
  const packageSection = toml.match(/^\[package\]([\s\S]*?)(?:^\[|$(?![\s\S]))/m)?.[1] ?? toml;
  return packageSection.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
}

async function exists(target: string): Promise<boolean> {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

export function createProjectDetectTool(policy: PathPolicy): AgentTool<DetectInput, ProjectInfo> {
  return {
    name: 'project.detect',
    description:
      'Inspect a folder and report what kind of software project it is — Node/pnpm, Rust, Python, ' +
      'Go, .NET, more than one at once for a mixed repo, or none — along with its declared name, ' +
      'package manager, the scripts it defines (for "run the tests", "check the build") and whether ' +
      'it is a git repository. Read-only; nothing is run. Use this before terminal.execute so the ' +
      'command chosen actually matches the project.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: DetectInput,
    verification: 'intrinsic',
    timeoutMs: 15_000,

    async execute(input): Promise<ToolResult<ProjectInfo>> {
      const guarded = guardPath(policy, input.path, 'read');
      if ('error' in guarded) return guarded.error;
      const root = guarded.path.absolute;

      let stats;
      try {
        stats = await fs.stat(root);
      } catch {
        return err('FILE_NOT_FOUND', `${root} does not exist.`, { recoverable: false });
      }
      if (!stats.isDirectory()) {
        return err('INVALID_INPUT', `${root} is a file, not a project folder.`, { recoverable: false });
      }

      const kinds: ProjectKind[] = [];
      let name: string | undefined;
      let packageManager: ProjectInfo['packageManager'];
      let scripts: Record<string, string> | undefined;

      const packageJsonPath = path.join(root, 'package.json');
      if (await exists(packageJsonPath)) {
        kinds.push('node');
        try {
          const parsed = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
            name?: unknown;
            scripts?: unknown;
          };
          if (typeof parsed.name === 'string') name = parsed.name;
          if (parsed.scripts && typeof parsed.scripts === 'object') {
            scripts = Object.fromEntries(
              Object.entries(parsed.scripts as Record<string, unknown>).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            );
          }
        } catch {
          // A package.json that fails to parse still means "this is a Node
          // project" — just one whose name and scripts cannot be reported.
        }
        if (await exists(path.join(root, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
        else if (await exists(path.join(root, 'yarn.lock'))) packageManager = 'yarn';
        else if (await exists(path.join(root, 'package-lock.json'))) packageManager = 'npm';
      }

      const cargoPath = path.join(root, 'Cargo.toml');
      if (await exists(cargoPath)) {
        kinds.push('rust');
        name ??= extractCargoName(await fs.readFile(cargoPath, 'utf8').catch(() => ''));
      }

      if (
        (await exists(path.join(root, 'pyproject.toml'))) ||
        (await exists(path.join(root, 'requirements.txt'))) ||
        (await exists(path.join(root, 'setup.py')))
      ) {
        kinds.push('python');
      }

      if (await exists(path.join(root, 'go.mod'))) kinds.push('go');

      const csproj = await fs
        .readdir(root)
        .then((names) => names.some((n) => n.endsWith('.csproj') || n.endsWith('.sln')))
        .catch(() => false);
      if (csproj) kinds.push('dotnet');

      const hasGit = await exists(path.join(root, '.git'));
      const hasReadme =
        (await exists(path.join(root, 'README.md'))) || (await exists(path.join(root, 'readme.md')));

      return ok({
        path: root,
        kinds,
        ...(name ? { name } : {}),
        ...(packageManager ? { packageManager } : {}),
        ...(scripts ? { scripts } : {}),
        hasGit,
        hasReadme,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// project.open
// ---------------------------------------------------------------------------

const OpenInput = z
  .object({
    path: z.string().min(1).describe(`The project folder to open. ${PATH_HINT}`),
    editor: z
      .string()
      .optional()
      .describe('Which editor to use, e.g. "VS Code". Defaults to VS Code.'),
  })
  .strict();
type OpenInput = z.infer<typeof OpenInput>;

export interface ProjectOpenResult {
  readonly editor: string;
  readonly executable: string;
  readonly path: string;
  readonly pid?: number;
}

export function createProjectOpenTool(
  apps: AppRegistry,
  policy: PathPolicy,
): AgentTool<OpenInput, ProjectOpenResult> {
  return {
    name: 'project.open',
    description:
      'Open a project folder in a code editor (VS Code by default) — what "open my project" or ' +
      '"open this in the editor" means. Unlike app.launch, this passes the folder to the editor so ' +
      'it opens scoped to that project rather than opening blank.',
    permission: 'write',
    // The user can just close the editor window; nothing about the project changes.
    reversibility: 'reversible',
    inputSchema: OpenInput,
    verification: 'explicit',
    timeoutMs: 20_000,

    async execute(input): Promise<ToolResult<ProjectOpenResult>> {
      const guarded = guardPath(policy, input.path, 'read');
      if ('error' in guarded) return guarded.error;

      let stats;
      try {
        stats = await fs.stat(guarded.path.absolute);
      } catch {
        return err('FILE_NOT_FOUND', `${guarded.path.absolute} does not exist.`, { recoverable: false });
      }
      if (!stats.isDirectory()) {
        return err('INVALID_INPUT', `${guarded.path.absolute} is a file, not a folder.`, {
          recoverable: false,
        });
      }

      const app = await apps.resolve(input.editor ?? 'VS Code');
      if (!app) {
        const suggestions = await apps.suggestions();
        return err(
          'APP_NOT_FOUND',
          `No installed editor matches "${input.editor ?? 'VS Code'}".`,
          { details: { requested: input.editor ?? 'VS Code', installed: suggestions } },
        );
      }
      if (app.kind !== 'editor') {
        return err('INVALID_INPUT', `${app.displayName} is not an editor.`, { recoverable: false });
      }

      const pid = launchDetached(app.executablePath, [guarded.path.absolute]);

      return ok({
        editor: app.displayName,
        executable: app.executablePath,
        path: guarded.path.absolute,
        ...(pid === undefined ? {} : { pid }),
      });
    },

    async verify(input, result, ctx): Promise<Verification> {
      if (!result.success) return verification('not-applicable', 'The launch itself failed.');
      const app = await apps.resolve(input.editor ?? 'VS Code');
      if (!app) return verification('unverified', 'The editor could no longer be resolved.');
      return verifyRunning(app, ctx.timeoutMs);
    },
  };
}
