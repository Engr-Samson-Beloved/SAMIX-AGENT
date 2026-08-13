# SAMIX Agent

A local-first autonomous computer agent for Windows. You speak or type an
instruction; the agent plans it, executes real operations through explicit
tools, **verifies that they actually happened**, and reports what it did.

> **Status: Phase 1 (Foundation) complete.** The runtime, permission system,
> verification pipeline, observability and desktop shell are built and tested.
> Voice arrives in Phase 2 and the LLM planner in Phase 3 — until then the agent
> understands a small set of deterministic instructions and says so plainly
> rather than guessing. See [`docs/PHASE-1-REPORT.md`](docs/PHASE-1-REPORT.md).

---

## Architecture

```
┌─────────────────────────────────────────────┐
│ Tauri host (Rust)                           │
│   window · system tray · global hotkey      │
│   single-instance guard                     │
│                                             │
│   ├── WebView — React console (display)     │
│   └── spawns ▼                              │
├─────────────────────────────────────────────┤
│ Node sidecar — THE AGENT                    │
│   state machine · planner · tool registry   │
│   permission engine · verifier · audit      │
└─────────────────────────────────────────────┘
        NDJSON over stdin/stdout
```

The agent runtime is pure TypeScript on Node and is fully testable without Rust
or a window. The Rust layer owns only the desktop shell and native integration.
Why this split: [ADR-0001](docs/ADR-0001-runtime-topology.md).

### Packages

| Package | Purpose |
| --- | --- |
| `packages/shared` | Contracts: tool schema, agent types, event union, IPC protocol, config schema. No runtime behaviour. |
| `packages/core` | The agent runtime. Runs as the sidecar. |
| `apps/desktop` | Tauri shell (Rust) + React console. |

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Node ≥ 20.11 | Node 24 recommended; the test suite uses native TypeScript type stripping. |
| pnpm ≥ 10 | `npm i -g pnpm` |
| Rust + Cargo | `winget install Rustlang.Rustup` — needed only for the desktop shell. |
| MSVC C++ Build Tools + Windows SDK | `winget install Microsoft.VisualStudio.2022.BuildTools` with the **Desktop development with C++** workload. |
| WebView2 Runtime | Preinstalled on Windows 11. |

Check everything at once:

```powershell
pnpm check:prereqs
```

---

## Getting started

```powershell
pnpm install
pnpm build:packages     # compile shared + core
pnpm test               # 103 tests
```

### Run the agent without the desktop shell

Fastest loop, and it needs no Rust. Starts the core with a loopback bridge:

```powershell
pnpm dev:core
```

It prints a bridge URL and a bearer token. Put them in `apps/desktop/.env.local`:

```
VITE_SAMIX_DEV_BRIDGE=http://127.0.0.1:8787
VITE_SAMIX_DEV_TOKEN=<the token printed above>
```

then in another terminal:

```powershell
pnpm dev:ui             # console at http://localhost:5173
```

### Run the full desktop application

```powershell
pnpm build:packages
pnpm tauri dev
```

First Rust build takes several minutes; later builds are incremental.

### Package a Windows installer

```powershell
pnpm build
pnpm tauri build        # produces an NSIS installer
```

---

## Try it

The Phase 1 planner is deterministic — no LLM, no network, no cost. It handles:

| Say | What happens |
| --- | --- |
| `what system am I on?` | `system.getInfo` → verified → reports OS, CPU, memory, user |
| `what is your status?` | `agent.getStatus` → mode, available tools, subsystem readiness |
| `how much memory do I have?` | `system.getInfo` scoped to hardware |
| anything else | says honestly that it does not understand yet, and lists what it can do |

That last row is the point. The agent never invents a plan it cannot execute.

---

## Safety model

Everything the agent can do is an explicit tool with a declared permission
level, and every invocation passes through one choke point:

```
resolve tool → validate input → permission decision → [confirm] →
execute with timeout → VERIFY → audit → report
```

- **Five permission levels** — `read`, `write`, `external`, `destructive`,
  `system` — combined with four modes (`SAFE`, `CONTROLLED`, `AUTONOMOUS`,
  `DEVELOPER`) in a reviewable table.
- **`system`-level actions are never auto-approved**, in any mode, under any
  configuration.
- **Configuration can only widen caution, never narrow it.**
- **Verification is structural**, not conventional: the state machine has no
  edge from `executing` to `completed`. When a tool claims success and the
  verifier disagrees, **the verifier wins**.
  ([ADR-0004](docs/ADR-0004-verification-and-honesty.md))
- **Emergency stop** on `Ctrl+Shift+Space`, from the tray, or from the console.
- **Secrets never touch JSON, SQLite or logs.** Redaction is applied on the
  logger's write path, so forgetting to scrub a field is not possible.
- **Audit trail** records every tool execution including blocked and declined
  ones, separately from diagnostics, never level-filtered.
- **No unrestricted shell.** There is no `exec` IPC method and no
  `invokeTool(name, args)` — the UI submits *instructions*, and only the planner
  chooses tools. ([ADR-0003](docs/ADR-0003-ipc-protocol.md))

---

## Where things live

```
%APPDATA%\SamixAgent\
├── config.json          settings (atomic writes, corruption quarantined)
├── logs\samix.log       diagnostics, NDJSON, rotated
├── logs\audit.log       append-only audit trail
└── samix.sqlite         memory (Phase 9)
```

---

## Development

```powershell
pnpm typecheck     # strict TypeScript across all packages
pnpm lint
pnpm test          # builds packages, then runs the suite
pnpm verify        # all three
```

Tests use Node's built-in runner (`node --test`) against the compiled output in
`dist/`. See the note at the top of `packages/core/test/helpers.ts` for why, and
`docs/PHASE-1-REPORT.md` for the environment issue that drove it.

### Adding a tool

1. Create it under `packages/core/src/tools/<namespace>/`.
2. Declare `permission`, `reversibility`, `inputSchema` and `verification`.
3. If it changes anything, supply `verify()` that **re-observes real state** —
   the registry rejects it otherwise.
4. If it is `external` or `destructive`, supply `describeEffect()` for the
   confirmation prompt.
5. Register it in `packages/core/src/tools/index.ts`.
6. Write tests.

---

## Roadmap

Phase 1 ✅ Foundation · Phase 2 Voice · Phase 3 LLM · Phase 4 Filesystem ·
Phase 5 Applications · Phase 6 Browser · Phase 7 UI automation · Phase 8
WhatsApp · Phase 9 Memory · Phase 10 Developer tools · Phase 11 Vision ·
Phase 12 Advanced autonomy

Full detail in [`TODO.md`](TODO.md).

---

## Licence

UNLICENSED — © SamixTech
