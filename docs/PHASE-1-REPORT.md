# Phase 1 — Foundation: completion report

Required by spec §106 rule 20.

**Date:** 2026-08-13 · **Version:** 0.1.0 · **Status:** complete, with one
environment blocker documented below.

---

## 1. What was built

Phase 1 as written in spec §70 is "Tauri, React, TypeScript, system tray,
settings, logging, configuration", with the success criterion *"application
launches as a Windows app"*. The scope was widened by agreement to include the
architectural seams that later phases plug into — because the alternative is
retrofitting them through finished code in Phase 3.

### The safety and runtime core

| Subsystem | What it does |
| --- | --- |
| **Agent orchestrator** | Bounded loop (step count, per-step retries, wall-clock budget), single-flight tasks, cancellation checked at every boundary. |
| **State machine** | 13 states, declared transition table, illegal transitions throw. **No edge from `executing` to `completed`.** |
| **Step executor** | resolve → validate → permission → confirm → execute-with-timeout → verify → audit → emit. Every stage mandatory. |
| **Permission engine** | 5 levels × 4 modes as a reviewable data table, with a hard floor. |
| **Path policy** | Deny beats trust; traversal resolved before matching. |
| **Tool registry** | Enforces contract invariants at registration, so bad tools fail at launch. |
| **Planner seam** | `Planner` interface + deterministic Phase 1 implementation. Phase 3 swaps the implementation and touches nothing else. |
| **Config store** | Atomic writes, corruption quarantined, field-level recovery, forward migrations, refuses to overwrite a newer file. |
| **Logger** | NDJSON + rotation + in-memory ring + **redaction on the write path**. |
| **Audit trail** | Append-only, separate from diagnostics, never level-filtered, records refusals. |
| **Event bus** | Typed, synchronous, handler-isolated. |
| **Transports** | stdio (production) and a token-authenticated loopback bridge (dev), sharing one RPC router. |

### The desktop shell

Tauri 2 host with system tray (state-reflecting tooltip, full menu), global
emergency-stop hotkey, single-instance guard, close-to-tray, and supervised
sidecar with request/response correlation. React console with four panes
rendering from the live event stream.

---

## 2. Files changed

Everything is new; the directory previously held only `SAMIX_AGENT.md` and an
empty `goals.txt`.

```
packages/shared/src/     8 files   contracts: tools, agent, config, log, mode,
                                   events, IPC, result helpers
packages/core/src/      21 files   runtime, agent, security, tools,
                                   observability, transports, RPC
packages/core/test/      8 files   103 tests
apps/desktop/src/       10 files   React console
apps/desktop/src-tauri/  4 rs      host, sidecar supervision, tray
scripts/                 3 files   prereq check, icon generation, smoke test
docs/                    5 files   4 ADRs + this report
root                     9 files   workspace, TS/ESLint/Prettier config,
                                   README, CHANGELOG, TODO, .env.example
```

---

## 3. Dependencies added

Deliberately few (development rule 20).

| Package | Where | Why |
| --- | --- | --- |
| `zod` | shared, core | Spec §73 mandates it for tool input, config, LLM output and IPC validation. |
| `react`, `react-dom` | desktop | Spec §4.1. |
| `@tauri-apps/api`, `@tauri-apps/cli` | desktop | Spec §4.1. |
| `vite`, `@vitejs/plugin-react` | desktop | Spec §4.1. |
| `typescript`, `eslint`, `typescript-eslint`, `prettier` | dev | Spec §73. |
| Rust: `tauri`, `tauri-plugin-global-shortcut`, `tauri-plugin-single-instance`, `serde`, `serde_json` | host | Tray, hotkey, single instance. |

**Deliberately not added**

- *A logging library* — the logger needs mandatory redaction, a UI ring buffer,
  event-bus fan-out, and an absolute prohibition on stdout. Those are custom
  transports in any library, so the wrapper would exceed the ~150 lines written.
- *A glob library* — the deny-list vocabulary is small, fixed and
  security-critical. A 20-line matcher we fully understand beats a dependency.
- *Tailwind CSS* (spec §4.1) — its v4 engine is a native binary, and this
  machine has already proven hostile to one (see §6). The UI is specified to
  stay minimal; ~250 lines of custom properties covers it. Revisit if the UI
  grows.
- *Vitest* (spec §73) — see §6.
- *A keychain module* — no secret exists to store until Phase 3.

---

## 4. Tests performed

| Suite | Result |
| --- | --- |
| Unit + integration (`node --test`) | **103 / 103 pass** |
| stdio smoke test (`scripts/smoke-core.mjs`) | **18 / 18 checks pass** |
| TypeScript strict (`shared`, `core`, `desktop`) | **clean** |
| ESLint | **0 errors** |
| `cargo check` (Tauri host) | **compiles** (1m22s) |
| Live process run with dev bridge | **starts, serves, shuts down cleanly** |

The 103 tests drive a *real* runtime — real config, permission engine, executor,
verification, audit trail and event bus — with only the planner substituted.
The smoke test additionally exercises the production stdio pipe, which no
in-process test can reach.

