"""Bounded, filtered UI Automation tree walking.

## The shape of the problem

A UIA tree is unbounded in every direction that matters. A browser window can
carry tens of thousands of elements; a single `GetChildren` on the desktop root
enumerates every window on the machine and everything inside them. Reading a tree
"properly" is therefore not a thing that can be done — the only responsible
version of this operation is a *budgeted* one that returns what it managed to see
and says so.

So a truncated snapshot is a legitimate result, not an error. `truncated` is a
field on a successful response, never an error code.

## Four bounds, and why each exists

  scope       one window, never the desktop root. The root is the unbounded case.
  max_depth   depth is where cost compounds: each level multiplies.
  max_nodes   a hard stop on output size, which is also a token budget.
  timeout_ms  wall clock, because a hung provider ignores the other three.

All four come from config. None is hardcoded here — the defaults in
`SnapshotLimits` exist so the dataclass is constructible in a test, and the server
always passes explicit values through from the TypeScript side.

## Filtering happens in the provider, not in Python

The condition passed to `FindAllBuildCache` asks UIA for control-view elements
that are not offscreen. That matters more than it looks: elements excluded by the
condition are never marshalled across the process boundary and never cost a
recursion. Measured on a Chrome window on the development machine, depth<=12:

    control view, offscreen included   273 nodes   476 ms
    control view, onscreen only         24 nodes    46 ms

The per-node cost is nearly identical (1.74 vs 1.91 ms); the win is entirely in
not walking what cannot be seen. The cache request is worth having anyway — it
fetches all fourteen properties in the same cross-process call that returns the
element, instead of one round trip per property — but the filter is the lever.

`include_offscreen` exists as an escape hatch because "offscreen" is a provider's
opinion, and some applications mark scrolled-but-real content offscreen. It is
config, defaulting off, not a hardcoded choice.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from typing import Callable, Iterator

from .winenv import Bounds, Window

# --- UIA property ids -------------------------------------------------------
# Frozen by the platform, so these are data rather than a dependency. Named
# constants beat magic numbers at the call site where a typo would silently
# fetch a different property.
P_RUNTIME_ID = 30000
P_BOUNDING_RECT = 30001
P_CONTROL_TYPE = 30003
P_NAME = 30005
P_IS_ENABLED = 30010
P_AUTOMATION_ID = 30011
P_CLASS_NAME = 30012
P_HELP_TEXT = 30013
P_IS_CONTROL_ELEMENT = 30016
P_IS_OFFSCREEN = 30022
P_NATIVE_HANDLE = 30020
P_IS_EXPAND_COLLAPSE = 30028
P_IS_INVOKE = 30031
P_IS_SCROLL = 30034
P_IS_SELECTION_ITEM = 30036
P_IS_TEXT = 30040
P_IS_TOGGLE = 30041
P_IS_VALUE = 30043
P_VALUE_VALUE = 30045
P_VALUE_IS_READONLY = 30046
P_TOGGLE_STATE = 30086

_CACHED_PROPERTIES = (
    P_RUNTIME_ID,
    P_BOUNDING_RECT,
    P_CONTROL_TYPE,
    P_NAME,
    P_IS_ENABLED,
    P_AUTOMATION_ID,
    P_CLASS_NAME,
    P_HELP_TEXT,
    P_NATIVE_HANDLE,
    P_IS_EXPAND_COLLAPSE,
    P_IS_INVOKE,
    P_IS_SCROLL,
    P_IS_SELECTION_ITEM,
    P_IS_TEXT,
    P_IS_TOGGLE,
    P_IS_VALUE,
    P_VALUE_VALUE,
    P_VALUE_IS_READONLY,
    P_TOGGLE_STATE,
)

_TREE_SCOPE_ELEMENT = 1
_TREE_SCOPE_CHILDREN = 2
_ELEMENT_MODE_FULL = 1

# Control type ids are frozen by the platform. Short names on purpose: this text
# goes to a language model, and "Button" costs a third of "ButtonControl".
CONTROL_TYPES: dict[int, str] = {
    50000: "Button",
    50001: "Calendar",
    50002: "CheckBox",
    50003: "ComboBox",
    50004: "Edit",
    50005: "Link",
    50006: "Image",
    50007: "ListItem",
    50008: "List",
    50009: "Menu",
    50010: "MenuBar",
    50011: "MenuItem",
    50012: "ProgressBar",
    50013: "RadioButton",
    50014: "ScrollBar",
    50015: "Slider",
    50016: "Spinner",
    50017: "StatusBar",
    50018: "Tab",
    50019: "TabItem",
    50020: "Text",
    50021: "ToolBar",
    50022: "ToolTip",
    50023: "Tree",
    50024: "TreeItem",
    50025: "Custom",
    50026: "Group",
    50027: "Thumb",
    50028: "DataGrid",
    50029: "DataItem",
    50030: "Document",
    50031: "SplitButton",
    50032: "Window",
    50033: "Pane",
    50034: "Header",
    50035: "HeaderItem",
    50036: "Table",
    50037: "TitleBar",
    50038: "Separator",
    50039: "SemanticZoom",
    50040: "AppBar",
}

# Roles that are containers and nothing else. Kept in the walk (their children
# matter) but not emitted unless they carry a name — a nameless Pane is scaffold,
# and thirty of them in a snapshot is thirty lines the model has to read past.
_STRUCTURAL = frozenset({"Pane", "Group", "Custom", "Document", "Window", "TitleBar"})


@dataclass(frozen=True)
class SnapshotLimits:
    max_depth: int = 12
    max_nodes: int = 400
    timeout_ms: int = 2000
    include_offscreen: bool = False


@dataclass
class Node:
    """One element, flattened. `ref` is its index within THIS snapshot."""

    ref: int
    depth: int
    role: str
    name: str
    value: str | None
    automation_id: str
    runtime_id: str
    native_handle: int
    bounds: Bounds
    enabled: bool
    patterns: list[str] = field(default_factory=list)
    toggle: str | None = None


@dataclass
class Snapshot:
    window: Window
    nodes: list[Node]
    tree: str
    truncated: bool
    truncated_reason: str | None
    scanned: int
    elapsed_ms: int
    #: The live UI Automation elements, aligned with `nodes` by index, so
    #: `raw[node.ref - 1]` is the element `node` describes.
    #:
    #: Retained rather than looked up again later, because "find the element this
    #: ref meant" and "confirm the tree has not moved" are the same question: a
    #: snapshot whose hash still matches is, by construction, the same tree with
    #: the same elements at the same indices. Never serialised — these are COM
    #: pointers, and they leave this process only as a `ref`.
    raw: list = field(default_factory=list)


class UiaUnavailable(RuntimeError):
    """UI Automation could not be reached at all. Distinct from an empty tree."""


# --- client -----------------------------------------------------------------

_client = None


def _iuia():
    """The raw IUIAutomation interface.

    Reached through `uiautomation`'s client singleton rather than by creating our
    own COM object, so there is exactly one UIA client per process and it is the
    one the library's own helpers will use in later phases. The attribute is
    private to that library, which is why the dependency is pinned exactly.
    """
    global _client
    if _client is None:
        try:
            from uiautomation import uiautomation as _ua  # noqa: PLC0415
        except Exception as cause:  # pragma: no cover - import-time environment
            raise UiaUnavailable(f"uiautomation is not importable: {cause}") from cause
        try:
            _client = _ua._AutomationClient.instance().IUIAutomation
        except Exception as cause:
            raise UiaUnavailable(f"UI Automation client unavailable: {cause}") from cause
    return _client


def probe() -> str:
    """Touch UIA once so the handshake can report whether it actually works."""
    root = _iuia().GetRootElement()
    return str(root.CurrentClassName or "desktop")


# --- walking ----------------------------------------------------------------


def _condition(iuia, include_offscreen: bool):
    control_view = iuia.CreatePropertyCondition(P_IS_CONTROL_ELEMENT, True)
    if include_offscreen:
        return control_view
    return iuia.CreateAndCondition(
        control_view,
        iuia.CreatePropertyCondition(P_IS_OFFSCREEN, False),
    )


def _cache_request(iuia):
    request = iuia.CreateCacheRequest()
    for prop in _CACHED_PROPERTIES:
        request.AddProperty(prop)
    # Element, not Children. TreeScope on a cache request says which elements
    # *relative to each result* get their cache filled — setting it to Children
    # leaves the results themselves uncached, which fails at first read with a
    # bare "the parameter is incorrect".
    request.TreeScope = _TREE_SCOPE_ELEMENT
    request.AutomationElementMode = _ELEMENT_MODE_FULL
    return request


def _cached(element, prop, fallback=None):
    try:
        value = element.GetCachedPropertyValue(prop)
    except Exception:
        return fallback
    return fallback if value is None else value


def _text(element, prop) -> str:
    value = _cached(element, prop, "")
    return value.strip() if isinstance(value, str) else ""


def _flag(element, prop) -> bool:
    return bool(_cached(element, prop, False))


def _runtime_id(element) -> str:
    """Dotted RuntimeId, the closest thing UIA has to a durable element identity.

    Not durable across a process restart of the target application, and not
    unique across desktops — which is exactly why an action carries the tree hash
    as well. This alone is not a stale-ref guard.
    """
    raw = _cached(element, P_RUNTIME_ID, None)
    if not raw:
        return ""
    try:
        return ".".join(str(int(part)) for part in raw)
    except (TypeError, ValueError):
        return ""


def _bounds(element) -> Bounds:
    """Physical-pixel screen rectangle of an element.

    ## The trap

    UIA exposes this two ways and they do not agree on what the last two numbers
    mean. `CachedBoundingRectangle` is a Win32 `RECT` — left, top, **right,
    bottom**. `GetCachedPropertyValue(UIA_BoundingRectanglePropertyId)` is an
    array of four doubles — left, top, **width, height**.

    Reading the property array as a RECT computes `width - left` as the width. It
    is positive for anything near the left edge of the screen, so a snapshot of a
    window in the top-left corner looks fine, and every element further right
    silently collapses to a negative size. Those were then pruned as zero-area
    *before* they cost a recursion, so a Notepad window returned one element out
    of fifty-four and reported `truncated: false` — a confident, complete-looking
    answer that had thrown away the entire UI.

    So the typed accessor is preferred and the array form is the fallback, each
    read with the meaning it actually has.
    """
    try:
        rect = element.CachedBoundingRectangle
        return Bounds(
            int(rect.left),
            int(rect.top),
            int(rect.right - rect.left),
            int(rect.bottom - rect.top),
        )
    except Exception:
        pass

    raw = _cached(element, P_BOUNDING_RECT, None)
    if raw is None:
        return Bounds(0, 0, 0, 0)
    try:
        left, top, width, height = (float(value) for value in raw)
    except (TypeError, ValueError):
        return Bounds(0, 0, 0, 0)
    return Bounds(int(left), int(top), int(width), int(height))


TOGGLE_STATES = {0: "off", 1: "on", 2: "indeterminate"}


def _describe(element, ref: int, depth: int) -> Node:
    # A Value pattern is not the same as a writable field. A title bar, a status
    # line and a read-only combo box all expose one. Listing "value" for those
    # advertises a `setValue` target that will refuse the write, so the pattern
    # is claimed only when the value can actually be set — while the *text* is
    # still reported either way, because reading it is always useful.
    has_value = _flag(element, P_IS_VALUE)
    writable = has_value and not _flag(element, P_VALUE_IS_READONLY)

    patterns: list[str] = []
    if _flag(element, P_IS_INVOKE):
        patterns.append("invoke")
    if _flag(element, P_IS_TOGGLE):
        patterns.append("toggle")
    if writable:
        patterns.append("value")
    if _flag(element, P_IS_SELECTION_ITEM):
        patterns.append("select")
    if _flag(element, P_IS_EXPAND_COLLAPSE):
        patterns.append("expand")
    if _flag(element, P_IS_SCROLL):
        patterns.append("scroll")
    if _flag(element, P_IS_TEXT):
        patterns.append("text")

    name = _text(element, P_NAME) or _text(element, P_HELP_TEXT)
    value = _text(element, P_VALUE_VALUE) if has_value else None
    toggle = TOGGLE_STATES.get(_cached(element, P_TOGGLE_STATE, -1)) if "toggle" in patterns else None

    return Node(
        ref=ref,
        depth=depth,
        role=CONTROL_TYPES.get(int(_cached(element, P_CONTROL_TYPE, 0) or 0), "Unknown"),
        name=name,
        value=value,
        automation_id=_text(element, P_AUTOMATION_ID),
        runtime_id=_runtime_id(element),
        native_handle=int(_cached(element, P_NATIVE_HANDLE, 0) or 0),
        bounds=_bounds(element),
        enabled=bool(_cached(element, P_IS_ENABLED, True)),
        patterns=patterns,
        toggle=toggle,
    )


def _worth_emitting(node: Node) -> bool:
    """Keep what a person could act on or read; drop scaffolding.

    Interactive elements are kept even when nameless — a nameless button is a
    defect in the application, not a reason to hide it from the agent. Structural
    roles are kept only when they carry a name, because a named Group is a
    landmark ("Chats", "Toolbar") and a nameless one is a div.
    """
    if node.bounds.area <= 0:
        return False
    actionable = {"invoke", "toggle", "value", "select", "expand"} & set(node.patterns)
    if actionable:
        return True
    if node.role in _STRUCTURAL:
        return bool(node.name)
    return bool(node.name or node.value)


def _children(element, condition, request) -> Iterator[object]:
    try:
        found = element.FindAllBuildCache(_TREE_SCOPE_CHILDREN, condition, request)
    except Exception:
        # A provider that refuses to enumerate is a dead end, not a failed
        # snapshot: the rest of the tree is still worth returning.
        return
    for index in range(found.Length):
        yield found.GetElement(index)


def snapshot(
    window: Window,
    limits: SnapshotLimits,
    is_cancelled: Callable[[], bool] = lambda: False,
) -> Snapshot:
    """Walk one window's tree within all four budgets."""
    iuia = _iuia()
    root = iuia.ElementFromHandle(window.handle)
    if root is None:
        raise UiaUnavailable(f"no UI Automation element for window {window.handle}")

    condition = _condition(iuia, limits.include_offscreen)
    request = _cache_request(iuia)

    started = time.monotonic()
    deadline = started + limits.timeout_ms / 1000.0
    nodes: list[Node] = []
    raw: list = []
    scanned = 0

    # Two kinds of bound, and conflating them loses most of the tree.
    #
    # `stop` is global: node count, wall clock and cancellation are budgets for
    # the whole walk, so hitting one abandons everything still unvisited.
    #
    # `depth_limited` is per branch: reaching max depth prunes *that* subtree and
    # says nothing about the branch next to it. An early version used one flag
    # for both, so the first deep branch silently abandoned every sibling after
    # it — a snapshot that looked clean, reported a plausible node count, and had
    # quietly stopped reading the window a third of the way in.
    stop: str | None = None
    depth_limited = False

    def walk(element, depth: int, render_depth: int) -> None:
        nonlocal scanned, stop, depth_limited
        if depth >= limits.max_depth:
            depth_limited = True
            return

        for child in _children(element, condition, request):
            # Checked between siblings as well as between levels: one level of a
            # list view can hold thousands of items, and a bound that only
            # applies at level boundaries is not a bound.
            if len(nodes) >= limits.max_nodes:
                stop = "nodes"
                return
            if time.monotonic() > deadline:
                stop = "time"
                return
            if is_cancelled():
                stop = "cancelled"
                return

            scanned += 1
            node = _describe(child, len(nodes) + 1, render_depth)
            if node.bounds.area <= 0:
                # Zero area cannot contain something visible, so this skips a
                # recursion rather than just an emission.
                continue
            if _worth_emitting(node):
                nodes.append(node)
                raw.append(child)
                walk(child, depth + 1, render_depth + 1)
            else:
                walk(child, depth + 1, render_depth)
            if stop is not None:
                return

    walk(root, 0, 0)

    reason = stop or ("depth" if depth_limited else None)
    return Snapshot(
        window=window,
        nodes=nodes,
        raw=raw,
        tree=tree_hash(nodes),
        truncated=reason is not None,
        truncated_reason=reason,
        scanned=scanned,
        elapsed_ms=int((time.monotonic() - started) * 1000),
    )


