"""NDJSON request/response loop over stdin/stdout.

## The protocol

    -> {"id":"7","op":"snapshot","params":{...}}
    <- {"id":"7","ok":true,"data":{...},"ms":180}
    <- {"id":"7","ok":false,"error":{"code":"WINDOW_NOT_FOUND","message":"…",
                                     "recoverable":true}}

One frame per line, UTF-8, no embedded newlines. Same shape as the agent core's
own transport, for the same reason: pipes couple lifetimes. If the host dies the
pipe closes, this process reads EOF and exits, and a crashed UI can never leave
something behind that is able to drive the user's mouse.

## Zero idle cost

Between requests this process is blocked in `readline()`. There is no timer, no
watchdog, no polling loop, and — deliberately — no UIA event subscription.

The last one is the easy mistake. Global UIA event handlers run inside the
*target* application's process, so subscribing to "something changed anywhere"
imposes a permanent tax on every application the user runs, not on us. It would
also be invisible in our own CPU measurement, which makes it a cost we would
never notice we were imposing. If a later phase genuinely needs an event, it must
be scoped to a single element, held for the duration of one task, and released in
a `finally`.

## Two threads, and exactly why

UI Automation is apartment-bound: all of it has to happen on the thread that
entered the STA. So the main thread enters the apartment and does every op, one
at a time, in order.

But a cancel that queues behind the op it is cancelling is not a cancel. So a
separate reader thread owns stdin, and control ops — `cancel`, `stop`,
`shutdown` — are handled *there*, the instant they arrive, by setting a flag the
worker checks between tree levels and between siblings. Work ops go on a queue
for the apartment thread.

`stop` drains that queue. An emergency stop that only sets a flag for the current
operation leaves everything queued behind it to run, which is the opposite of
what the user pressed the key for.
"""

from __future__ import annotations

import json
import os
import platform
import queue
import sys
import threading
import time
import traceback
from typing import Any, Callable

from . import PROTOCOL_VERSION
from . import tree as tree_mod
from . import winenv

# --- errors -----------------------------------------------------------------

# Deliberately a subset of the core's own taxonomy (spec §50) plus the two codes
# Phase 7 adds. Keeping the vocabularies identical means the planner's recovery
# branches work on sidecar failures without a translation table in between.
INVALID_INPUT = "INVALID_INPUT"
WINDOW_NOT_FOUND = "WINDOW_NOT_FOUND"
ELEMENT_NOT_FOUND = "ELEMENT_NOT_FOUND"
TIMEOUT = "TIMEOUT"
USER_CANCELLED = "USER_CANCELLED"
UNSUPPORTED_PLATFORM = "UNSUPPORTED_PLATFORM"
INTERNAL_ERROR = "INTERNAL_ERROR"
STALE_REF = "STALE_REF"
PATTERN_UNAVAILABLE = "PATTERN_UNAVAILABLE"


class OpError(Exception):
    """A failure with a code the planner can branch on."""

    def __init__(self, code: str, message: str, recoverable: bool = True, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.recoverable = recoverable
        self.details = details

    def to_frame(self) -> dict[str, Any]:
        error: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "recoverable": self.recoverable,
        }
        if self.details:
            error["details"] = self.details
        return error


# --- transport --------------------------------------------------------------


class Channel:
    """Serialised writer for the one stream that carries the protocol."""

    def __init__(self, stream) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def send(self, frame: dict[str, Any]) -> None:
        line = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
        payload = line.encode("utf-8", errors="replace") + b"\n"
        with self._lock:
            try:
                self._stream.write(payload)
                self._stream.flush()
            except (BrokenPipeError, OSError):
                # The host is gone. Nothing useful can be reported to anyone.
                pass


def _claim_stdout():
    """Take exclusive ownership of stdout, then point `print` at stderr.

    Same rule as the agent core: stdout carries the protocol and nothing else.
    One stray line — a library's deprecation warning, a stray `print` left in a
    debug session — corrupts the frame stream, and the host sees a hung or lying
    sidecar rather than a parse error.
    """
    stream = sys.stdout.buffer
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    sys.stdout = sys.stderr
    return stream


# --- server -----------------------------------------------------------------


