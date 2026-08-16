import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * Windows window management, via user32 (spec §15, §17).
 *
 * ## Why PowerShell and not a native module
 *
 * Enumerating, focusing and closing windows needs `user32.dll`, and Node has no
 * in-box way to call it. The options were a compiled addon (`ffi-napi`,
 * `node-window-manager`) or P/Invoke through PowerShell's `Add-Type`. This file
 * takes the second, for the same reasons `processes.ts` shells out to
 * `tasklist`: development rule 20 (no unnecessary dependencies), and a compiled
 * addon in a desktop installer is a per-Node-version build liability for
 * capabilities the OS already exposes to a signed, in-box interpreter.
 *
 * The cost is real and is not hidden: `Add-Type` compiles C# on every
 * invocation, so each call here takes roughly a second. That is why the tools
 * built on it are the *fallback* for window work and why `window.list` is not
 * called speculatively.
 *
 * ## Why this is not the shell tool by the back door
 *
 * `app-registry.ts` refuses to launch `powershell.exe` outright, and that rule
 * is not being quietly reversed here. The difference is total:
 *
 *  - The script is a **module-level constant**. No caller can influence a single
 *    character of it.
 *  - Parameters travel in **environment variables**, never on the command line
 *    and never interpolated into script text. An environment variable cannot
 *    become an extra statement, an extra argument, or a redirection.
 *  - Every parameter is a **validated integer** before it is set.
 *  - `-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand`, with
 *    `shell: false` and an absolute path under `%SystemRoot%\System32`.
 *
 * So this is a fixed capability with a fixed vocabulary of four verbs, not an
 * `exec(anything)` that the planner could aim anywhere (spec §22, §40, §75).
 */

const execFileAsync = promisify(execFile);

const SYSTEM32 = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export class WindowQueryError extends Error {}

export type UiaAction = 'list' | 'active' | 'focus' | 'close' | 'exists';

export interface WindowInfo {
  /** Win32 HWND as an integer. Stable while the window lives; reused after. */
  readonly handle: number;
  readonly title: string;
  readonly processId: number;
  /** Executable name without `.exe`, e.g. `chrome`. */
  readonly processName: string;
  readonly isActive: boolean;
  readonly isMinimized: boolean;
  /**
   * True when the window belongs to the agent, to something in its process
   * ancestry, or to its attached console. Spec §13/§15: "close this window"
   * must never mean the agent's own window, and knowing which windows those are
   * is the only way to honour that.
   *
   * ## The one case this cannot catch
   *
   * Windows Terminal hosts consoles over ConPTY, and a shell it hosts is often
   * **not** its descendant — launch the agent from Explorer and the chain runs
   * `node → shell → explorer`, with the Terminal window in a different tree
   * entirely. `GetConsoleWindow` returns the ConPTY window, which is hidden and
   * filtered out before it reaches this list.
   *
   * So during development, in that particular setup, the window the user sees
   * the agent inside is genuinely indistinguishable from any other application
   * window. It affects development only: the shipped application is a Tauri
   * host that spawns this sidecar directly, so the window the user means *is*
   * the parent process and is correctly recognised.
   *
   * It is recorded here rather than worked around, because the available
   * workarounds — matching on window title, or on `WindowsTerminal.exe` — would
   * make the agent refuse to act on windows that really are the user's.
   */
  readonly isOwn: boolean;
}

