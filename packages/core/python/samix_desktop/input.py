"""Synthetic mouse and keyboard input (Phase 7 step 4).

Everything here goes through `SendInput`, the same entry point a real mouse or
keyboard driver uses. That is the point: `desktop.invoke` and `desktop.setValue`
drive an application through UI Automation patterns, which is exact but only
works when the control exposes one. A custom-drawn button, a game, a control
that only reacts to a real click has no pattern to call — this module is the
fallback of last resort for exactly that case, which is why `tools.py`'s
element actions are always preferred and these tools are documented as such.

## Absolute coordinates, always

`SendInput` accepts either relative deltas or absolute coordinates normalised to
0..65535 across the *virtual* screen (every monitor, not just the primary). This
module only ever sends absolute: a relative move composes with whatever the real
mouse does at the same moment, and a synthetic input tool that can be nudged off
target by the user's own hand is not a tool anyone can trust.

## Interpolation is not cosmetic

A single `SetCursorPos` teleports the cursor with no `WM_MOUSEMOVE` in between.
Hover state, tooltips and drag-and-drop targets are computed from *those*
intermediate messages, not from the final position, so a teleported click can
land somewhere that never registered as hovered. `move_interpolated` walks the
path in small steps so every one of them is a real message.

## Releasing what we pressed

A cancel that arrives mid-chord — after the Ctrl key went down but before it came
back up — must not leave the user's keyboard with a stuck modifier. `InputState`
tracks exactly which keys and buttons this process has pressed and not yet
released, so `release_all()` can undo precisely that and nothing else: it must
never release a key the *user* is physically holding, which this process has no
way to know about and therefore never touches.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import time
from typing import Callable

# --- SendInput structures ----------------------------------------------------

PUL = ctypes.POINTER(ctypes.c_ulong)


class _MouseInput(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", PUL),
    ]


class _KeyboardInput(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.c_ushort),
        ("wScan", ctypes.c_ushort),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", PUL),
    ]


class _HardwareInput(ctypes.Structure):
    _fields_ = [
        ("uMsg", ctypes.c_ulong),
        ("wParamL", ctypes.c_short),
        ("wParamH", ctypes.c_ushort),
    ]


class _InputUnion(ctypes.Union):
    _fields_ = [("mi", _MouseInput), ("ki", _KeyboardInput), ("hi", _HardwareInput)]


class _Input(ctypes.Structure):
    _fields_ = [("type", ctypes.c_ulong), ("union", _InputUnion)]


_INPUT_MOUSE = 0
_INPUT_KEYBOARD = 1

_MOUSEEVENTF_MOVE = 0x0001
_MOUSEEVENTF_ABSOLUTE = 0x8000
_MOUSEEVENTF_VIRTUALDESK = 0x4000
_MOUSEEVENTF_LEFTDOWN = 0x0002
_MOUSEEVENTF_LEFTUP = 0x0004
_MOUSEEVENTF_RIGHTDOWN = 0x0008
_MOUSEEVENTF_RIGHTUP = 0x0010
_MOUSEEVENTF_MIDDLEDOWN = 0x0020
_MOUSEEVENTF_MIDDLEUP = 0x0040

_KEYEVENTF_EXTENDEDKEY = 0x0001
_KEYEVENTF_KEYUP = 0x0002
_KEYEVENTF_UNICODE = 0x0004

_BUTTON_DOWN = {
    "left": _MOUSEEVENTF_LEFTDOWN,
    "right": _MOUSEEVENTF_RIGHTDOWN,
    "middle": _MOUSEEVENTF_MIDDLEDOWN,
}
_BUTTON_UP = {
    "left": _MOUSEEVENTF_LEFTUP,
    "right": _MOUSEEVENTF_RIGHTUP,
    "middle": _MOUSEEVENTF_MIDDLEUP,
}

#: Named keys a person would ask for by name rather than by character.
NAMED_KEYS: dict[str, int] = {
    "enter": 0x0D, "return": 0x0D,
    "tab": 0x09,
    "escape": 0x1B, "esc": 0x1B,
    "space": 0x20, "spacebar": 0x20,
    "backspace": 0x08,
    "delete": 0x2E, "del": 0x2E,
    "insert": 0x2D,
    "home": 0x24, "end": 0x23,
    "pageup": 0x21, "pagedown": 0x22,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
    "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}

#: Modifier aliases, so "Control", "ctrl" and "cmd" all resolve.
MODIFIER_ALIASES: dict[str, int] = {
    "ctrl": 0x11, "control": 0x11,
    "shift": 0x10,
    "alt": 0x12, "menu": 0x12,
    "win": 0x5B, "windows": 0x5B, "cmd": 0x5B, "meta": 0x5B,
}

#: Keys that must carry KEYEVENTF_EXTENDEDKEY or Windows reads them as the
#: numpad equivalent regardless of what was actually pressed.
_EXTENDED_KEYS = {0x2D, 0x2E, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x5B}

#: Steps per second while interpolating a move. Smooth without being slow.
_INTERPOLATION_HZ = 60
#: Delay between synthetic keystrokes of typed text. Fast, but a real interval —
#: some applications drop or coalesce characters sent with zero delay at all.
CHAR_DELAY_SECONDS = 0.012
#: Delay after a button or key event, before the next one, and after a press
#: completes — long enough for the target's message loop to have processed it.
SETTLE_SECONDS = 0.03


class InvalidKey(Exception):
    """A key name this module does not recognise."""


def _send(inputs: list[_Input]) -> None:
    n = len(inputs)
    array = (_Input * n)(*inputs)
    sent = ctypes.windll.user32.SendInput(n, array, ctypes.sizeof(_Input))
    if sent != n:
        raise OSError(f"SendInput accepted {sent} of {n} events (error {ctypes.get_last_error()}).")


def _mouse_input(flags: int, dx: int = 0, dy: int = 0) -> _Input:
    return _Input(_INPUT_MOUSE, _InputUnion(mi=_MouseInput(dx, dy, 0, flags, 0, None)))


def _key_input(vk: int, flags: int) -> _Input:
    extended = _KEYEVENTF_EXTENDEDKEY if vk in _EXTENDED_KEYS else 0
    return _Input(_INPUT_KEYBOARD, _InputUnion(ki=_KeyboardInput(vk, 0, flags | extended, 0, None)))


def _unicode_input(char: str, key_up: bool) -> _Input:
    flags = _KEYEVENTF_UNICODE | (_KEYEVENTF_KEYUP if key_up else 0)
    return _Input(_INPUT_KEYBOARD, _InputUnion(ki=_KeyboardInput(0, ord(char), flags, 0, None)))


# --- coordinates --------------------------------------------------------------

_SM_XVIRTUALSCREEN, _SM_YVIRTUALSCREEN = 76, 77
_SM_CXVIRTUALSCREEN, _SM_CYVIRTUALSCREEN = 78, 79


def _to_absolute(x: int, y: int) -> tuple[int, int]:
    """Physical pixels, anywhere on the virtual desktop, to SendInput's 0..65535."""
    metrics = ctypes.windll.user32.GetSystemMetrics
    origin_x, origin_y = metrics(_SM_XVIRTUALSCREEN), metrics(_SM_YVIRTUALSCREEN)
    width, height = metrics(_SM_CXVIRTUALSCREEN), metrics(_SM_CYVIRTUALSCREEN)
    if width <= 0 or height <= 0:
        raise OSError("Could not read the virtual screen's size.")
    ax = round(((x - origin_x) * 65536) / width)
    ay = round(((y - origin_y) * 65536) / height)
    return max(0, min(65535, ax)), max(0, min(65535, ay))


