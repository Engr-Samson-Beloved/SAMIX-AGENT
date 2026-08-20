# SAMIX desktop control sidecar

A long-lived Python process that exposes Windows UI Automation to the agent core
over newline-delimited JSON on stdin/stdout.

```
pnpm setup:desktop            # one-time: build .venv and install the pins
pnpm check:desktop            # live, read-only, against a window it creates
pnpm check:desktop --idle 300 # plus a five-minute idle-cost measurement
```

## Why a separate process, in Python

UI Automation is a COM API. The mature bindings for it are Python's
(`uiautomation`, `pywinauto`); reaching it from Rust through `windows-rs` is a
large amount of unsafe boilerplate for capability that already exists. So this is
Python, and it sits behind the agent's ordinary tool interface, which means it
stays replaceable — nothing above the tool layer knows it is Python, and swapping
it for a Rust implementation later changes one directory.

It is a *process* rather than a library because UI Automation is apartment-bound
and because a per-call process is the mistake the PowerShell window tools already
make: they pay ~3.4s of interpreter startup and ~1.7s of C# compilation on every
single call. A persistent process pays that once.

## Layout

| File | What it owns |
| --- | --- |
| `__main__.py` | Startup ordering — DPI, then COM, then the protocol. Non-cosmetic. |
| `winenv.py` | `ctypes` against user32/dwmapi: DPI, COM init, window enumeration. |
| `tree.py` | The bounded, filtered tree walk, the structure hash, the flat render. |
| `server.py` | The NDJSON loop, the reader/worker split, cancellation, errors. |

## Design constraints this must keep meeting

**Zero idle cost.** Between requests the process is blocked in `readline()`.
There is no timer, no watchdog, no polling, and no UI Automation event
subscription. The last is the easy mistake: global UIA event handlers run inside
the *target* application's process, so subscribing would tax every application
the user runs — a cost that would never show up in our own CPU measurement.

**Every walk is bounded four ways** — one window (never the desktop root), depth,
node count, wall clock. All four come from `automation.desktop` in the user's
config, not from constants here. A truncated snapshot is a legitimate result with
`truncated: true`, never an error.

**Filtering happens in the provider.** The condition handed to
`FindAllBuildCache` asks UIA for control-view elements that are not offscreen, so
excluded elements never cross the process boundary and never cost a recursion.
Measured on a Chrome window at depth ≤ 12: 273 nodes / 476 ms unfiltered against
24 nodes / 46 ms filtered.

**Coordinates are physical pixels.** That is only true because per-monitor-v2 DPI
awareness is declared before `uiautomation` is imported — the library declares a
weaker level itself on import, and the first declaration wins.

**Degrade, never fail hard.** If Python is missing, the dependencies are absent,
or COM refuses, the handshake says so and the agent falls back to its existing
PowerShell path for window management. The agent must still start, and still
work.

## Dependencies

Pure-Python prebuilt wheels only — nothing that needs a compiler on a user's
machine. Pinned exactly in `requirements.txt`; nothing is added without asking.

## Protocol

```
-> {"id":"7","op":"snapshot","params":{"handle":123,"maxNodes":400}}
<- {"id":"7","ok":true,"data":{…},"ms":66}
<- {"id":"7","ok":false,"error":{"code":"WINDOW_NOT_FOUND","message":"…","recoverable":true}}
```

Error codes are the agent's own taxonomy, not a private one, so the planner's
recovery branches work without a translation table in between.

`cancel` and `stop` are handled on the reader thread and take effect while an
operation is still running. `stop` additionally drains the queue: an emergency
stop that only sets a flag leaves everything queued behind it to run, which is
the opposite of what the user pressed the key for.

`stdout` carries the protocol and nothing else. `sys.stdout` is pointed at
`stderr` at startup so no library `print` can corrupt the frame stream.
