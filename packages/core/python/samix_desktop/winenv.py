"""Win32 environment: DPI, COM, and window enumeration.

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
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
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


# --- window enumeration -----------------------------------------------------

_user32 = ctypes.windll.user32
_kernel32 = ctypes.windll.kernel32
_dwmapi = ctypes.windll.dwmapi

_GA_ROOTOWNER = 3
_DWMWA_CLOAKED = 14
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

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
_user32.IsWindowVisible.argtypes = [wt.HWND]
_user32.IsWindow.argtypes = [wt.HWND]
_user32.IsIconic.argtypes = [wt.HWND]

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


def process_name(pid: int) -> str:
    """Image name without `.exe`, e.g. `chrome`. Empty when access is refused.

    Deliberately uses PROCESS_QUERY_LIMITED_INFORMATION, which succeeds against
    elevated and protected processes where the older PROCESS_QUERY_INFORMATION
    does not. A window we cannot name is still a window worth listing.
    """
    handle = _kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        size = wt.DWORD(260)
        buffer = ctypes.create_unicode_buffer(size.value)
        if not _kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return ""
        name = buffer.value.rsplit("\\", 1)[-1]
        return name[:-4] if name.lower().endswith(".exe") else name
    finally:
        _kernel32.CloseHandle(handle)


def is_cloaked(handle: int) -> bool:
    """True for DWM-cloaked windows.

    Windows 11 keeps a crowd of invisible UWP host windows that pass
    `IsWindowVisible` but are not on screen. Without this check the window list
    is mostly ghosts, and "the window behind ours" resolves to one of them.
    """
    value = ctypes.c_int(0)
    hr = _dwmapi.DwmGetWindowAttribute(
        wt.HWND(handle), _DWMWA_CLOAKED, ctypes.byref(value), ctypes.sizeof(value)
    )
    return hr == 0 and value.value != 0


def is_window(handle: int) -> bool:
    return bool(_user32.IsWindow(handle))


def foreground_handle() -> int:
    return int(_user32.GetForegroundWindow() or 0)


def list_windows(exclude_pids: frozenset[int] = frozenset()) -> list[Window]:
    """Ordinary top-level windows, front to back.

    `EnumWindows` yields windows in z-order, which is what makes "the window
    behind ours" a meaningful idea and what lets an ambiguous "focus the Chrome
    window" resolve to the frontmost match.

    Filtered out: invisible windows, cloaked windows, untitled windows, windows
    that are not their own root owner (tool windows and owned dialogs collapse
    onto their owner), and anything belonging to `exclude_pids`.
    """
    active = foreground_handle()
    found: list[Window] = []

    def callback(handle: wt.HWND, _param: wt.LPARAM) -> bool:
        h = int(handle)
        if not _user32.IsWindowVisible(h):
            return True
        if int(_user32.GetAncestor(h, _GA_ROOTOWNER)) != h:
            return True
        if is_cloaked(h):
            return True
        title = window_title(h)
        if not title:
            return True
        pid = window_process_id(h)
        if pid in exclude_pids:
            return True
        found.append(
            Window(
                handle=h,
                title=title,
                process_id=pid,
                process_name=process_name(pid),
                bounds=window_bounds(h),
                is_active=h == active,
                is_minimised=bool(_user32.IsIconic(h)),
            )
        )
        return True

    _user32.EnumWindows(_EnumProc(callback), 0)
    return found


def resolve_window(
    handle: int | None,
    exclude_pids: frozenset[int],
) -> Window | None:
    """The window a snapshot should target.

    With an explicit handle, that window — but still never one belonging to
    `exclude_pids`, so an agent cannot be pointed at its own console by handle
    any more than by asking for "the focused window".

    With no handle, the foreground window; and if the foreground window is one of
    ours, the first window behind it that is not. Never the desktop root: walking
    from the root is unbounded by construction and is the single most expensive
    mistake available in this API.
    """
    windows = list_windows(exclude_pids)
    if handle is not None:
        return next((w for w in windows if w.handle == handle), None)
    active = foreground_handle()
    return next((w for w in windows if w.handle == active), None) or (
        windows[0] if windows else None
    )


def own_window_handles(pids: frozenset[int]) -> frozenset[int]:
    """Top-level window handles belonging to the given processes.

    Used by the refusal in §5 — an action targeting the agent's own console
    window is refused, not confirmed — so it must be computed from the same
    enumeration the rest of this module uses rather than from a title guess.
    """
    handles: set[int] = set()

    def callback(handle: wt.HWND, _param: wt.LPARAM) -> bool:
        h = int(handle)
        if window_process_id(h) in pids:
            handles.add(h)
        return True

    _user32.EnumWindows(_EnumProc(callback), 0)
    return frozenset(handles)
