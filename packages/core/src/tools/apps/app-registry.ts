import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Discovery of launchable applications (spec §14).
 *
 * ## The design constraint that shapes this whole file
 *
 * `app.launch` must not take a path. If it did, "launch this program" would be
 * an arbitrary-executable primitive — precisely the generic native escape hatch
 * spec §40 and §75 forbid, and a planner that can be talked into calling it with
 * `C:\Users\me\Downloads\invoice.pdf.exe` is a malware delivery mechanism.
 *
 * So the tool takes a **name**, and a name is only launchable if it resolves to
 * an entry in this registry. The registry is built by *discovering* what is
 * installed, never by accepting what it is told. Discovery has two sources:
 *
 *  1. A curated table of well-known applications, probed at their documented
 *     install locations. Fast, exact, and it gets the names people actually say
 *     ("chrome", "vs code") rather than the executable names.
 *  2. A shallow scan of the standard install roots, which picks up whatever else
 *     the user has without needing a table entry.
 *
 * Everything discovered is then filtered through {@link NEVER_LAUNCHABLE}.
 */

export type AppKind = 'browser' | 'editor' | 'office' | 'media' | 'communication' | 'utility';

export interface DiscoveredApp {
  /** Stable lowercase identifier, e.g. `chrome`. */
  readonly id: string;
  /** What a person would call it, e.g. `Google Chrome`. */
  readonly displayName: string;
  /** Absolute path to the executable. Never leaves the core. */
  readonly executablePath: string;
  /** `chrome.exe` — what `tasklist` reports, used for verification. */
  readonly imageName: string;
  readonly kind: AppKind;
  /** Other things a user might say for this app. */
  readonly aliases: readonly string[];
}

/**
 * Executables that are never launchable, even when found on disk.
 *
 * Two categories, and both matter:
 *
 *  - **Interpreters and shells.** `cmd`, `powershell`, `wscript`, `mshta`. If
 *    the agent can launch one of these with arguments, the allow-list above is
 *    decorative — the whole point of not having a shell tool is lost. Terminal
 *    access is Phase 10, behind `CommandPolicy` and DEVELOPER mode, where it can
 *    be constrained properly.
 *  - **Living-off-the-land binaries.** `certutil`, `bitsadmin`, `regsvr32`,
 *    `rundll32`, `msiexec` and friends are signed, in-box, and are the standard
 *    way to download and execute payloads while looking legitimate.
 *
 * Matched on the executable's base name, case-insensitively.
 */
export const NEVER_LAUNCHABLE: ReadonlySet<string> = new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'powershell_ise.exe',
  'wt.exe',
  'conhost.exe',
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
  'rundll32.exe',
  'regsvr32.exe',
  'regedit.exe',
  'reg.exe',
  'msiexec.exe',
  'certutil.exe',
  'bitsadmin.exe',
  'wmic.exe',
  'schtasks.exe',
  'at.exe',
  'net.exe',
  'net1.exe',
  'netsh.exe',
  'sc.exe',
  'taskkill.exe',
  'tasklist.exe',
  'installutil.exe',
  'msbuild.exe',
  'python.exe',
  'node.exe',
  'wsl.exe',
  'bash.exe',
  'ssh.exe',
  'ftp.exe',
  'curl.exe',
]);

/** Noise that a directory scan turns up but nobody means by "open X". */
const SCAN_EXCLUDE =
  /unins|install|setup|update|upgrade|crash|report|helper|service|daemon|watchdog|elevate|repair|_?debug|redist|vcredist|diagnos/i;

interface KnownApp {
  readonly id: string;
  readonly displayName: string;
  readonly kind: AppKind;
  readonly aliases: readonly string[];
  /** Candidate locations, `%VAR%` expanded at discovery time. First hit wins. */
  readonly candidates: readonly string[];
}