/**
 * The script. A constant, in full, deliberately readable rather than minified —
 * anything that runs with the user's privileges should be reviewable.
 *
 * **No backticks below this line.** It is a template literal, so a backtick ends
 * the string — and PowerShell uses backtick as its own escape character, which
 * makes it a natural thing to reach for. Use `$(...)` or restructure instead.
 *
 * Design notes:
 *  - Windows are enumerated in z-order (topmost first), which is what makes
 *    "the window behind ours" a meaningful fallback.
 *  - Cloaked windows are filtered out. Windows 11 keeps a crowd of invisible
 *    UWP host windows that pass `IsWindowVisible` but are not on screen; without
 *    the DWM check the list is mostly ghosts.
 *  - `SetForegroundWindow` is preceded by an ALT tap. Windows refuses foreground
 *    changes from a process that does not already own the foreground, and the
 *    synthetic key press is the documented way to satisfy that rule. Without it
 *    focus silently fails on a machine the user is actively using.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class SamixWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();

  public static string TitleOf(IntPtr h) {
    int length = GetWindowTextLength(h);
    if (length <= 0) return "";
    StringBuilder builder = new StringBuilder(length + 1);
    GetWindowText(h, builder, builder.Capacity);
    return builder.ToString();
  }

  public static bool IsCloaked(IntPtr h) {
    int cloaked = 0;
    // DWMWA_CLOAKED = 14. A non-zero HRESULT means the attribute is
    // unsupported, which is not the same as "cloaked" — treat it as visible.
    if (DwmGetWindowAttribute(h, 14, out cloaked, sizeof(int)) != 0) return false;
    return cloaked != 0;
  }
}
'@

# One process query serves both jobs below: naming each window's owner, and
# walking this agent's own ancestry. Asking per-pid was measurably the slowest
# part of a window listing.
$names = @{}
$parents = @{}
$born = @{}
foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate) {
  $processId = [int] $p.ProcessId
  $names[$processId] = ($p.Name -replace '\.exe$', '')
  $parents[$processId] = [int] $p.ParentProcessId
  $born[$processId] = $p.CreationDate
}

function Get-ProcName([int] $processId) {
  if ($names.ContainsKey($processId)) { return $names[$processId] }
  return ''
}

# Where the walk up the process tree stops.
#
# Without a boundary the chain runs all the way to explorer.exe — which owns
# every File Explorer window — and the agent would decide the user's file
# manager belonged to it. These are the session hosts that adopt unrelated
# processes; nothing above them is meaningfully "ours".
$ancestryStops = @{}
foreach ($stop in 'explorer','services','svchost','wininit','winlogon','userinit','csrss','smss','System','Idle') {
  $ancestryStops[$stop] = $true
}

$excluded = @{}
foreach ($raw in ($env:SAMIX_UIA_EXCLUDE_PIDS -split ',')) {
  $trimmed = $raw.Trim()
  if ($trimmed -ne '') { $excluded[[int]$trimmed] = $true }
}

# The console this process is attached to, if it has one.
#
# GetConsoleWindow is the mechanism built for exactly the question being asked
# — "which window is my own console?" — and it catches the classic conhost case.
# It is kept because it is direct and cheap, not because it is sufficient: see
# the note on WindowInfo.isOwn about the modern terminal, where the window
# belongs to an unrelated process tree.
$consoleWindow = [SamixWin]::GetConsoleWindow()
if ($consoleWindow -ne [IntPtr]::Zero) {
  $consolePid = 0
  [void][SamixWin]::GetWindowThreadProcessId($consoleWindow, [ref] $consolePid)
  if ($consolePid -gt 0) { $excluded[[int] $consolePid] = $true }
}

# Walk from the sidecar up to, but not including, the session host.
#
# A parent-only check is not enough and this is not a hypothetical: run the
# agent in Windows Terminal and the chain is node -> pwsh -> OpenConsole ->
# WindowsTerminal, and only the last of those owns a window. Miss it and
# "close this window" closes the agent's own console.
if ($env:SAMIX_UIA_SELF_PID) {
  # $visited is separate from $excluded on purpose: the seed already contains
  # this process's own id, so reusing $excluded for cycle detection would end
  # the walk on its first iteration and quietly exclude nothing.
  $visited = @{}
  $current = [int] $env:SAMIX_UIA_SELF_PID
  $guard = 0
  while ($current -gt 4 -and $guard -lt 32 -and -not $visited.ContainsKey($current)) {
    $visited[$current] = $true
    $excluded[$current] = $true
    $guard++
    if (-not $parents.ContainsKey($current)) { break }
    $parent = $parents[$current]
    if ($parent -le 4 -or -not $names.ContainsKey($parent)) { break }
    if ($ancestryStops.ContainsKey($names[$parent])) { break }
    # Process ids are reused. A "parent" that started after its child is a
    # different process wearing a dead one's id, and following it would mark
    # some unrelated application as the agent's own.
    if ($born.ContainsKey($parent) -and $born.ContainsKey($current) -and
        $born[$parent] -gt $born[$current]) { break }
    $current = $parent
  }
}

$foreground = [SamixWin]::GetForegroundWindow()

function Get-WindowInfo([IntPtr] $handle) {
  $processId = 0
  [void][SamixWin]::GetWindowThreadProcessId($handle, [ref] $processId)
  return [pscustomobject] @{
    handle      = $handle.ToInt64()
    title       = [SamixWin]::TitleOf($handle)
    processId   = [int] $processId
    processName = Get-ProcName ([int] $processId)
    isActive    = ($handle -eq $foreground)
    isMinimized = [SamixWin]::IsIconic($handle)
    isOwn       = $excluded.ContainsKey([int] $processId)
  }
}

# EnumWindows yields top-level windows in z-order, topmost first.
$collected = New-Object System.Collections.ArrayList
$callback = [SamixWin+EnumProc] {
  param([IntPtr] $handle, [IntPtr] $unused)
  if ([SamixWin]::IsWindowVisible($handle) -and
      [SamixWin]::GetWindowTextLength($handle) -gt 0 -and
      -not [SamixWin]::IsCloaked($handle) -and
      # GA_ROOTOWNER = 3: keep only windows that own themselves, which drops
      # tool windows, owned dialogs and the invisible message-only windows that
      # otherwise dominate the list.
      [SamixWin]::GetAncestor($handle, 3) -eq $handle) {
    [void] $collected.Add((Get-WindowInfo $handle))
  }
  return $true
}
[void][SamixWin]::EnumWindows($callback, [IntPtr]::Zero)

$action = $env:SAMIX_UIA_ACTION
$target = [IntPtr]::Zero
if ($env:SAMIX_UIA_HWND) { $target = [IntPtr][int64] $env:SAMIX_UIA_HWND }

$payload = @{ action = $action }

switch ($action) {
  'list' {
    $payload.windows = @($collected.ToArray())
  }
  'active' {
    $payload.windows = @($collected.ToArray())
    if ([SamixWin]::IsWindow($foreground)) { $payload.active = Get-WindowInfo $foreground }
  }
  'exists' {
    $payload.exists = [SamixWin]::IsWindow($target) -and [SamixWin]::IsWindowVisible($target)
  }
  'focus' {
    if (-not [SamixWin]::IsWindow($target)) {
      $payload.focused = $false
      $payload.reason = 'no-such-window'
    } else {
      # SW_RESTORE = 9. A minimised window cannot take the foreground.
      if ([SamixWin]::IsIconic($target)) { [void][SamixWin]::ShowWindow($target, 9) }
      $ok = [SamixWin]::SetForegroundWindow($target)
      if (-not $ok) {
        # VK_MENU = 0x12, KEYEVENTF_KEYUP = 2. Tapping ALT makes this process
        # eligible to change the foreground window; see the note above.
        [SamixWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [SamixWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        $ok = [SamixWin]::SetForegroundWindow($target)
      }
      Start-Sleep -Milliseconds 150
      $now = [SamixWin]::GetForegroundWindow()
      $payload.focused = ($now -eq $target)
      $payload.active = Get-WindowInfo $now
    }
  }
  'close' {
    if (-not [SamixWin]::IsWindow($target)) {
      $payload.requested = $false
      $payload.reason = 'no-such-window'
    } else {
      $payload.window = Get-WindowInfo $target
      # WM_CLOSE = 0x0010. Posted, not forced: the application gets to show its
      # "save changes?" prompt and the user keeps their work.
      $payload.requested = [SamixWin]::PostMessage($target, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    }
  }
  default {
    $payload.error = "unknown action"
  }
}

ConvertTo-Json -InputObject $payload -Depth 5 -Compress
`;

/** UTF-16LE base64, which is what `-EncodedCommand` expects. */
const ENCODED_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64');

