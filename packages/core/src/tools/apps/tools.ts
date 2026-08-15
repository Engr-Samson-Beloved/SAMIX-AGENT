import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  err,
  ok,
  verification,
  type AgentTool,
  type ToolResult,
  type Verification,
} from '@samix/shared';
import { AppRegistry, type DiscoveredApp } from './app-registry.js';
import { closeProcess, isProcessRunning, listProcesses } from '../windows/processes.js';

/**
 * Application and process tools (spec §13, §14) — Phase 5.
 *
 * These are the first tools that change the state of the machine, so they are
 * also the first real exercise of the confirmation and verification pipeline
 * built in Phase 1.
 *
 * Every tool here is a factory rather than a constant, because they need the
 * shared {@link AppRegistry} — discovery is cached, and two tools resolving
 * names against two different caches would be able to disagree about what is
 * installed.
 */

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/**
 * Start a program, detached from this process.
 *
 * `detached: true` plus `unref()` is what stops the launched application from
 * dying with the agent: without it, closing SAMIX would take the user's browser
 * with it. `stdio: 'ignore'` is part of the same story — an inherited pipe that
 * nobody drains eventually blocks the child.
 *
 * `shell: false` is not the default worth relying on implicitly here: this is
 * the one place the agent starts a program the user named, and a shell would
 * make the executable path itself a command line.
 */
function launchDetached(executablePath: string, args: readonly string[]): number | undefined {
  const child = spawn(executablePath, [...args], {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: false,
  });
  child.unref();
  return child.pid;
}

/**
 * Confirm a launch by re-observing the process table, not by trusting the PID.
 *
 * The PID is genuinely unreliable for exactly the applications people ask for
 * most: launching `chrome.exe` while Chrome is already running hands the request
 * to the existing instance, and the process we spawned exits immediately. It did
 * work; the PID is gone. Asking "is a process with this image name running?"
 * answers the question the user actually cares about.
 */
