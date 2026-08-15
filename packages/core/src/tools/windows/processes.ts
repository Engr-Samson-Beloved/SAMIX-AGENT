import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * Process inspection and termination, via two fixed Windows binaries.
 *
 * ## Why this file is allowed to exist
 *
 * Spec §40 and §75 forbid exposing an unrestricted shell or a generic native
 * escape hatch. This file is the narrowest possible exception and is written to
 * stay that way:
 *
 *  - **Two executables only**, named as constants below. There is no parameter
 *    anywhere in this module that selects which program runs.
 *  - **Resolved to absolute paths under `%SystemRoot%\System32`**, never found
 *    via `PATH`. A writable directory earlier on `PATH` is a classic hijack, and
 *    "the agent runs whatever `tasklist` resolves to" is exactly the kind of
 *    indirection this codebase refuses.
 *  - **`shell: false`**, always. Arguments are passed as an array, so quoting,
 *    `&&`, `|` and `%VAR%` have no meaning — a filename containing `& del *` is
 *    just a filename.
 *  - **Image names are validated** against a strict pattern before they reach
 *    `taskkill`, so even the one caller-influenced argument is constrained to
 *    something that cannot be an option flag.
 *
 * The alternative — a native module such as `ffi-napi` or a process-list
 * addon — would add a compiled dependency and a much larger attack surface for
 * capabilities we can get from two documented, signed, in-box tools.
 */

const execFileAsync = promisify(execFile);

const SYSTEM32 = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');
const TASKLIST = path.join(SYSTEM32, 'tasklist.exe');
const TASKKILL = path.join(SYSTEM32, 'taskkill.exe');

/**
 * A Windows image name: `chrome.exe`, `Code.exe`.
 *
 * The leading-character rule matters more than it looks: it rejects anything
 * starting with `/` or `-`, so a crafted name cannot smuggle in an extra
 * `taskkill` switch such as `/F` or `/T`.
 */
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}\.exe$/;

export function isValidImageName(name: string): boolean {
  return IMAGE_NAME.test(name);
}

export interface RunningProcess {
  readonly imageName: string;
  readonly pid: number;
  readonly memoryKb: number;
}

/** Thrown when the platform simply cannot answer — not when nothing matched. */
export class ProcessQueryError extends Error {}

/**
 * List running processes.
 *
 * Uses CSV output (`/fo csv`) rather than the default table, because the table
 * is column-aligned and its widths depend on the console code page — parsing it
 * is how you end up truncating long image names on some machines and not others.
 */
export async function listProcesses(timeoutMs = 10_000): Promise<RunningProcess[]> {
  if (process.platform !== 'win32') {
    throw new ProcessQueryError('Process listing is only implemented for Windows.');
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(TASKLIST, ['/fo', 'csv', '/nh'], {
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (cause) {
    throw new ProcessQueryError(`Could not list processes: ${String(cause)}`);
  }

  const processes: RunningProcess[] = [];
  for (const line of stdout.split('\n')) {
    const fields = parseCsvLine(line);
    if (fields.length < 5) continue;

    const pid = Number.parseInt(fields[1] ?? '', 10);
    if (!Number.isFinite(pid)) continue;

    processes.push({
      imageName: fields[0] ?? '',
      pid,
      // "12,345 K" → 12345. Locale separators vary, so strip non-digits rather
      // than assuming commas.
      memoryKb: Number.parseInt((fields[4] ?? '').replace(/[^\d]/g, ''), 10) || 0,
    });
  }
  return processes;
}

/**
 * Whether any process is running with this image name. Case-insensitive.
 *
 * Asks `tasklist` to do the filtering rather than listing every process and
 * matching here. That matters because this is called in a **polling loop** while
 * verifying a launch: a full listing on a busy machine returns several hundred
 * rows and takes over a second, so three polls cost more than the launch did.
 * Measured on this machine, a filtered query is roughly an order of magnitude
 * cheaper.
 *
 * The filter string embeds `imageName`, so it is validated first — with
 * `shell: false` it is still a single argv element and cannot become a second
 * argument, but a name containing a quote would corrupt the filter expression
 * and silently match nothing, which is a worse failure than an error.
 */
export async function isProcessRunning(imageName: string, timeoutMs = 10_000): Promise<boolean> {
  if (process.platform !== 'win32') {
    throw new ProcessQueryError('Process listing is only implemented for Windows.');
  }
  if (!isValidImageName(imageName)) {
    throw new ProcessQueryError(`Implausible image name: ${imageName}`);
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      TASKLIST,
      ['/FI', `IMAGENAME eq ${imageName}`, '/NH', '/FO', 'CSV'],
      { timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 1024 * 1024 },
    ));
  } catch (cause) {
    throw new ProcessQueryError(`Could not query for ${imageName}: ${String(cause)}`);
  }

  // With no match, tasklist prints an INFO line on stdout rather than producing
  // empty output or a non-zero exit, so the presence of CSV rows is the signal.
  const target = imageName.toLowerCase();
  return stdout
    .split('\n')
    .map((line) => parseCsvLine(line))
    .some((fields) => (fields[0] ?? '').toLowerCase() === target);
}

/**
 * Wait for a process to disappear, or give up.
 *
 * A graceful close is not instantaneous, and the delay varies by an order of
 * magnitude between applications — a Win32 program exits in milliseconds, a
 * packaged Windows 11 app can take several seconds to tear down. A single check
 * after a fixed delay therefore reports "still running" for applications that
 * were closing perfectly well, which reaches the user as a failure. Cheap to
 * poll now that {@link isProcessRunning} filters server-side.
 */
export async function waitForProcessToExit(
  imageName: string,
  timeoutMs = 6_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await isProcessRunning(imageName))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * Ask every process with this image name to close.
 *
 * Deliberately **without** `/F`. The graceful form sends WM_CLOSE, so an
 * application with unsaved work shows its "save changes?" dialog and the user
 * keeps their data. `/F` terminates immediately and silently discards it —
 * spec §13's "never allow unrestricted process termination" is as much about
 * that as about which processes may be targeted.
 *
 * The consequence is honest rather than hidden: a program that refuses to close
 * stays open, verification notices, and the step is reported as unverified
 * instead of claiming a close that did not happen.
 */
export async function closeProcess(
  imageName: string,
  timeoutMs = 15_000,
): Promise<{ requested: number }> {
  if (!isValidImageName(imageName)) {
    throw new ProcessQueryError(`Refusing to act on an implausible image name: ${imageName}`);
  }

  const before = (await listProcesses(timeoutMs)).filter(
    (entry) => entry.imageName.toLowerCase() === imageName.toLowerCase(),
  );
  if (before.length === 0) return { requested: 0 };

  try {
    await execFileAsync(TASKKILL, ['/IM', imageName], {
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
    });
  } catch (cause) {
    // taskkill exits non-zero when it finds nothing to close, which is not an
    // error worth failing the step over — verification decides the outcome.
    const message = String(cause);
    if (!/not found|no running instance/i.test(message)) {
      throw new ProcessQueryError(`Could not close ${imageName}: ${message}`);
    }
  }
  return { requested: before.length };
}

/**
 * Parse one line of `tasklist /fo csv` output.
 *
 * Every field is quoted and fields may contain commas, so splitting on `,` is
 * wrong. This handles the one escaping rule CSV actually uses — a doubled quote
 * inside a quoted field.
 */
function parseCsvLine(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];

  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]!;
    if (char === '"') {
      if (inQuotes && trimmed[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields;
}
