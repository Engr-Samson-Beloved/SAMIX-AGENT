import path from 'node:path';
import type { SecurityConfig } from '@samix/shared';

/**
 * Path access policy (spec §39).
 *
 * Consumed by the filesystem tools in Phase 4, but it belongs to the Phase 1
 * security foundation: the rule "deny beats trust" has to be established before
 * any tool can touch a path, not retrofitted afterwards.
 *
 * Three outcomes, and the ordering between them is the whole design:
 *
 *   1. `blocked`  — matches a deny pattern. Checked FIRST and unconditionally.
 *                   A blocked path inside a trusted folder is still blocked;
 *                   dropping an `.env` on the Desktop must not expose it.
 *   2. `trusted`  — inside a configured trusted folder (spec §85). Operates
 *                   with the mode's normal confirmation rules.
 *   3. `untrusted` — everywhere else. Requires confirmation even for reads.
 */

export type PathTrust = 'blocked' | 'trusted' | 'untrusted';

export interface PathDecision {
  readonly trust: PathTrust;
  /** Normalised absolute path the decision was made about. */
  readonly resolved: string;
  /** Human-readable justification, surfaced in confirmation prompts and logs. */
  readonly reason: string;
  /** The deny pattern that matched, when `trust === 'blocked'`. */
  readonly matchedPattern?: string;
}

/**
 * Normalise for comparison. Windows paths are case-insensitive and accept both
 * separators, so comparisons must be too — otherwise `c:\windows\system32` would
 * slip past a `C:\Windows` deny rule.
 */
export function normalisePath(input: string): string {
  // Resolve first: this collapses `..` segments, which is what stops
  // `C:\Users\me\Documents\..\..\..\Windows\System32` from reading as trusted.
  const resolved = path.resolve(input);
  return resolved.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Minimal glob matcher for the deny list. Supports `**` (any depth, including
 * none), `*` (one segment, no separator) and `?`.
 *
 * Hand-written rather than pulling in `minimatch`/`picomatch` (development rule
 * 20). The deny list is a fixed, small, author-controlled vocabulary — we do not
 * need brace expansion, extglobs or negation, and a 20-line matcher we fully
 * understand is preferable to a dependency in a security-critical path.
 *
 * A bare prefix with no wildcard (e.g. `C:\Windows`) matches that directory and
 * everything beneath it.
 */
export function matchesPattern(normalisedPath: string, pattern: string): boolean {
  const p = pattern.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

  if (!/[*?]/.test(p)) {
    // Prefix rule. The boundary check prevents `C:/Windows` from matching
    // `C:/WindowsApps` — a real class of policy bypass.
    return normalisedPath === p || normalisedPath.startsWith(`${p}/`);
  }

  // `**/` must be able to match zero segments so `**/.ssh/**` also catches a
  // top-level `.ssh`. Handled by making the preceding separator optional.
  let regex = '';
  let i = 0;
  while (i < p.length) {
    const char = p[i]!;
    if (char === '*') {
      const isDouble = p[i + 1] === '*';
      if (isDouble) {
        const followedBySlash = p[i + 2] === '/';
        if (followedBySlash) {
          regex += '(?:[^/]*(?:/[^/]*)*/)?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
        continue;
      }
      regex += '[^/]*';
      i += 1;
      continue;
    }
    if (char === '?') {
      regex += '[^/]';
      i += 1;
      continue;
    }
    regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }

  return new RegExp(`^${regex}$`).test(normalisedPath);
}

export class PathPolicy {
  private blocked: readonly string[];
  private trusted: readonly string[];

  constructor(config: Pick<SecurityConfig, 'blockedPathPatterns' | 'trustedFolders'>) {
    this.blocked = config.blockedPathPatterns;
    this.trusted = config.trustedFolders;
  }

  /** Re-read policy after a settings change, without recreating dependents. */
  update(config: Pick<SecurityConfig, 'blockedPathPatterns' | 'trustedFolders'>): void {
    this.blocked = config.blockedPathPatterns;
    this.trusted = config.trustedFolders;
  }

  evaluate(input: string): PathDecision {
    const resolved = normalisePath(input);

    // Deny list first, always. Order is the security property here.
    for (const pattern of this.blocked) {
      if (matchesPattern(resolved, pattern)) {
        return {
          trust: 'blocked',
          resolved,
          reason: `Path is excluded by security policy (${pattern}).`,
          matchedPattern: pattern,
        };
      }
    }

    for (const folder of this.trusted) {
      const normalisedFolder = normalisePath(folder);
      if (resolved === normalisedFolder || resolved.startsWith(`${normalisedFolder}/`)) {
        return {
          trust: 'trusted',
          resolved,
          reason: `Path is inside the trusted folder ${folder}.`,
        };
      }
    }

    return {
      trust: 'untrusted',
      resolved,
      reason: 'Path is outside every configured trusted folder.',
    };
  }

  /** Convenience for tools that only need a boolean gate. */
  isBlocked(input: string): boolean {
    return this.evaluate(input).trust === 'blocked';
  }
}