# --- identity ---------------------------------------------------------------


def tree_hash(nodes: list[Node]) -> str:
    """A token for "the UI still looks the way it did when you read it".

    Hashes structure and identity — depth, role, name, automation id, in walk
    order — and deliberately NOT bounds. A window that moved by a pixel, or a
    list that scrolled, has not invalidated a reference to a button; making it do
    so would mean every hover invalidated every ref and the guard would be turned
    off within a week for being useless.

    Eight hex characters rather than the six in the brief's example. This guard
    fails *silently* when it collides — an action lands on shifted UI and nothing
    catches it afterwards — so the extra byte of headroom is cheap insurance on
    the one check that has no downstream verifier.
    """
    digest = hashlib.sha1(usedforsecurity=False)
    for node in nodes:
        digest.update(f"{node.depth}\x1f{node.role}\x1f{node.name}\x1f{node.automation_id}\x1e".encode())
    return digest.hexdigest()[:8]


# --- rendering --------------------------------------------------------------


def _truncate(text: str, limit: int = 80) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def render(snap: Snapshot) -> str:
    """The flat, indexed form the planner sees.

    Flat and line-oriented rather than nested JSON, because nested structure
    costs tokens to encode and costs the model attention to parse, and neither
    buys anything: every element already carries its own ref.
    """
    lines = [
        f"tree={snap.tree} window={snap.window.handle} "
        f"\"{_truncate(snap.window.title, 60)}\" ({snap.window.process_name})"
    ]
    for node in snap.nodes:
        parts = [f"[{node.ref}]{'  ' * node.depth} {node.role}"]
        if node.name:
            parts.append(f' "{_truncate(node.name)}"')
        if node.value is not None:
            parts.append(f' = "{_truncate(node.value, 60)}"')
        if node.toggle is not None:
            parts.append(f" [toggle={node.toggle}]")
        if not node.enabled:
            parts.append(" [disabled]")
        lines.append("".join(parts))
    lines.append(f"truncated: {'true' if snap.truncated else 'false'}")
    if snap.truncated_reason:
        lines[-1] += f" ({snap.truncated_reason})"
    return "\n".join(lines)


def node_json(node: Node) -> dict:
    """One element, as it crosses the process boundary.

    `bounds` is physical pixels. `ref` is an index into the snapshot that
    produced it and means nothing without that snapshot's `tree` hash.
    """
    return {
        "ref": node.ref,
        "depth": node.depth,
        "role": node.role,
        "name": node.name,
        "value": node.value,
        "automationId": node.automation_id,
        "runtimeId": node.runtime_id,
        "nativeHandle": node.native_handle,
        "bounds": node.bounds.as_list(),
        "enabled": node.enabled,
        "patterns": node.patterns,
        "toggle": node.toggle,
    }


def to_json(snap: Snapshot) -> dict:
    return {
        # The full window record, `isOwn` included. The snapshot path already
        # refuses to target one of the agent's own windows, so this is always
        # false today — but the permission engine reads it, and a field that
        # silently does not exist is a guard that silently does not run.
        "window": snap.window.as_json(),
        "tree": snap.tree,
        "truncated": snap.truncated,
        "truncatedReason": snap.truncated_reason,
        "nodeCount": len(snap.nodes),
        "scanned": snap.scanned,
        "elements": [node_json(node) for node in snap.nodes],
        "text": render(snap),
    }
