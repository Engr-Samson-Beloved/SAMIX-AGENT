import { homedir } from 'node:os';
import path from 'node:path';
import { APP_DIR_NAME } from '@samix/shared';

/**
 * Filesystem layout (spec §44).
 *
 * All writable state lives under one root so that "uninstall cleanly" and
 * "back up my agent" are both a single directory operation. The root is
 * resolved once at startup and every other module takes paths from here rather
 * than composing %APPDATA% itself.
 *
 * `SAMIX_DATA_DIR` override exists so tests and the sandbox (spec §69) can
 * redirect all writes away from real user data.
 */

export interface AppPaths {
  /** %APPDATA%\SamixAgent */
  readonly root: string;
  /** config.json — the file spec §44 names. */
  readonly configFile: string;
  /** Diagnostics, NDJSON, rotated. */
  readonly logDir: string;
  readonly logFile: string;
  /** Append-only audit trail, kept apart from diagnostics (spec §37). */
  readonly auditFile: string;
  /** SQLite database (Phase 9). Declared now so nothing invents its own path. */
  readonly databaseFile: string;
  /** Crash-recovery marker for in-flight tasks (spec §67). */
  readonly runtimeStateFile: string;
  /** Scratch space for screenshots and temp artefacts. */
  readonly cacheDir: string;
}

function resolveRoot(): string {
  const override = process.env['SAMIX_DATA_DIR'];
  if (override && override.trim() !== '') return path.resolve(override);

  // APPDATA is the correct location on Windows and is always set there.
  // The homedir fallback keeps the module usable in CI/WSL for unit tests
  // rather than throwing at import time.
  const appData = process.env['APPDATA'];
  if (appData && appData.trim() !== '') return path.join(appData, APP_DIR_NAME);
  return path.join(homedir(), '.config', APP_DIR_NAME);
}

export function createAppPaths(root: string = resolveRoot()): AppPaths {
  const logDir = path.join(root, 'logs');
  return {
    root,
    configFile: path.join(root, 'config.json'),
    logDir,
    logFile: path.join(logDir, 'samix.log'),
    auditFile: path.join(logDir, 'audit.log'),
    databaseFile: path.join(root, 'samix.sqlite'),
    runtimeStateFile: path.join(root, 'runtime-state.json'),
    cacheDir: path.join(root, 'cache'),
  };
}

/**
 * Default trusted folders (spec §85), resolved from the live user profile
 * rather than hard-coded, so they are correct on any machine and for any
 * username. Called once on first run to seed config.
 */
export function defaultTrustedFolders(): string[] {
  const home = homedir();
  return [
    path.join(home, 'Documents'),
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
  ];
}