async function verifyRunning(app: DiscoveredApp, timeoutMs: number): Promise<Verification> {
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  do {
    try {
      if (await isProcessRunning(app.imageName)) {
        return verification('verified', `${app.displayName} is running (${app.imageName}).`);
      }
    } catch (cause) {
      return verification('unverified', `Could not read the process list: ${String(cause)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  } while (Date.now() < deadline);

  return verification(
    'failed',
    `${app.displayName} was started but no ${app.imageName} process is running.`,
  );
}

const LaunchInput = z
  .object({
    name: z
      .string()
      .min(1)
      .describe(
        'The application to open, as a person would say it: "Chrome", "VS Code", "Notepad". ' +
          'Not a file path — paths are rejected.',
      ),
  })
  .strict();
type LaunchInput = z.infer<typeof LaunchInput>;

export interface LaunchResult {
  readonly app: string;
  readonly executable: string;
  readonly pid?: number;
  readonly alreadyRunning: boolean;
}

export function createAppLaunchTool(apps: AppRegistry): AgentTool<LaunchInput, LaunchResult> {
  return {
    name: 'app.launch',
    description:
      'Open an installed desktop application by name, such as Chrome, Visual Studio Code, Notepad or Calculator. ' +
      'Use app.list first if you are not certain the application is installed or what it is called. ' +
      'This cannot open a file path or run an arbitrary program — only applications discovered on this machine. ' +
      'To open a web page, use browser.openUrl instead.',
    permission: 'write',
    // The user can close whatever was opened; nothing is lost.
    reversibility: 'reversible',
    inputSchema: LaunchInput,
    verification: 'explicit',
    timeoutMs: 20_000,

    async execute(input): Promise<ToolResult<LaunchResult>> {
      const app = await apps.resolve(input.name);
      if (!app) {
        const suggestions = await apps.suggestions();
        return err('APP_NOT_FOUND', `No installed application matches "${input.name}".`, {
          // The planner can re-plan against this list rather than guessing again.
          details: { requested: input.name, installed: suggestions },
        });
      }

      const alreadyRunning = await isProcessRunning(app.imageName).catch(() => false);
      const pid = launchDetached(app.executablePath, []);

      return ok({
        app: app.displayName,
        executable: app.executablePath,
        ...(pid === undefined ? {} : { pid }),
        alreadyRunning,
      });
    },

    async verify(input, result, ctx): Promise<Verification> {
      if (!result.success) return verification('not-applicable', 'The launch itself failed.');
      const app = await apps.resolve(input.name);
      if (!app) return verification('unverified', 'The application could no longer be resolved.');
      return verifyRunning(app, ctx.timeoutMs);
    },
  };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

const ListAppsInput = z
  .object({
    kind: z
      .enum(['browser', 'editor', 'office', 'media', 'communication', 'utility'])
      .optional()
      .describe('Restrict the list to one category.'),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
type ListAppsInput = z.infer<typeof ListAppsInput>;

export interface AppSummary {
  readonly name: string;
  readonly kind: string;
  readonly running: boolean;
}

export function createAppListTool(apps: AppRegistry): AgentTool<ListAppsInput, { applications: AppSummary[] }> {
  return {
    name: 'app.list',
    description:
      'List the desktop applications installed on this computer, optionally filtered by category, ' +
      'and say which are currently running. Use this to check whether something is available before ' +
      'trying to open it, or to answer "what can I open?".',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: ListAppsInput,
    verification: 'intrinsic',
    timeoutMs: 30_000,

    async execute(input): Promise<ToolResult<{ applications: AppSummary[] }>> {
      const discovered = await apps.list();
      const running = new Set(
        await listProcesses()
          .then((entries) => entries.map((entry) => entry.imageName.toLowerCase()))
          .catch(() => []),
      );

      const applications = discovered
        .filter((app) => (input.kind ? app.kind === input.kind : true))
        .slice(0, input.limit ?? 60)
        .map((app) => ({
          name: app.displayName,
          kind: app.kind,
          running: running.has(app.imageName.toLowerCase()),
        }));

      return ok({ applications });
    },
  };
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

const CloseInput = z
  .object({
    name: z.string().min(1).describe('The application to close, e.g. "Notepad".'),
  })
  .strict();
type CloseInput = z.infer<typeof CloseInput>;

export function createAppCloseTool(
  apps: AppRegistry,
): AgentTool<CloseInput, { app: string; requested: number }> {
  return {
    name: 'app.close',
    description:
      'Ask a running application to close. This requests a graceful close, so the application may ' +
      'show a "save changes?" prompt and stay open — that is reported honestly rather than forced. ' +
      'Unsaved work in the application may be lost, so this always asks the user first.',
    permission: 'destructive',
    // Whatever was on screen, and anything unsaved, does not come back.
    reversibility: 'irreversible',
    inputSchema: CloseInput,
    verification: 'explicit',
    timeoutMs: 25_000,

    // Required for destructive tools: this is the sentence in the confirmation
    // prompt, and it is the user's last chance to notice we mean the wrong app.
    describeEffect(input): string {
      return `Close ${input.name}. Any unsaved work in it may be lost.`;
    },

    async execute(input): Promise<ToolResult<{ app: string; requested: number }>> {
      const app = await apps.resolve(input.name);
      if (!app) {
        return err('APP_NOT_FOUND', `No installed application matches "${input.name}".`, {
          details: { requested: input.name },
        });
      }

      try {
        const { requested } = await closeProcess(app.imageName);
        if (requested === 0) {
          return err('APP_NOT_FOUND', `${app.displayName} is not running.`, {
            recoverable: false,
            details: { app: app.displayName },
          });
        }
        return ok({ app: app.displayName, requested });
      } catch (cause) {
        return err('INTERNAL_ERROR', String(cause));
      }
    },

    async verify(input, result): Promise<Verification> {
      if (!result.success) return verification('not-applicable', 'Nothing was closed.');
      const app = await apps.resolve(input.name);
      if (!app) return verification('unverified', 'The application could no longer be resolved.');

      // A graceful close is not instant; give the window a moment to go.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      try {
        const stillRunning = await isProcessRunning(app.imageName);
        return stillRunning
          ? verification(
              'failed',
              `${app.displayName} is still running — it likely asked to save changes first.`,
            )
          : verification('verified', `No ${app.imageName} process remains.`);
      } catch (cause) {
        return verification('unverified', `Could not read the process list: ${String(cause)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

const ProcessListInput = z
  .object({
    filter: z.string().optional().describe('Case-insensitive substring of the process name.'),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
type ProcessListInput = z.infer<typeof ProcessListInput>;

export const processListTool: AgentTool<
  ProcessListInput,
  { processes: Array<{ name: string; pid: number; memoryMb: number }>; total: number }
> = {
  name: 'process.list',
  description:
    'List processes currently running on this computer, optionally filtered by name, with their ' +
    'process id and memory use. Use this to check whether a program is running or to answer ' +
    'questions about what is using memory.',
  permission: 'read',
  reversibility: 'reversible',
  inputSchema: ProcessListInput,
  verification: 'intrinsic',
  timeoutMs: 15_000,

  async execute(input) {
    try {
      const all = await listProcesses();
      const needle = input.filter?.toLowerCase();
      const matched = needle ? all.filter((p) => p.imageName.toLowerCase().includes(needle)) : all;

      return ok({
        processes: matched
          .sort((a, b) => b.memoryKb - a.memoryKb)
          .slice(0, input.limit ?? 25)
          .map((p) => ({
            name: p.imageName,
            pid: p.pid,
            memoryMb: Math.round((p.memoryKb / 1024) * 10) / 10,
          })),
        total: matched.length,
      });
    } catch (cause) {
      return err('UNSUPPORTED_PLATFORM', String(cause), { recoverable: false });
    }
  },
};
