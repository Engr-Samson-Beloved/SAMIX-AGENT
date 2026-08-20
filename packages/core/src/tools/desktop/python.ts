import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Finding an interpreter for the desktop sidecar.
 *
 * There is no single right answer on a user's machine, so this returns an
 * ordered list of candidates rather than one path, and the caller tries each
 * until the handshake succeeds. That mirrors how `BrowserSession` picks a Chrome
 * profile, and for the same reason: the interesting information is not "which
 * one" but "which one we ended up on", which has to reach `/status`.
 *
 * Order, most specific first:
 *
 *   1. `automation.desktop.pythonPath` — an explicit answer beats every guess.
 *   2. `SAMIX_DESKTOP_PYTHON` — for CI and for a developer testing an interpreter
 *      without editing their config.
 *   3. The bundled virtual environment. Preferred over anything on PATH because
 *      it is the only one whose dependency versions we pinned.
 *   4. The `py` launcher, then bare `python`. Last because a `python` on PATH is
 *      whatever the user installed most recently, may be a Microsoft Store stub
 *      that opens a web page instead of running, and almost certainly does not
 *      have `uiautomation` in it.
 *
 * Nothing here verifies that a candidate works. Checking would mean spawning,
 * and the spawn is the check.
 */

export type PythonSource = 'config' | 'env' | 'venv' | 'launcher' | 'path';

export interface PythonCandidate {
  readonly command: string;
  readonly args: readonly string[];
  readonly source: PythonSource;
}

/** Absolute path to `packages/core/python`, which holds the sidecar package. */
export function sidecarRoot(): string {
  // `../../../python` from both `dist/tools/desktop/` and `src/tools/desktop/`,
  // so this resolves identically in a build and under --experimental-strip-types.
  return fileURLToPath(new URL('../../../python', import.meta.url));
}

export function venvPython(root = sidecarRoot()): string {
  return path.join(root, '.venv', 'Scripts', 'python.exe');
}

export function pythonCandidates(
  configured = '',
  env: NodeJS.ProcessEnv = process.env,
  root = sidecarRoot(),
): PythonCandidate[] {
  const candidates: PythonCandidate[] = [];
  const add = (command: string, source: PythonSource, args: string[] = []): void => {
    if (command.trim() === '') return;
    if (candidates.some((c) => c.command.toLowerCase() === command.toLowerCase())) return;
    candidates.push({ command, args, source });
  };

  add(configured.trim(), 'config');
  add((env['SAMIX_DESKTOP_PYTHON'] ?? '').trim(), 'env');

  const venv = venvPython(root);
  if (existsSync(venv)) add(venv, 'venv');

  // `-3` pins the launcher to Python 3; without it `py` honours a shebang or a
  // `py.ini` and can hand back a Python 2 that fails on the first f-string.
  add('py', 'launcher', ['-3']);
  add('python', 'path');

  return candidates;
}

/** Arguments that run the sidecar package, appended to whichever interpreter won. */
export function sidecarArgs(): string[] {
  // `-u` unbuffers stdout. Without it Python block-buffers when stdout is a pipe
  // and every response sits in a 8KB buffer until the process exits — the
  // sidecar looks hung and every call times out.
  return ['-u', '-m', 'samix_desktop'];
}