def cursor_position() -> tuple[int, int]:
    point = wt.POINT()
    if not ctypes.windll.user32.GetCursorPos(ctypes.byref(point)):
        raise OSError("GetCursorPos failed.")
    return point.x, point.y


# --- state: what this process currently holds down ---------------------------


class InputState:
    """Tracks synthetic keys and buttons currently down, for `release_all()`.

    Every entry here was pressed by this process and not yet released by it.
    Nothing is ever added on the strength of a guess about the real keyboard —
    only `key_down`/`mouse_down` below add an entry, and only the matching `_up`
    call or `release_all` removes it.
    """

    def __init__(self) -> None:
        self._keys_down: set[int] = set()
        self._buttons_down: set[str] = set()

    def key_down(self, vk: int) -> None:
        _send([_key_input(vk, 0)])
        self._keys_down.add(vk)

    def key_up(self, vk: int) -> None:
        _send([_key_input(vk, _KEYEVENTF_KEYUP)])
        self._keys_down.discard(vk)

    def mouse_down(self, button: str) -> None:
        _send([_mouse_input(_BUTTON_DOWN[button])])
        self._buttons_down.add(button)

    def mouse_up(self, button: str) -> None:
        _send([_mouse_input(_BUTTON_UP[button])])
        self._buttons_down.discard(button)

    def release_all(self) -> dict[str, list]:
        """Undo exactly what this process left pressed. Idempotent and cheap.

        Called unconditionally on every stop and shutdown (spec: emergency stop
        must release synthetic input), so it must never raise merely because
        there was nothing to release.
        """
        released = {"keys": sorted(self._keys_down), "buttons": sorted(self._buttons_down)}
        for vk in list(self._keys_down):
            try:
                self.key_up(vk)
            except OSError:
                pass
        for button in list(self._buttons_down):
            try:
                self.mouse_up(button)
            except OSError:
                pass
        return released


# --- mouse ---------------------------------------------------------------


