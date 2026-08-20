"""Acting on elements: finding them, invoking them, setting their values.

## The stale-ref guard

Every action carries the structure hash of the snapshot that produced its `ref`.
Before anything is touched, the window is walked again and the hash recomputed.
If it differs, the action is refused with `STALE_REF` and the caller must
re-snapshot.

This is not a nicety. A `ref` is an index into a list of elements, and a UI that
has shifted — a row inserted, a menu opened, a dialog dismissed — renumbers that
list. Acting on the old number does not fail; it succeeds, on the wrong control.
Nothing downstream can catch it: the click worked, the verifier sees a click, and
the only evidence is a message sent to the wrong person. It is the defining
failure of this category of tool, so the guard is unconditional.

Re-walking to check costs about as much as the snapshot did (measured ~60ms on a
small window). That is the correct price. It also means the walk *is* the
resolution: a snapshot whose hash matches is by construction the same tree with
the same elements at the same indices, so `raw[ref - 1]` is the element the
caller meant, and there is no cache to go stale.

## Why the hash deliberately does not cover values

Setting a text field's value does not change the structure hash, and toggling a
checkbox does not either — measured, not assumed. That is the intended
behaviour: if editing a field invalidated every reference to every other control
in the window, the guard would fire constantly on ordinary work and would be
switched off within a week.

It does mean "the hash changed" cannot be the only evidence an action worked,
which is why the delta captured below is three-part: structure, toggle state, and
whether a new window appeared.
"""

from __future__ import annotations

import time
from typing import Callable

from . import input as input_mod
from . import tree as tree_mod
from .tree import Node, SnapshotLimits
from .winenv import Window

# UIA pattern ids, frozen by the platform.
#
# Reached through the generic `GetPattern(id)` rather than the typed helpers,
# because those are defined per control type: `ButtonControl` has no
# `GetValuePattern` attribute at all, so `getattr(control, "GetValuePattern")`
# is an AttributeError on exactly the elements where a caller is most likely to
# try it.
PATTERN_INVOKE = 10000
PATTERN_VALUE = 10002
PATTERN_EXPAND_COLLAPSE = 10005
PATTERN_SELECTION_ITEM = 10010
PATTERN_TOGGLE = 10015
PATTERN_LEGACY = 10018

#: How long to let the UI react before re-observing. Long enough for a WinForms
#: or WinUI control to repaint and raise its automation events, short enough not
#: to be felt. Anything that takes longer than this is reported `unverified`,
#: which is the honest answer for "it may still be happening".
SETTLE_SECONDS = 0.35


class StaleRef(Exception):
    """The window's structure changed after the snapshot that produced the ref."""

    def __init__(self, expected: str, actual: str) -> None:
        super().__init__(
            f"The window changed since it was read (tree {expected} is now {actual}). "
            f"Take a fresh snapshot before acting."
        )
        self.expected = expected
        self.actual = actual


class PatternUnavailable(Exception):
    """The element exists but cannot do what was asked of it."""


class RefNotFound(Exception):
    """No element carries that ref in the current snapshot."""


class Resolved:
    """An element, the node describing it, and the snapshot it came from."""

    def __init__(self, snapshot, node: Node, element) -> None:
        self.snapshot = snapshot
        self.node = node
        self.element = element

    @property
    def control(self):
        from uiautomation import uiautomation as _ua  # noqa: PLC0415

        return _ua.Control.CreateControlFromElement(self.element)

    def pattern(self, pattern_id: int, what: str):
        try:
            found = self.control.GetPattern(pattern_id)
        except Exception as cause:  # noqa: BLE001 - provider errors are not ours
            raise PatternUnavailable(
                f'"{self.node.name or self.node.role}" could not be asked to {what}: {cause}'
            ) from cause
        if found is None:
            raise PatternUnavailable(
                f'"{self.node.name or self.node.role}" is a {self.node.role} and does not '
                f"support {what}."
            )
        return found


def resolve(window: Window, ref: int, tree: str, limits: SnapshotLimits) -> Resolved:
    """Re-read the window, enforce the stale-ref guard, and return the element."""
    snapshot = tree_mod.snapshot(window, limits)
    if snapshot.tree != tree:
        raise StaleRef(tree, snapshot.tree)
    if ref < 1 or ref > len(snapshot.nodes):
        raise RefNotFound(
            f"There is no element [{ref}] in this window; it has {len(snapshot.nodes)}."
        )
    return Resolved(snapshot, snapshot.nodes[ref - 1], snapshot.raw[ref - 1])


# --- observation ------------------------------------------------------------


def _toggle_state(resolved: Resolved) -> str | None:
    if "toggle" not in resolved.node.patterns:
        return None
    try:
        return tree_mod.TOGGLE_STATES.get(resolved.control.GetPattern(PATTERN_TOGGLE).ToggleState)
    except Exception:  # noqa: BLE001
        return None


def _value_of(element) -> str | None:
    from uiautomation import uiautomation as _ua  # noqa: PLC0415

    try:
        pattern = _ua.Control.CreateControlFromElement(element).GetPattern(PATTERN_VALUE)
        return None if pattern is None else str(pattern.Value)
    except Exception:  # noqa: BLE001
        return None


def _observe(window: Window, own, limits: SnapshotLimits) -> dict:
    """The three things §6 accepts as evidence that something happened."""
    from . import winenv  # noqa: PLC0415

    snapshot = tree_mod.snapshot(window, limits)
    return {
        "tree": snapshot.tree,
        "windows": sorted(w.handle for w in winenv.list_windows(own)),
        "_snapshot": snapshot,
    }