/**
 * Seed process ids for the "is this window ours?" test.
 *
 * Only a seed: the script walks up from {@link seedOwnProcessIds}[0] through the
 * real process tree, because the window the agent appears to live in is usually
 * several levels above the sidecar and none of the intermediate processes own a
 * window. See the ancestry walk in `SCRIPT` for where the walk stops and why.
 */
function seedOwnProcessIds(): number[] {
  const ids = [process.pid];
  if (typeof process.ppid === 'number' && process.ppid > 0) ids.push(process.ppid);
  return ids;
}

interface UiaPayload {
  readonly action?: string;
  readonly windows?: unknown;
  readonly active?: unknown;
  readonly window?: unknown;
  readonly exists?: boolean;
  readonly focused?: boolean;
  readonly requested?: boolean;
  readonly reason?: string;
  readonly error?: string;
}

async function runUia(
  action: UiaAction,
  options: { handle?: number; timeoutMs?: number } = {},
): Promise<UiaPayload> {
  if (process.platform !== 'win32') {
    throw new WindowQueryError('Window management is only implemented for Windows.');
  }
  if (options.handle !== undefined && !isValidHandle(options.handle)) {
    throw new WindowQueryError(`Implausible window handle: ${String(options.handle)}`);
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED_SCRIPT],
      {
        timeout: options.timeoutMs ?? 20_000,
        windowsHide: true,
        shell: false,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          SAMIX_UIA_ACTION: action,
          SAMIX_UIA_SELF_PID: String(process.pid),
          SAMIX_UIA_EXCLUDE_PIDS: seedOwnProcessIds().join(','),
          ...(options.handle === undefined ? {} : { SAMIX_UIA_HWND: String(options.handle) }),
        },
      },
    ));
  } catch (cause) {
    throw new WindowQueryError(`Could not read the desktop's windows: ${String(cause)}`);
  }

  const trimmed = stdout.trim();
  if (trimmed === '') throw new WindowQueryError('The window query returned nothing.');

  try {
    return JSON.parse(trimmed) as UiaPayload;
  } catch {
    throw new WindowQueryError('The window query returned output that was not JSON.');
  }
}