def move_to(x: int, y: int) -> None:
    ax, ay = _to_absolute(x, y)
    _send([_mouse_input(_MOUSEEVENTF_MOVE | _MOUSEEVENTF_ABSOLUTE | _MOUSEEVENTF_VIRTUALDESK, ax, ay)])


def move_interpolated(x: int, y: int, duration_ms: int, should_cancel: Callable[[], bool]) -> bool:
    """Walk the cursor from where it is to `(x, y)`. False if cancelled midway."""
    if duration_ms <= 0:
        move_to(x, y)
        return True

    start_x, start_y = cursor_position()
    steps = max(1, round((duration_ms / 1000) * _INTERPOLATION_HZ))
    interval = (duration_ms / 1000) / steps

    for step in range(1, steps + 1):
        if should_cancel():
            return False
        fraction = step / steps
        move_to(round(start_x + (x - start_x) * fraction), round(start_y + (y - start_y) * fraction))
        if step < steps:
            time.sleep(interval)
    return True


def click(
    x: int,
    y: int,
    state: InputState,
    button: str = "left",
    double: bool = False,
    move_ms: int = 0,
    should_cancel: Callable[[], bool] = lambda: False,
) -> bool:
    """Move (interpolated) then click. False, with the mouse left where it is
    and nothing pressed, if the move itself was cancelled."""
    if button not in _BUTTON_DOWN:
        raise InvalidKey(f'Not a mouse button: "{button}".')
    if not move_interpolated(x, y, move_ms, should_cancel):
        return False

    state.mouse_down(button)
    time.sleep(SETTLE_SECONDS)
    state.mouse_up(button)
    if double:
        time.sleep(SETTLE_SECONDS)
        state.mouse_down(button)
        time.sleep(SETTLE_SECONDS)
        state.mouse_up(button)
    time.sleep(SETTLE_SECONDS)
    return True


# --- keyboard ------------------------------------------------------------


def send_text(text: str, should_cancel: Callable[[], bool]) -> int:
    """Type `text` one Unicode character at a time. Returns characters sent.

    Fewer than `len(text)` means a cancel arrived partway through — checked
    between characters, not just at the start, because a long paste is exactly
    the kind of action a person wants to be able to interrupt.
    """
    sent = 0
    for char in text:
        if should_cancel():
            break
        if char == "\n":
            key_tap(NAMED_KEYS["enter"], [])
        else:
            _send([_unicode_input(char, False)])
            _send([_unicode_input(char, True)])
        sent += 1
        time.sleep(CHAR_DELAY_SECONDS)
    return sent


def resolve_key(name: str) -> int:
    """A key name to its virtual-key code. Single characters use their own code
    point when it already IS the VK (true for A-Z and 0-9); anything else is
    looked up in the named-key table."""
    lowered = name.strip().lower()
    if lowered in NAMED_KEYS:
        return NAMED_KEYS[lowered]
    if lowered in MODIFIER_ALIASES:
        return MODIFIER_ALIASES[lowered]
    if len(name) == 1:
        upper = name.upper()
        if ("A" <= upper <= "Z") or ("0" <= upper <= "9"):
            return ord(upper)
        vk_and_shift = ctypes.windll.user32.VkKeyScanW(ord(name))
        if vk_and_shift != -1:
            return vk_and_shift & 0xFF
    raise InvalidKey(f'Not a recognised key: "{name}".')


def key_tap(vk: int, modifier_vks: list[int], state: InputState | None = None) -> None:
    """Press modifiers down, tap the key, release modifiers in reverse order.

    Takes `state` when the tap is part of a larger tracked sequence (so a cancel
    mid-chord can be released precisely); a bare `key_tap` used internally by
    `send_text` for embedded newlines needs no tracking because it never blocks
    long enough to be worth cancelling.
    """
    down = state.key_down if state else (lambda v: _send([_key_input(v, 0)]))
    up = state.key_up if state else (lambda v: _send([_key_input(v, _KEYEVENTF_KEYUP)]))
    for mod in modifier_vks:
        down(mod)
    time.sleep(SETTLE_SECONDS)
    _send([_key_input(vk, 0)])
    time.sleep(SETTLE_SECONDS)
    _send([_key_input(vk, _KEYEVENTF_KEYUP)])
    time.sleep(SETTLE_SECONDS)
    for mod in reversed(modifier_vks):
        up(mod)


def press_keys(chord: str, state: InputState) -> list[str]:
    """Parse "Ctrl+Shift+S"-style text and press it. Returns the parts used."""
    parts = [p for p in (piece.strip() for piece in chord.split("+")) if p != ""]
    if not parts:
        raise InvalidKey("No key was given.")

    *modifier_names, main_name = parts
    modifier_vks = [resolve_key(name) for name in modifier_names]
    main_vk = resolve_key(main_name)
    key_tap(main_vk, modifier_vks, state)
    return parts