class Server:
    def __init__(self, dpi: str, com: str, max_queue: int = 64) -> None:
        self._channel = Channel(_claim_stdout())
        self._work: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=max_queue)
        self._cancel = threading.Event()
        self._running = True
        self._dpi = dpi
        self._com = com
        self._ops: dict[str, Callable[[dict[str, Any]], Any]] = {
            "ping": self._op_ping,
            "snapshot": self._op_snapshot,
        }

    # --- lifecycle ----------------------------------------------------------

    def run(self) -> int:
        reader = threading.Thread(target=self._read_stdin, name="samix-stdin", daemon=True)
        reader.start()
        self._work_loop()

        # Leave without running interpreter finalisation.
        #
        # The reader thread is parked in a blocking `readline()` on stdin and
        # holds that buffer's lock. Normal shutdown tries to finalise while it is
        # held and CPython aborts with an access violation:
        #
        #   Fatal Python error: _enter_buffered_busy: could not acquire lock for
        #   <_io.BufferedReader name='<stdin>'> at interpreter shutdown
        #
        # That turns every clean `shutdown` into exit code 0xC0000005, which the
        # client cannot tell from a real crash — so it would count against the
        # respawn budget and eventually degrade a perfectly healthy sidecar.
        #
        # There is nothing to flush: every frame is flushed as it is written, and
        # this process owns no other resource whose release matters. Waking the
        # reader instead would mean closing stdin from another thread, which
        # needs the same lock.
        sys.stderr.flush()
        os._exit(0)

    def _read_stdin(self) -> None:
        """Blocking read. This thread costs nothing while nothing arrives."""
        stream = sys.stdin.buffer
        try:
            while True:
                line = stream.readline()
                if not line:
                    break  # EOF: the host closed the pipe.
                self._dispatch_line(line)
        except (OSError, ValueError):
            pass
        finally:
            self._halt()

    def _halt(self) -> None:
        self._running = False
        self._cancel.set()
        try:
            self._work.put_nowait(None)
        except queue.Full:
            self._drain()
            self._work.put_nowait(None)

    def _drain(self) -> str:
        """Discard queued work, answering each request rather than dropping it."""
        discarded = 0
        while True:
            try:
                item = self._work.get_nowait()
            except queue.Empty:
                break
            if item is None:
                continue
            discarded += 1
            self._fail(item.get("id"), OpError(USER_CANCELLED, "Cancelled before it started."))
        return f"{discarded} queued"

    # --- reading ------------------------------------------------------------

    def _dispatch_line(self, line: bytes) -> None:
        text = line.decode("utf-8", errors="replace").strip()
        if not text:
            return
        try:
            frame = json.loads(text)
        except json.JSONDecodeError:
            # No id to answer against, so there is nobody to tell. The host's
            # own timeout is the backstop.
            return
        if not isinstance(frame, dict):
            return

        request_id = frame.get("id")
        op = frame.get("op")
        if not isinstance(op, str):
            self._fail(request_id, OpError(INVALID_INPUT, "Frame has no op."))
            return

        # Control ops are handled HERE, on the reader thread, so they take effect
        # while an operation is still running. Queueing them would make a cancel
        # arrive strictly after the thing it was meant to interrupt.
        if op == "cancel":
            self._cancel.set()
            self._ok(request_id, {"cancelled": True})
            return
        if op == "stop":
            self._cancel.set()
            drained = self._drain()
            self._ok(request_id, {"cancelled": True, "drained": drained})
            return
        if op == "shutdown":
            self._ok(request_id, {"stopped": True})
            self._halt()
            return

        try:
            self._work.put_nowait(frame)
        except queue.Full:
            self._fail(
                request_id,
                OpError(INTERNAL_ERROR, "The sidecar's request queue is full.", recoverable=True),
            )

    # --- working ------------------------------------------------------------

    def _work_loop(self) -> None:
        while True:
            frame = self._work.get()
            if frame is None:
                return
            if not self._running:
                self._fail(frame.get("id"), OpError(USER_CANCELLED, "The sidecar is shutting down."))
                continue
            self._execute(frame)

    def _execute(self, frame: dict[str, Any]) -> None:
        request_id = frame.get("id")
        op = str(frame.get("op"))
        params = frame.get("params")
        if not isinstance(params, dict):
            params = {}

        handler = self._ops.get(op)
        if handler is None:
            self._fail(request_id, OpError(INVALID_INPUT, f'Unknown op "{op}".', recoverable=False))
            return

        # A cancel that arrived while this request sat in the queue applies to
        # this request. Cleared here, once, so the flag means "cancel the op that
        # is running now" and never leaks into the next one.
        self._cancel.clear()

        started = time.monotonic()
        try:
            data = handler(params)
        except OpError as error:
            self._fail(request_id, error, elapsed_ms(started))
        except tree_mod.UiaUnavailable as error:
            self._fail(
                request_id,
                OpError(UNSUPPORTED_PLATFORM, str(error), recoverable=False),
                elapsed_ms(started),
            )
        except Exception as error:  # noqa: BLE001 - the boundary must not leak
            traceback.print_exc()
            self._fail(
                request_id,
                OpError(INTERNAL_ERROR, f"{type(error).__name__}: {error}"),
                elapsed_ms(started),
            )
        else:
            self._ok(request_id, data, elapsed_ms(started))

    # --- ops ----------------------------------------------------------------

    def _op_ping(self, _params: dict[str, Any]) -> dict[str, Any]:
        """Handshake. Reports what this process can actually do, not what it hopes.

        The client uses this to decide between the sidecar and the PowerShell
        fallback, so an honest `uia: false` here is what makes graceful
        degradation work instead of failing on the first real call.
        """
        uia_ok, uia_detail = True, ""
        try:
            uia_detail = tree_mod.probe()
        except Exception as error:  # noqa: BLE001
            uia_ok = False
            uia_detail = str(error)

        return {
            "protocolVersion": PROTOCOL_VERSION,
            "pid": os.getpid(),
            "python": platform.python_version(),
            "architecture": platform.machine(),
            "dpiAwareness": self._dpi,
            "com": self._com,
            "uia": uia_ok,
            "uiaDetail": uia_detail,
        }

    def _op_snapshot(self, params: dict[str, Any]) -> dict[str, Any]:
        limits = tree_mod.SnapshotLimits(
            max_depth=int(params.get("maxDepth", 12)),
            max_nodes=int(params.get("maxNodes", 400)),
            timeout_ms=int(params.get("timeoutMs", 2000)),
            include_offscreen=bool(params.get("includeOffscreen", False)),
        )
        if limits.max_depth < 1 or limits.max_nodes < 1 or limits.timeout_ms < 1:
            raise OpError(INVALID_INPUT, "Snapshot bounds must all be positive.", recoverable=False)

        exclude = frozenset(int(pid) for pid in params.get("excludePids", []) or [])
        handle = params.get("handle")
        scope = params.get("scope", "focused")
        if handle is None and scope not in ("focused",):
            # There is no "desktop" scope, and there will not be one. Walking
            # from the root is the unbounded case this whole design exists to
            # avoid, so it is refused at the edge rather than bounded later.
            raise OpError(
                INVALID_INPUT,
                f'Unknown scope "{scope}". A snapshot is always of one window.',
                recoverable=False,
            )

        window = winenv.resolve_window(int(handle) if handle is not None else None, exclude)
        if window is None:
            raise OpError(
                WINDOW_NOT_FOUND,
                f"No such window: {handle}." if handle is not None
                else "There are no ordinary windows open on this desktop.",
            )

        snap = tree_mod.snapshot(window, limits, self._cancel.is_set)
        if snap.truncated_reason == "cancelled":
            raise OpError(USER_CANCELLED, "The snapshot was cancelled.")
        return tree_mod.to_json(snap)

    # --- replies ------------------------------------------------------------

    def _ok(self, request_id: Any, data: Any, ms: int = 0) -> None:
        self._channel.send({"id": request_id, "ok": True, "data": data, "ms": ms})

    def _fail(self, request_id: Any, error: OpError, ms: int = 0) -> None:
        self._channel.send({"id": request_id, "ok": False, "error": error.to_frame(), "ms": ms})


def elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
