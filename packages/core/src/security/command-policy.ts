import type { TerminalConfig } from '@samix/shared';

/**
 * Command execution policy for `terminal.execute` (spec §22, §40).
 *
 * Mirrors `PathPolicy`'s shape deliberately: constructed once from config,
 * live-updated on settings changes via `update()`, and the single choke point
 * `terminal.execute` calls before a process is ever spawned.
 *
 * ## Why this is safe without a dangerous-command blacklist
 *
 * Spec §40 lists commands that "must not execute silently" — `Remove-Item
 * -Recurse`, `Format-Volume`, `diskpart`, `reg delete`, `shutdown` — all of
 * which are shell builtins or standalone system-management tools, not
 * development tools with a legitimate "run with these exact arguments" use.
 * `NEVER_ALLOWED` below refuses that whole category outright, so those
 * specific commands are structurally unreachable rather than merely blocked
 * by pattern-matching their text — which a rephrasing could evade.
 *
 * What remains is a small, author-controlled list of specific development
 * tools (`allowedCommands`), each spawned as `command, args[]` with
 * `shell: false`. There is no string for a shell to reinterpret, so argument
 * content — `;`, `&&`, backticks, `$()` — is inert; it is passed to the
 * target program literally, the same way it would be from any other argv
 * array.
 *
 * ## This is deliberately NOT the same set as `app.launch`'s `NEVER_LAUNCHABLE`
 *
 * `app.launch` refuses `node.exe` and `python.exe` too, because it launches
 * an application bare, with no arguments and often no confirmation — opening
 * a raw interpreter that way is pure downside. `terminal.execute` is the
 * opposite context: `permission: 'system'` means the permission engine never
 * auto-approves it in any mode, so every call is confirmed with the exact
 * command and arguments shown before anything runs. `node -e "..."` with
 * visible arguments is not the same risk as launching a bare REPL, so it
 * belongs on `allowedCommands`, not on this floor. What stays on the floor
 * is the category with no legitimate "run with these exact arguments" use at
 * all: shells that would reintroduce string interpretation, and standalone
 * system-management binaries that touch the registry, disks, services or
 * scheduled tasks.
 */

/**
 * Refused regardless of `allowedCommands`, however that list is configured.
 * Widening `allowedCommands` can only ever add development tools; it cannot
 * reopen this floor.
 */
// Bare names, no extension: `evaluate()` strips whatever extension it was
// given before comparing, so this list does not have to enumerate `.exe`
// versus `.com` versus no extension at all for the same program.
const NEVER_ALLOWED: ReadonlySet<string> = new Set([
  // Shells and script hosts — allowing any of these back in would let a
  // "command" become a string a shell reinterprets, the exact thing spawning
  // with an argv array and `shell: false` exists to prevent.
  'cmd',
  'powershell',
  'pwsh',
  'powershell_ise',
  'wt',
  'conhost',
  'bash',
  'sh',
  'wsl',
  'wscript',
  'cscript',
  'mshta',
  // Registry, services, scheduled tasks, disks, drivers, security posture —
  // spec §31 SYSTEM-level territory with no "run with these exact args"
  // development use.
  'reg',
  'regedit',
  'regsvr32',
  'rundll32',
  'sc',
  'net',
  'net1',
  'netsh',
  'schtasks',
  'at',
  'diskpart',
  'format',
  'cipher',
  'shutdown',
  'vssadmin',
  'fsutil',
  'bcdedit',
  'takeown',
  'icacls',
  'cacls',
  // Signed, in-box, and the standard way to fetch and run a payload while
  // looking legitimate (living-off-the-land binaries).
  'certutil',
  'bitsadmin',
  'wmic',
  'msiexec',
  'installutil',
  'taskkill',
]);

/** Strip a trailing executable extension, case-insensitively, for comparison. */
function bareName(command: string): string {
  return command.trim().toLowerCase().replace(/\.(exe|com|bat|cmd)$/, '');
}

export interface CommandDecision {
  readonly allowed: boolean;
  /** Present when `allowed` is false; shown to the user and the planner. */
  readonly reason?: string;
}

export class CommandPolicy {
  private allowed: readonly string[];
  private timeoutMsValue: number;
  private maxOutputBytesValue: number;

  constructor(config: TerminalConfig) {
    this.allowed = config.allowedCommands;
    this.timeoutMsValue = config.timeoutMs;
    this.maxOutputBytesValue = config.maxOutputBytes;
  }

  /** Re-read policy after a settings change, without recreating dependents. */
  update(config: TerminalConfig): void {
    this.allowed = config.allowedCommands;
    this.timeoutMsValue = config.timeoutMs;
    this.maxOutputBytesValue = config.maxOutputBytes;
  }

  get timeoutMs(): number {
    return this.timeoutMsValue;
  }

  get maxOutputBytes(): number {
    return this.maxOutputBytesValue;
  }

  get allowedCommands(): readonly string[] {
    return this.allowed;
  }

  /**
   * Is this bare command name allowed to run at all?
   *
   * Deliberately does not look at `args` — an allow-listed tool's arguments
   * are the confirmation prompt's job to surface, not this policy's job to
   * parse, because "which arguments are dangerous" is different per tool and
   * a wrong guess here would be false confidence.
   */
  evaluate(command: string): CommandDecision {
    const trimmed = command.trim();
    if (trimmed === '') {
      return { allowed: false, reason: 'No command was given.' };
    }
    if (/[\\/]/.test(trimmed)) {
      return {
        allowed: false,
        reason:
          `"${command}" looks like a path, not a command name. Only a bare name from the ` +
          `allowed list may be run — a path would bypass it entirely.`,
      };
    }

    const normalised = bareName(trimmed);
    if (NEVER_ALLOWED.has(normalised)) {
      return {
        allowed: false,
        reason: `"${command}" is a shell or system-management tool and can never be run through this agent.`,
      };
    }

    const permitted = this.allowed.some((entry) => bareName(entry) === normalised);
    if (!permitted) {
      return {
        allowed: false,
        reason:
          this.allowed.length > 0
            ? `"${command}" is not in the allowed command list (${this.allowed.join(', ')}).`
            : `"${command}" cannot run — no commands are configured as allowed.`,
      };
    }

    return { allowed: true };
  }
}
