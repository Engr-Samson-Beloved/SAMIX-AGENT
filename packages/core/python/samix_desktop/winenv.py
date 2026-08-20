"""Win32 environment: DPI, COM, and window management.

Everything in here is `ctypes` against in-box DLLs. It deliberately does NOT use
`uiautomation`, because two of its jobs — declaring DPI awareness and enumerating
top-level windows — must happen *before* UI Automation is touched at all.

## Why DPI awareness is the first thing this process does

Every coordinate that crosses the sidecar boundary is a **physical pixel**. That
is only true if the process declared per-monitor-v2 awareness before anything
cached a coordinate space. If it has not, Windows silently virtualises
coordinates for the primary monitor's scale factor, and the numbers we hand back
are wrong on any secondary monitor with a different scale — wrong in a way that
looks plausible, which is the worst kind. A click lands somewhere near the
target, on the wrong control.

`uiautomation` calls `SetProcessDpiAwareness` itself on import, at a weaker level
(system-aware, not per-monitor-v2). Awareness cannot be lowered but the *first*
successful call wins for the stronger context, so `set_dpi_awareness()` must run
before that import. `__main__.py` enforces the ordering.

## The window half is a port, not a redesign

`window.list`, `window.focus`, `window.close` and `screen.getActiveWindow` have
shipped behaviour, and the whole point of this module is to make them fast
without changing what they do. So the enumeration filters, the ancestry walk and
its stop list, the ALT-tap before `SetForegroundWindow`, the 150ms settle, and
posting `WM_CLOSE` rather than forcing it are all reproduced deliberately from
`tools/windows/ui-automation.ts`. Where this file and that script disagree, this
file is wrong.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import os
import time
from typing import NamedTuple

# --- DPI --------------------------------------------------------------------

# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2. A sentinel pointer value, not a
# real address, which is why it is passed as c_void_p(-4) rather than an int.
_PER_MONITOR_AWARE_V2 = ctypes.c_void_p(-4)
_PROCESS_PER_MONITOR_DPI_AWARE = 2


def set_dpi_awareness() -> str:
    """Declare per-monitor-v2 DPI awareness. Returns the level actually reached.

    Three tiers, best first. Windows 10 1809 (the oldest version this phase
    supports) has the first, so the fallbacks are for defence rather than for a
    platform we claim to support.
    """
    try:
        fn = ctypes.windll.user32.SetProcessDpiAwarenessContext
        fn.argtypes = [ctypes.c_void_p]
        fn.restype = wt.BOOL
        if fn(_PER_MONITOR_AWARE_V2):
            return "per-monitor-v2"
    except (AttributeError, OSError):
        pass

    try:
        # shcore, Windows 8.1+. Per-monitor v1: correct at process start, but
        # does not follow a window dragged between monitors of different scale.
        if ctypes.windll.shcore.SetProcessDpiAwareness(_PROCESS_PER_MONITOR_DPI_AWARE) == 0:
            return "per-monitor-v1"
    except (AttributeError, OSError):
        pass

    try:
        if ctypes.windll.user32.SetProcessDPIAware():
            return "system"
    except (AttributeError, OSError):
        pass

    return "unaware"


# --- COM --------------------------------------------------------------------

_COINIT_APARTMENTTHREADED = 0x2
_S_OK = 0
_S_FALSE = 1
_RPC_E_CHANGED_MODE = -2147417850  # 0x80010106


class ComInitError(RuntimeError):
    pass


def init_com() -> str:
    """Enter a single-threaded apartment on the calling thread.

    UI Automation is apartment-bound, which is the reason the whole sidecar
    serialises work onto one thread rather than using a pool. Returns a short
    description of what happened, for the handshake.
    """
    hr = ctypes.windll.ole32.CoInitializeEx(None, _COINIT_APARTMENTTHREADED)
    if hr == _S_OK:
        return "sta"
    if hr == _S_FALSE:
        return "sta (already initialised)"
    if hr == _RPC_E_CHANGED_MODE:
        # Something already put this thread in a multi-threaded apartment. UIA
        # would still "work" but every call marshals, and the failure modes are
        # timing-dependent. Refuse rather than be intermittently wrong.
        raise ComInitError("thread is already in a multi-threaded apartment")
    raise ComInitError(f"CoInitializeEx failed with 0x{hr & 0xFFFFFFFF:08X}")


# --- bindings ---------------------------------------------------------------

_user32 = ctypes.windll.user32
_kernel32 = ctypes.windll.kernel32
_dwmapi = ctypes.windll.dwmapi

_GA_ROOTOWNER = 3
_DWMWA_CLOAKED = 14
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_TH32CS_SNAPPROCESS = 0x2
_SW_RESTORE = 9
_WM_CLOSE = 0x0010
_VK_MENU = 0x12
_KEYEVENTF_KEYUP = 0x2

_EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

_user32.EnumWindows.argtypes = [_EnumProc, wt.LPARAM]
_user32.EnumWindows.restype = wt.BOOL
_user32.GetWindowTextLengthW.argtypes = [wt.HWND]
_user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
_user32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
_user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
_user32.GetAncestor.argtypes = [wt.HWND, wt.UINT]
_user32.GetAncestor.restype = wt.HWND
_user32.GetForegroundWindow.restype = wt.HWND
_user32.SetForegroundWindow.argtypes = [wt.HWND]
_user32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
_user32.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
_user32.IsWindowVisible.argtypes = [wt.HWND]
_user32.IsWindow.argtypes = [wt.HWND]
_user32.IsIconic.argtypes = [wt.HWND]
_user32.keybd_event.argtypes = [wt.BYTE, wt.BYTE, wt.DWORD, ctypes.POINTER(wt.ULONG)]

# Handles are pointers. ctypes defaults a foreign function's return type to
# `c_int`, which truncates a 64-bit HANDLE to 32 bits and yields a value that
# fails or, worse, refers to something else entirely.
_kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
_kernel32.OpenProcess.restype = wt.HANDLE
_kernel32.CloseHandle.argtypes = [wt.HANDLE]
_kernel32.QueryFullProcessImageNameW.argtypes = [
    wt.HANDLE,
    wt.DWORD,
    wt.LPWSTR,
    ctypes.POINTER(wt.DWORD),
]
_kernel32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
_kernel32.CreateToolhelp32Snapshot.restype = wt.HANDLE
_kernel32.GetConsoleWindow.restype = wt.HWND
_kernel32.GetProcessTimes.argtypes = [
    wt.HANDLE,
    ctypes.POINTER(wt.FILETIME),
    ctypes.POINTER(wt.FILETIME),
    ctypes.POINTER(wt.FILETIME),
    ctypes.POINTER(wt.FILETIME),
]


class _PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD),
        ("cntUsage", wt.DWORD),
        ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD),
        ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wt.DWORD),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


_kernel32.Process32FirstW.argtypes = [wt.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
_kernel32.Process32NextW.argtypes = [wt.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]


# --- values -----------------------------------------------------------------


class Bounds(NamedTuple):
    """Physical pixels, screen coordinates. See the DPI note at the top."""

    x: int
    y: int
    width: int
    height: int

    def as_list(self) -> list[int]:
        return [self.x, self.y, self.width, self.height]

    @property
    def area(self) -> int:
        return max(0, self.width) * max(0, self.height)


class Window(NamedTuple):
    handle: int
    title: str
    process_id: int
    process_name: str
    bounds: Bounds
    is_active: bool
    is_minimised: bool
    #: True when the window belongs to the agent, to something in its process
    #: ancestry, or to its attached console. "Close this window" must never mean
    #: the agent's own window, and this flag is the only thing that honours it.
    is_own: bool

    def as_json(self) -> dict:
        return {
            "handle": self.handle,
            "title": self.title,
            "processId": self.process_id,
            "processName": self.process_name,
            "bounds": self.bounds.as_list(),
            "isActive": self.is_active,
            "isMinimized": self.is_minimised,
            "isOwn": self.is_own,
        }


# --- process facts ----------------------------------------------------------


def _process_table() -> tuple[dict[int, int], dict[int, str]]:
    """`{pid: parent_pid}` and `{pid: name}` for every process, in one snapshot."""
    parents: dict[int, int] = {}
    names: dict[int, str] = {}
    snapshot = _kernel32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
    if not snapshot or snapshot == wt.HANDLE(-1).value:
        return parents, names
    try:
        entry = _PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
        if not _kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            return parents, names
        while True:
            pid = int(entry.th32ProcessID)
            parents[pid] = int(entry.th32ParentProcessID)
            name = entry.szExeFile
            names[pid] = name[:-4] if name.lower().endswith(".exe") else name
            if not _kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                break
    finally:
        _kernel32.CloseHandle(snapshot)
    return parents, names


def _create_time(pid: int) -> int:
    """Process creation time in FILETIME ticks, or 0 when it cannot be read."""
    handle = _kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return 0
    try:
        created, exited, kernel, user = (wt.FILETIME() for _ in range(4))
        if not _kernel32.GetProcessTimes(
            handle,
            ctypes.byref(created),
            ctypes.byref(exited),
            ctypes.byref(kernel),
            ctypes.byref(user),
        ):
            return 0
        return (created.dwHighDateTime << 32) | created.dwLowDateTime
    finally:
        _kernel32.CloseHandle(handle)


_name_cache: dict[int, str] = {}


def process_name(pid: int) -> str:
    """Image name without `.exe`, e.g. `chrome`. Empty when access is refused.

    Deliberately uses PROCESS_QUERY_LIMITED_INFORMATION, which succeeds against
    elevated and protected processes where the older PROCESS_QUERY_INFORMATION
    does not. A window we cannot name is still a window worth listing.

    Memoised for the life of the process. Process ids are reused, so this can in
    principle go stale — but a stale *name* only affects how a window is
    described, never which window is acted on, and the alternative is an
    OpenProcess round trip per window on every list.
    """
    cached = _name_cache.get(pid)
    if cached is not None:
        return cached

    name = ""
    handle = _kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if handle:
        try:
            size = wt.DWORD(260)
            buffer = ctypes.create_unicode_buffer(size.value)
            if _kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                leaf = buffer.value.rsplit("\\", 1)[-1]
                name = leaf[:-4] if leaf.lower().endswith(".exe") else leaf
        finally:
            _kernel32.CloseHandle(handle)
    _name_cache[pid] = name
    return name


# Where the walk up the process tree stops.
#
# Without a boundary the chain runs all the way to explorer.exe — which owns
# every File Explorer window — and the agent would decide the user's file manager
# belonged to it. These are the session hosts that adopt unrelated processes;
# nothing above them is meaningfully "ours".
_ANCESTRY_STOPS = frozenset(
    {
        "explorer",
        "services",
        "svchost",
        "wininit",
        "winlogon",
        "userinit",
        "csrss",
        "smss",
        "system",
        "idle",
    }
)

_own_pids_cache: frozenset[int] | None = None


def own_process_ids(seed: list[int]) -> frozenset[int]:
    """Every process id whose windows count as the agent's own.

    Resolved once per session and cached: a running process does not acquire a
    new ancestry, and the snapshot is the expensive part.

    A parent-only check is not enough, and that is not hypothetical. Run the
    agent in Windows Terminal and the chain is
    `python -> node -> pwsh -> OpenConsole -> WindowsTerminal`, and only the last
    of those owns a window. Miss it and "close this window" closes the agent's
    own console.
    """
    global _own_pids_cache
    if _own_pids_cache is not None:
        return _own_pids_cache

    own: set[int] = {pid for pid in seed if pid > 4}
    own.add(os.getpid())

    # GetConsoleWindow answers exactly the question being asked — "which window
    # is my own console?" — and catches the classic conhost case. Kept because it
    # is direct and cheap, not because it is sufficient.
    console = _kernel32.GetConsoleWindow()
    if console:
        own.add(window_process_id(int(console)))

    parents, names = _process_table()

    # `visited` is separate from `own` on purpose: the seed already contains the
    # starting id, so reusing `own` for cycle detection would end the walk on its
    # first iteration and quietly exclude nothing.
    visited: set[int] = set()
    current = seed[0] if seed else os.getpid()
    guard = 0
    while current > 4 and guard < 32 and current not in visited:
        visited.add(current)
        own.add(current)
        guard += 1
        parent = parents.get(current)
        if parent is None or parent <= 4:
            break
        name = names.get(parent)
        if name is None or name.lower() in _ANCESTRY_STOPS:
            break
        # Process ids are reused. A "parent" that started after its child is a
        # different process wearing a dead one's id, and following it would mark
        # some unrelated application as the agent's own.
        parent_born, child_born = _create_time(parent), _create_time(current)
        if parent_born and child_born and parent_born > child_born:
            break
        current = parent

    _own_pids_cache = frozenset(pid for pid in own if pid > 0)
    return _own_pids_cache


# --- window facts -----------------------------------------------------------


def window_title(handle: int) -> str:
    length = _user32.GetWindowTextLengthW(handle)
    if length <= 0:
        return ""
    buffer = ctypes.create_unicode_buffer(length + 1)
    _user32.GetWindowTextW(handle, buffer, length + 1)
    return buffer.value


def window_bounds(handle: int) -> Bounds:
    rect = wt.RECT()
    if not _user32.GetWindowRect(handle, ctypes.byref(rect)):
        return Bounds(0, 0, 0, 0)
    return Bounds(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)


def window_process_id(handle: int) -> int:
    pid = wt.DWORD()
    _user32.GetWindowThreadProcessId(handle, ctypes.byref(pid))
    return int(pid.value)


def is_cloaked(handle: int) -> bool:
    """True for DWM-cloaked windows.

    Windows 11 keeps a crowd of invisible UWP host windows that pass
    `IsWindowVisible` but are not on screen. Without this check the window list
    is mostly ghosts, and "the window behind ours" resolves to one of them.

    A failing HRESULT means the attribute is unsupported, which is not the same
    as "cloaked" — treat it as visible.
    """
    value = ctypes.c_int(0)
    hr = _dwmapi.DwmGetWindowAttribute(
        wt.HWND(handle), _DWMWA_CLOAKED, ctypes.byref(value), ctypes.sizeof(value)
    )
    return hr == 0 and value.value != 0


def is_window(handle: int) -> bool:
    return bool(_user32.IsWindow(wt.HWND(handle)))


def window_exists(handle: int) -> bool:
    h = wt.HWND(handle)
    return bool(_user32.IsWindow(h)) and bool(_user32.IsWindowVisible(h))


def foreground_handle() -> int:
    return int(_user32.GetForegroundWindow() or 0)


def describe_window(handle: int, own: frozenset[int], foreground: int) -> Window:
    pid = window_process_id(handle)
    return Window(
        handle=handle,
        title=window_title(handle),
        process_id=pid,
        process_name=process_name(pid),
        bounds=window_bounds(handle),
        is_active=handle == foreground,
        is_minimised=bool(_user32.IsIconic(wt.HWND(handle))),
        is_own=pid in own,
    )


def list_windows(own: frozenset[int] = frozenset()) -> list[Window]:
    """Ordinary top-level windows, front to back.

    `EnumWindows` yields windows in z-order, which is what makes "the window
    behind ours" a meaningful idea and what lets an ambiguous "focus the Chrome
    window" resolve to the frontmost match.

    Filtered out: invisible windows, untitled windows, cloaked windows, and
    windows that are not their own root owner — GA_ROOTOWNER drops tool windows,
    owned dialogs and the message-only windows that otherwise dominate the list.

    The agent's own windows are *marked*, not removed. Callers decide: the window
    tools skip them, while `screen.getActiveWindow` needs to see one in order to
    report that it substituted the window behind it.
    """
    foreground = foreground_handle()
    found: list[Window] = []

    def callback(handle: wt.HWND, _param: wt.LPARAM) -> bool:
        h = int(handle)
        if not _user32.IsWindowVisible(handle):
            return True
        if _user32.GetWindowTextLengthW(handle) <= 0:
            return True
        if int(_user32.GetAncestor(handle, _GA_ROOTOWNER)) != h:
            return True
        if is_cloaked(h):
            return True
        found.append(describe_window(h, own, foreground))
        return True

    _user32.EnumWindows(_EnumProc(callback), 0)
    return found


def resolve_window(handle: int | None, own: frozenset[int]) -> Window | None:
    """The window a snapshot should target.

    With an explicit handle, that window — but never one of the agent's own, so
    it cannot be pointed at its own console by handle any more than by asking for
    "the focused window".

    With no handle, the foreground window; and if that is one of ours, the first
    window behind it that is not. Never the desktop root: walking from the root is
    unbounded by construction and is the single most expensive mistake available
    in this API.
    """
    windows = [w for w in list_windows(own) if not w.is_own]
    if handle is not None:
        return next((w for w in windows if w.handle == handle), None)
    active = foreground_handle()
    return next((w for w in windows if w.handle == active), None) or (
        windows[0] if windows else None
    )


# --- window actions ---------------------------------------------------------


def focus_window(handle: int, own: frozenset[int]) -> dict:
    """Bring a window to the front, restoring it first if it is minimised."""
    target = wt.HWND(handle)
    if not _user32.IsWindow(target):
        return {"focused": False, "active": None, "reason": "no-such-window"}

    if _user32.IsIconic(target):
        _user32.ShowWindow(target, _SW_RESTORE)

    ok = _user32.SetForegroundWindow(target)
    if not ok:
        # Windows refuses a foreground change from a process that does not
        # already own the foreground. Tapping ALT is the documented way to become
        # eligible; without it, focus silently fails on a machine someone is
        # actively using.
        _user32.keybd_event(_VK_MENU, 0, 0, None)
        _user32.keybd_event(_VK_MENU, 0, _KEYEVENTF_KEYUP, None)
        ok = _user32.SetForegroundWindow(target)

    # The foreground change is asynchronous; reading it back immediately reports
    # the previous window and makes a successful focus look like a failure.
    time.sleep(0.15)
    now = foreground_handle()
    return {
        "focused": now == handle,
        "active": describe_window(now, own, now).as_json() if is_window(now) else None,
    }


def close_window(handle: int, own: frozenset[int]) -> dict:
    """Ask a window to close. Posted, never forced.

    `WM_CLOSE` lets the application show its "save changes?" prompt and keep the
    user's work. A window that stays open is a truthful result, not a failure of
    this function.
    """
    target = wt.HWND(handle)
    if not _user32.IsWindow(target):
        return {"requested": False, "window": None, "reason": "no-such-window"}
    foreground = foreground_handle()
    window = describe_window(handle, own, foreground).as_json()
    requested = bool(_user32.PostMessageW(target, _WM_CLOSE, 0, 0))
    return {"requested": requested, "window": window}