/** A window handle is a pointer-sized integer; reject anything that is not one. */
export function isValidHandle(handle: number): boolean {
  return Number.isSafeInteger(handle) && handle > 0;
}

function toWindow(value: unknown): WindowInfo | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const handle = Number(record['handle']);
  if (!isValidHandle(handle)) return undefined;

  return {
    handle,
    title: typeof record['title'] === 'string' ? record['title'] : '',
    processId: Number(record['processId']) || 0,
    processName: typeof record['processName'] === 'string' ? record['processName'] : '',
    isActive: record['isActive'] === true,
    isMinimized: record['isMinimized'] === true,
    isOwn: record['isOwn'] === true,
  };
}

/**
 * PowerShell 5.1's `ConvertTo-Json` collapses a one-element array into a bare
 * object. Normalising here rather than fighting it in the script keeps the
 * script readable and the failure impossible.
 */
function toWindows(value: unknown): WindowInfo[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return items.map(toWindow).filter((window): window is WindowInfo => window !== undefined);
}

/** Every visible, titled, top-level window, topmost first. */
export async function listWindows(timeoutMs?: number): Promise<WindowInfo[]> {
  const payload = await runUia('list', timeoutMs === undefined ? {} : { timeoutMs });
  return toWindows(payload.windows);
}

export interface ActiveWindow {
  /** The window the answer is about. */
  readonly window: WindowInfo;
  /**
   * True when the real foreground window belonged to the agent and this is the
   * next window behind it. The caller must surface this: silently reporting a
   * different window as "active" would be a small, confident lie.
   */
  readonly substituted: boolean;
}

/**
 * The window the user is looking at.
 *
 * When the foreground window is the agent's own — which it very often is, since
 * the user just typed or spoke into it — the honest answer to "what window am I
 * looking at?" is the one behind it. Returning the agent's own console instead
 * is how "close this window" ends up closing the agent (spec §13, §15).
 */
export async function getActiveWindow(timeoutMs?: number): Promise<ActiveWindow | undefined> {
  const payload = await runUia('active', timeoutMs === undefined ? {} : { timeoutMs });
  const active = toWindow(payload.active);
  const windows = toWindows(payload.windows);

  if (active && !active.isOwn) return { window: active, substituted: false };

  // z-order order, so the first non-agent window is the one immediately behind.
  const behind = windows.find((window) => !window.isOwn);
  if (!behind) return undefined;
  return { window: behind, substituted: true };
}

export async function focusWindow(
  handle: number,
  timeoutMs?: number,
): Promise<{ focused: boolean; active: WindowInfo | undefined; reason?: string }> {
  const payload = await runUia('focus', { handle, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  return {
    focused: payload.focused === true,
    active: toWindow(payload.active),
    ...(payload.reason ? { reason: payload.reason } : {}),
  };
}

export async function closeWindow(
  handle: number,
  timeoutMs?: number,
): Promise<{ requested: boolean; window: WindowInfo | undefined; reason?: string }> {
  const payload = await runUia('close', { handle, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  return {
    requested: payload.requested === true,
    window: toWindow(payload.window),
    ...(payload.reason ? { reason: payload.reason } : {}),
  };
}

export async function windowExists(handle: number, timeoutMs?: number): Promise<boolean> {
  const payload = await runUia('exists', { handle, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  return payload.exists === true;
}

/**
 * Wait for a window to disappear, or give up.
 *
 * Same reasoning as `waitForProcessToExit`: a graceful close is not
 * instantaneous, and a single check after a fixed delay reports "still open" for
 * windows that were closing perfectly well.
 */
export async function waitForWindowToClose(handle: number, timeoutMs = 6_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await windowExists(handle))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