Coverage of the guarantees that matter:

- SAFE mode denies everything above `read`; `system` is never auto-approved in
  any mode under any configuration; config can only widen caution.
- A verifier that contradicts its tool fails the step (`VERIFICATION_FAILED`).
- A verifier that cannot run yields `succeeded_unverified`, and the summary says
  "could not confirm" rather than "Done."
- Declining a confirmation means the tool never starts.
- Emergency stop cancels in flight and latches the agent closed.
- Malformed tool input is rejected before any permission decision.
- The audit trail records refusals, not just successes.

### Two real bugs the tests caught

1. **`Agent.summarise()` claimed success for unverified work.** It
   short-circuited single-step tasks with `"Done. …"` *before* checking the
   unverified count — a direct violation of development rule 25, written by the
   same author who wrote the rule down. Fixed by reordering; documented in
   ADR-0004 as the argument for structural enforcement.
2. **Approved confirmations failed their tasks.** The confirmation gate left the
   machine in `awaiting_confirmation`, making the loop's later move to
   `verifying` an illegal transition. Caught because the state machine throws on
   illegal edges instead of silently tolerating them.

A third was found by running the process: closing stdin shut down the runtime
while the dev bridge kept serving a dead one. Fixed by moving transport teardown
to the entrypoint.

---

## 5. Verification against the spec's Phase 1 criterion

> *Success: Application launches as a Windows app.*

**Partially met, and honestly so.**

- The Rust host **compiles** and the frontend **typechecks**.
- The agent core **runs as a real process** and serves both transports.
- The two cannot currently be assembled into a running window, because
  bundling the frontend requires esbuild, which does not execute on this
  machine. See §6.

Everything blocking that is environmental, not code. No workaround was faked
and no green tick is claimed for something unverified.

---

## 6. The environment blocker: esbuild

**Symptom.** `esbuild.exe` spawns, consumes 300–400 seconds of CPU, and produces
no output — not even `--version`. Anything depending on it hangs indefinitely:
first Vitest, then `vite build`.

**Impact.** No frontend bundle, so `pnpm tauri dev` and `pnpm tauri build`
cannot complete. Rust, Node, the agent core and the test suite are unaffected.

**Diagnosis.** Windows Defender real-time protection is enabled
(`RealTimeProtectionEnabled: True`). esbuild's service-mode child process is a
well-known trigger for this class of interference on Windows.

**Remediation** — run once in an **elevated** PowerShell:

```powershell
Add-MpPreference -ExclusionPath 'C:\SAMIX-AI'
Add-MpPreference -ExclusionProcess 'esbuild.exe'
```

Then `pnpm install --force` and `pnpm tauri dev`. This session could not apply
it: adding an exclusion requires administrator rights.

**What was done about it instead of waiting.** The test suite was migrated off
Vitest to Node's built-in runner with native TypeScript type stripping — no
transform pipeline, no native binary, one fewer dependency. That is arguably the
better long-term choice for this project regardless of the bug, and it is why
103 tests run in about five seconds today.

---

## 7. Known limitations

- **No voice, no LLM, no filesystem/process/browser/WhatsApp tools.** Phases 2–8.
  The Phase 1 planner is deterministic and refuses honestly outside its range.
- **Secret storage is in-memory only.** The interface and settings seam exist;
  the OS-backed implementation lands in Phase 3 with the first real secret.
  Nothing is persisted insecurely in the meantime.
- **Sidecar packaging.** Development spawns `node` from PATH; a packaged build
  must bundle a runtime. The resolution hook already exists in `sidecar.rs`.
- **Tests run against `dist/`.** Node's type stripping does not map `.js`
  specifiers to `.ts`, so `pnpm test` builds first.
- **No frontend component tests** — blocked by the same esbuild issue.
- **Not a git repository.** No `git init` was run, as none was requested.

---

## 8. Next recommended phase

**Phase 2 — Voice**, per the spec's order, with one exception worth raising.

Phase 2 delivers the least *verifiable* value: transcription with no LLM behind
it can only display text. Phase 3 (LLM) is what makes the agent an agent, and
every seam it needs is already built and tested — `Planner`, `registry
.toLlmSchemas(mode)`, streaming events, context limits in config.

**Recommendation: do Phase 3 before Phase 2.** Typed instructions already flow
end to end, so an Anthropic planner can be built and tested immediately against
the real permission and verification pipeline. Voice then becomes an input
adapter in front of a system already proven to plan, execute and verify —
rather than a microphone wired to a planner that cannot yet think.

If the demo in spec §71 is the priority, that ordering also reaches it sooner:
Phase 3 + Phase 4 gives *"find the latest PDF and copy it to my Desktop"* as
typed text, and Phase 2 then makes it speech.

**Before either, one housekeeping item:** apply the Defender exclusion in §6 and
confirm `pnpm tauri dev` opens a window. That closes the one gap between this
report and the spec's stated Phase 1 criterion.