const KNOWN_APPS: readonly KnownApp[] = [
  {
    id: 'chrome',
    displayName: 'Google Chrome',
    kind: 'browser',
    aliases: ['google chrome', 'chrome browser', 'google'],
    candidates: [
      '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
      '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
      '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
    ],
  },
  {
    id: 'edge',
    displayName: 'Microsoft Edge',
    kind: 'browser',
    aliases: ['microsoft edge', 'msedge'],
    candidates: [
      '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  },
  {
    id: 'firefox',
    displayName: 'Mozilla Firefox',
    kind: 'browser',
    aliases: ['mozilla firefox', 'mozilla'],
    candidates: [
      '%ProgramFiles%\\Mozilla Firefox\\firefox.exe',
      '%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe',
    ],
  },
  {
    id: 'brave',
    displayName: 'Brave',
    kind: 'browser',
    aliases: ['brave browser'],
    candidates: [
      '%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ],
  },
  {
    id: 'vscode',
    displayName: 'Visual Studio Code',
    kind: 'editor',
    aliases: ['vs code', 'code', 'visual studio code', 'vscode'],
    candidates: [
      '%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe',
      '%ProgramFiles%\\Microsoft VS Code\\Code.exe',
    ],
  },
  {
    id: 'notepad',
    displayName: 'Notepad',
    kind: 'editor',
    aliases: ['note pad'],
    candidates: ['%SystemRoot%\\System32\\notepad.exe'],
  },
  {
    id: 'explorer',
    displayName: 'File Explorer',
    kind: 'utility',
    aliases: ['file explorer', 'windows explorer', 'files'],
    candidates: ['%SystemRoot%\\explorer.exe'],
  },
  {
    id: 'calculator',
    displayName: 'Calculator',
    kind: 'utility',
    aliases: ['calc'],
    candidates: ['%SystemRoot%\\System32\\calc.exe'],
  },
  {
    id: 'word',
    displayName: 'Microsoft Word',
    kind: 'office',
    aliases: ['ms word', 'winword'],
    candidates: [
      '%ProgramFiles%\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
      '%ProgramFiles(x86)%\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
    ],
  },
  {
    id: 'excel',
    displayName: 'Microsoft Excel',
    kind: 'office',
    aliases: ['ms excel', 'spreadsheet'],
    candidates: [
      '%ProgramFiles%\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
      '%ProgramFiles(x86)%\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
    ],
  },
  {
    id: 'outlook',
    displayName: 'Microsoft Outlook',
    kind: 'communication',
    aliases: ['ms outlook', 'mail'],
    candidates: [
      '%ProgramFiles%\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE',
      '%ProgramFiles(x86)%\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE',
    ],
  },
  {
    id: 'spotify',
    displayName: 'Spotify',
    kind: 'media',
    aliases: ['music'],
    candidates: ['%APPDATA%\\Spotify\\Spotify.exe'],
  },
  {
    id: 'vlc',
    displayName: 'VLC media player',
    kind: 'media',
    aliases: ['vlc player'],
    candidates: [
      '%ProgramFiles%\\VideoLAN\\VLC\\vlc.exe',
      '%ProgramFiles(x86)%\\VideoLAN\\VLC\\vlc.exe',
    ],
  },
  {
    id: 'slack',
    displayName: 'Slack',
    kind: 'communication',
    aliases: [],
    candidates: ['%LOCALAPPDATA%\\slack\\slack.exe'],
  },
];

/** Roots scanned for anything not in the curated table. Depth-limited. */
const SCAN_ROOTS = ['%LOCALAPPDATA%\\Programs', '%ProgramFiles%', '%ProgramFiles(x86)%'];
const SCAN_DEPTH = 2;

/** Expand `%VAR%` against the environment. Unset variables fail the candidate. */
function expand(template: string): string | undefined {
  let failed = false;
  const expanded = template.replace(/%([^%]+)%/g, (_match, name: string) => {
    const value = process.env[name];
    if (value === undefined || value === '') {
      failed = true;
      return '';
    }
    return value;
  });
  return failed ? undefined : expanded;
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    const stats = await fs.stat(candidate);
    return stats.isFile();
  } catch {
    return false;
  }
}

export function isLaunchable(executablePath: string): boolean {
  return !NEVER_LAUNCHABLE.has(path.basename(executablePath).toLowerCase());
}

/**
 * Discover installed applications.
 *
 * Results are cached for the process lifetime by {@link AppRegistry}: scanning
 * Program Files takes a noticeable moment, and the set of installed programs
 * does not change during a single instruction.
 */
export async function discoverApps(): Promise<DiscoveredApp[]> {
  const found = new Map<string, DiscoveredApp>();

  // --- 1. curated table ------------------------------------------------------
  for (const known of KNOWN_APPS) {
    for (const template of known.candidates) {
      const candidate = expand(template);
      if (candidate === undefined) continue;
      if (!isLaunchable(candidate)) break;
      if (!(await isFile(candidate))) continue;

      found.set(known.id, {
        id: known.id,
        displayName: known.displayName,
        executablePath: candidate,
        imageName: path.basename(candidate),
        kind: known.kind,
        aliases: known.aliases,
      });
      break;
    }
  }

  // --- 2. shallow scan of the install roots ---------------------------------
  for (const template of SCAN_ROOTS) {
    const root = expand(template);
    if (root === undefined) continue;
    await scan(root, SCAN_DEPTH, found);
  }

  // Curated entries first. They are the ones with real names and aliases, and
  // the ones a user is overwhelmingly likely to mean — an alphabetical list that
  // opens with "Antigravity" and buries Chrome is technically complete and
  // practically useless.
  const curatedIds = new Set(KNOWN_APPS.map((app) => app.id));
  return [...found.values()].sort((a, b) => {
    const rank = Number(curatedIds.has(b.id)) - Number(curatedIds.has(a.id));
    return rank !== 0 ? rank : a.displayName.localeCompare(b.displayName);
  });
}

/**
 * Is this `.exe` the program a person would name, or one of its parts?
 *
 * A depth-limited scan of Program Files turns up far more than applications:
 * `ffmpeg.exe`, `git-receive-pack.exe`, `nvidia-smi.exe`, `ExtExport.exe`. All
 * are real executables and none is something a user means by "open X" — and a
 * list dominated by them is worse than no list, because the planner reads it and
 * offers the user nonsense.
 *
 * The heuristic: a program's main binary is almost always named after the folder
 * that contains it — `Cursor\Cursor.exe`, `Notepad++\notepad++.exe`. Helpers and
 * command-line tools sit in `bin\`, `tools\` or beside a differently-named
 * parent, and fail the test.
 *
 * It is a heuristic, and it will miss some real applications. That is the right
 * direction to be wrong in: a missing entry is recoverable — the user says the
 * name and `resolve()` still finds it through the curated table — while a list
 * full of `gpgme-w32spawn` teaches the user the feature does not work.
 */
function looksLikeMainExecutable(directory: string, fileName: string): boolean {
  const simplify = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

  const base = simplify(fileName.replace(/\.exe$/i, ''));
  const parent = simplify(path.basename(directory));
  if (base.length < 3 || parent.length < 3) return false;

  return parent.includes(base) || base.includes(parent);
}

async function scan(directory: string, depth: number, into: Map<string, DiscoveredApp>): Promise<void> {
  if (depth < 0) return;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    // Unreadable directories are normal here (permissions, junctions). A scan
    // that throws on the first one finds nothing at all.
    return;
  }

  for (const entry of entries) {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await scan(full, depth - 1, into);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.exe')) continue;
    if (SCAN_EXCLUDE.test(entry.name) || !isLaunchable(full)) continue;
    if (!looksLikeMainExecutable(directory, entry.name)) continue;

    const id = entry.name.replace(/\.exe$/i, '').toLowerCase();
    // The curated table is authoritative: it has better names and aliases.
    if (into.has(id)) continue;

    into.set(id, {
      id,
      displayName: entry.name.replace(/\.exe$/i, ''),
      executablePath: full,
      imageName: entry.name,
      kind: 'utility',
      aliases: [],
    });
  }
}

/**
 * Resolve what a person said to something on disk, and cache the discovery.
 *
 * Matching is deliberately ordered strictest-first. A user who says "code"
 * means VS Code, and an exact alias hit must beat a substring hit against some
 * unrelated `Codec.exe` the scan happened to find.
 */
export class AppRegistry {
  private cache: DiscoveredApp[] | undefined;

  constructor(private readonly discover: () => Promise<DiscoveredApp[]> = discoverApps) {}

  async list(): Promise<DiscoveredApp[]> {
    this.cache ??= await this.discover();
    return this.cache;
  }

  /** Drop the cache, so a newly installed app is found without a restart. */
  invalidate(): void {
    this.cache = undefined;
  }

  async resolve(query: string): Promise<DiscoveredApp | undefined> {
    const needle = query.trim().toLowerCase().replace(/\.exe$/, '');
    if (needle === '') return undefined;

    const apps = await this.list();

    return (
      apps.find((app) => app.id === needle) ??
      apps.find((app) => app.displayName.toLowerCase() === needle) ??
      apps.find((app) => app.aliases.includes(needle)) ??
      apps.find((app) => app.imageName.toLowerCase() === `${needle}.exe`) ??
      apps.find((app) => app.displayName.toLowerCase().includes(needle)) ??
      apps.find((app) => app.aliases.some((alias) => alias.includes(needle)))
    );
  }

  /** Names to offer back when a resolve fails, so the agent can be specific. */
  async suggestions(limit = 12): Promise<string[]> {
    const apps = await this.list();
    // Curated entries carry aliases; surfacing those first gives a more useful
    // list than the alphabetical head of a Program Files scan. Deduplicated,
    // because the curated set is a subset of `apps` rather than a disjoint one.
    const curated = apps.filter((app) => app.aliases.length > 0 || app.kind !== 'utility');
    const ordered = new Map<string, string>();
    for (const app of [...curated, ...apps]) {
      if (ordered.size >= limit) break;
      ordered.set(app.id, app.displayName);
    }
    return [...ordered.values()];
  }
}