def _delta(before: dict, after: dict) -> dict:
    new_windows = sorted(set(after["windows"]) - set(before["windows"]))
    return {
        "treeBefore": before["tree"],
        "treeAfter": after["tree"],
        "treeChanged": before["tree"] != after["tree"],
        "newWindows": new_windows,
    }


# --- actions ----------------------------------------------------------------


def find_elements(
    window: Window,
    limits: SnapshotLimits,
    query: str = "",
    role: str = "",
    actionable_only: bool = False,
    limit: int = 20,
) -> dict:
    """Search one window's tree. A read: it changes nothing.

    Matching is deliberately forgiving on case and position — a person says
    "click send" about a button labelled "Send message" — but the results carry
    the exact name so a caller can tell an approximate match from an exact one,
    and so a confirmation prompt can quote what the control really says.
    """
    snapshot = tree_mod.snapshot(window, limits)
    needle = query.strip().lower()
    wanted_role = role.strip().lower()
    actionable = {"invoke", "toggle", "value", "select", "expand"}

    matches: list[Node] = []
    for node in snapshot.nodes:
        if wanted_role and node.role.lower() != wanted_role:
            continue
        if actionable_only and not (actionable & set(node.patterns)):
            continue
        if needle:
            haystack = f"{node.name} {node.value or ''} {node.automation_id}".lower()
            if needle not in haystack:
                continue
        matches.append(node)

    exact = [n for n in matches if n.name.strip().lower() == needle] if needle else []
    ordered = exact + [n for n in matches if n not in exact]

    return {
        "tree": snapshot.tree,
        "window": snapshot.window.as_json(),
        "truncated": snapshot.truncated,
        "matchCount": len(ordered),
        "exactCount": len(exact),
        "elements": [tree_mod.node_json(n) for n in ordered[:limit]],
    }


def invoke(window: Window, own, ref: int, tree: str, limits: SnapshotLimits) -> dict:
    """Press a control the way a person would.

    Prefers the Invoke pattern; falls back to Toggle for checkboxes and
    SelectionItem for list and tab items, because "press this" is what the user
    means for all three and the distinction is an implementation detail of the
    application, not of the instruction.
    """
    resolved = resolve(window, ref, tree, limits)
    node = resolved.node

    if not node.enabled:
        raise PatternUnavailable(f'"{node.name or node.role}" is disabled.')

    before = _observe(window, own, limits)
    toggle_before = _toggle_state(resolved)

    if "invoke" in node.patterns:
        resolved.pattern(PATTERN_INVOKE, "press").Invoke()
        how = "invoke"
    elif "toggle" in node.patterns:
        resolved.pattern(PATTERN_TOGGLE, "toggle").Toggle()
        how = "toggle"
    elif "select" in node.patterns:
        resolved.pattern(PATTERN_SELECTION_ITEM, "select").Select()
        how = "select"
    elif "expand" in node.patterns:
        resolved.pattern(PATTERN_EXPAND_COLLAPSE, "expand").Expand()
        how = "expand"
    else:
        raise PatternUnavailable(
            f'"{node.name or node.role}" is a {node.role} with nothing to press.'
        )

    time.sleep(SETTLE_SECONDS)
    after = _observe(window, own, limits)

    # Re-read the toggle from the fresh snapshot rather than the stale element:
    # the point is to observe the world again, not to ask the same object twice.
    toggle_after = None
    if toggle_before is not None and ref <= len(after["_snapshot"].nodes):
        fresh = Resolved(after["_snapshot"], after["_snapshot"].nodes[ref - 1], after["_snapshot"].raw[ref - 1])
        toggle_after = _toggle_state(fresh)

    return {
        "ref": ref,
        "name": node.name,
        "role": node.role,
        "runtimeId": node.runtime_id,
        "how": how,
        "toggleBefore": toggle_before,
        "toggleAfter": toggle_after,
        **_delta(before, after),
    }


def set_value(
    window: Window, own, ref: int, tree: str, text: str, limits: SnapshotLimits
) -> dict:
    """Put text into a field, atomically, without synthesising keystrokes.

    The Value pattern replaces the whole contents in one operation. That is
    better than typing for every reason that matters here: it cannot be
    interleaved with the user's own keyboard, it cannot half-complete, it does
    not fire per-character handlers thousands of times, and it does not depend on
    the field having focus.
    """
    resolved = resolve(window, ref, tree, limits)
    node = resolved.node

    if not node.enabled:
        raise PatternUnavailable(f'"{node.name or node.role}" is disabled.')
    if "value" not in node.patterns:
        raise PatternUnavailable(
            f'"{node.name or node.role}" is a {node.role} and its value cannot be set. '
            f"It may be read-only."
        )

    before_value = node.value
    resolved.pattern(PATTERN_VALUE, "have its value set").SetValue(text)
    time.sleep(SETTLE_SECONDS)

    # Read it back from the element itself. This is the observation the verifier
    # is entitled to: what the field actually holds now, not what we asked for.
    after_value = _value_of(resolved.element)

    return {
        "ref": ref,
        "name": node.name,
        "role": node.role,
        "runtimeId": node.runtime_id,
        "requested": text,
        "valueBefore": before_value,
        "valueAfter": after_value,
        "matches": after_value == text,
    }
