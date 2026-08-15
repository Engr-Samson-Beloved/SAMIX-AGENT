import os from 'node:os';
import path from 'node:path';
import { err, type ToolResult } from '@samix/shared';
import type { PathPolicy } from '../../security/path-policy.js';

/**
 * The single gate every filesystem tool passes a path through (spec §39).
 *
 * ## Why this is a separate module
 *
 * There are nine filesystem tools and each one takes at least one path. If the
 * policy check lived in each tool, the security property would be "nine authors
 * remembered", which is the failure mode ADR-0004 was written about. One
 * function, called at the top of every `execute`, is auditable in a way that
 * nine copies are not.
 *
 * ## The one place this deviates from the spec, stated plainly
 *
 * Spec §39 defines three outcomes — blocked, trusted, untrusted — where
 * untrusted "requires confirmation even for reads". The permission engine
 * decides confirmation from the tool's declared level and the current mode; it
 * has no way to take a *runtime path decision* into account, so a tool cannot
 * currently say "this particular call needs confirming".
 *
 * Rather than pretend, this guard applies the strictest interpretation it can
 * express today:
 *
 *   - `blocked`   → refused, always, for reads and writes alike.
 *   - `untrusted` → refused for anything that **modifies**; allowed for reads.
 *   - `trusted`   → the mode's normal rules apply.
 *
 * Refusing untrusted reads outright would make the agent unable to answer "what
 * is in this folder?" about any path the user names, which is most of them.
 * Allowing untrusted writes would let it modify anything not explicitly denied.
 * The asymmetry is the honest reading of "when in doubt, be careful with
 * changes". Wiring per-call confirmation properly is tracked in TODO.md.
 */

export type PathIntent = 'read' | 'modify';

export interface GuardedPath {
  /** Absolute, real-cased path for filesystem calls. */
  readonly absolute: string;
  readonly trust: 'trusted' | 'untrusted';
}

/**
 * Well-known folders, so the planner never has to guess a path.
 *
 * Rule 4 of the planner's system prompt forbids inventing a file path, but
 * "the Desktop" is a path the user genuinely means and the model would otherwise
 * have to construct `C:\Users\<name>\Desktop` from memory. Naming them here
 * turns a guess into a lookup.
 */
const SHORTHANDS: Readonly<Record<string, () => string>> = {
  home: () => os.homedir(),
  desktop: () => path.join(os.homedir(), 'Desktop'),
  downloads: () => path.join(os.homedir(), 'Downloads'),
  documents: () => path.join(os.homedir(), 'Documents'),
  pictures: () => path.join(os.homedir(), 'Pictures'),
  music: () => path.join(os.homedir(), 'Music'),
  videos: () => path.join(os.homedir(), 'Videos'),
};

export function shorthandNames(): string[] {
  return Object.keys(SHORTHANDS);
}

/**
 * Turn what the planner wrote into an absolute path.
 *
 * Note the ordering: shorthand, then `~`, then environment variables, then
 * resolve. `path.resolve` last is what collapses `..` segments — and it must
 * happen before the policy check, or `C:\Users\me\Desktop\..\..\..\Windows`
 * would be evaluated as though it were inside a trusted folder.
 */
export function toAbsolutePath(input: string): string {
  const trimmed = input.trim();

  const shorthand = SHORTHANDS[trimmed.toLowerCase()];
  if (shorthand) return path.resolve(shorthand());

  let expanded = trimmed;
  if (expanded === '~' || expanded.startsWith('~\\') || expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  expanded = expanded.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match);

  return path.resolve(expanded);
}

/**
 * Check one path against policy.
 *
 * Returns either the usable absolute path or a ready-made failed `ToolResult`,
 * so call sites read as `if ('error' in guarded) return guarded.error;` and
 * cannot accidentally continue past a refusal.
 */
export function guardPath(
  policy: PathPolicy,
  raw: string,
  intent: PathIntent,
): { path: GuardedPath } | { error: ToolResult<never> } {
  const absolute = toAbsolutePath(raw);
  const decision = policy.evaluate(absolute);

  if (decision.trust === 'blocked') {
    return {
      error: err('ACTION_BLOCKED', `${absolute} is protected by security policy. ${decision.reason}`, {
        recoverable: false,
        details: { path: absolute, pattern: decision.matchedPattern },
      }),
    };
  }

  if (decision.trust === 'untrusted' && intent === 'modify') {
    return {
      error: err(
        'PERMISSION_DENIED',
        `${absolute} is outside every trusted folder, so it can be read but not modified. ` +
          `Add the folder in Settings if you want the agent to change files there.`,
        { recoverable: false, details: { path: absolute } },
      ),
    };
  }

  return { path: { absolute, trust: decision.trust } };
}

/** Human-readable size, for summaries the user reads rather than the planner. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
