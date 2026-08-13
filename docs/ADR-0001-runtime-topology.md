# ADR-0001: Runtime topology — Node sidecar owns the agent

- **Status:** Accepted
- **Date:** 2026-08-12
- **Phase:** 1

## Context

The agent needs a home for the orchestrator, tool registry, permission engine,
LLM client and memory. The spec (§5) assigns orchestration to TypeScript and
native integration to Rust/Tauri, but does not say which *process* runs the
TypeScript. Three options were live:

| Option | Orchestrator runs in |
| --- | --- |
| A | The Tauri WebView (frontend TypeScript) |
| B | A Node child process supervised by the Tauri host |
| C | Rust |

## Decision

**Option B.** The Tauri host spawns and supervises a Node process that owns the
entire agent runtime. The WebView is a display client. They speak newline-
delimited JSON over the child's stdin/stdout (ADR-0003).

## Rationale

The decision is forced by what later phases need, not by what Phase 1 needs.

1. **Playwright (Phase 6) cannot run in a WebView.** It drives browsers from
   Node. Option A would require reimplementing browser automation over IPC.
2. **`better-sqlite3` / Drizzle (Phase 9) are native Node modules.** Same
   problem.
3. **Secrets must not live in the WebView.** Under Option A the Anthropic API
   key is loaded into the renderer, the least trustworthy process in the app,
   which contradicts spec §38.
4. **Tasks must outlive the window.** Spec §35 has the agent living in the tray
   with the window closed. Under Option A, closing the window kills the agent
   mid-task.
5. **The spec explicitly rejects Option C** for orchestration (§5) — and it
   would forfeit the Anthropic SDK, Playwright and the JS ecosystem for the
   three subsystems that most depend on them.

Retrofitting Option B later would mean rewriting every seam: tool execution, the
LLM client, memory access and the event bus. Doing it first costs one process
and a protocol; doing it in Phase 6 costs a rewrite.

## Consequences

**Accepted costs**

- One extra process, and ~50MB for a bundled Node runtime in the installer.
- Every UI interaction crosses two hops (WebView → Rust → Node). Measured at
  well under the spec §91 latency budget, since the hops are local pipes.
- The core must be built (`pnpm build:packages`) before the desktop app runs.

**Benefits realised in Phase 1**

- The entire agent runtime is testable headlessly with no Rust and no window.
  All 103 tests run against the real runtime in ~5 seconds.
- Development on the frontend does not require compiling Rust, via the loopback
  bridge (ADR-0003).
- A crashed WebView cannot leave automation running: the host kills the core.

**Open item carried to Phase 3**

Production packaging of the Node runtime. Development spawns `node` from PATH;
a packaged build must ship a runtime so the user is not required to install
Node. Tracked in `TODO.md`.

## Alternatives reconsidered

Option A remains defensible for an app that never grows past filesystem tools.
This one is specified to reach browser automation, WhatsApp, SQLite and local
models, so it does not apply.
