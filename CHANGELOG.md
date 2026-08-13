# Changelog

All notable changes to SAMIX Agent are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-08-13

Phase 1: Foundation. The agent runtime, safety model and desktop shell.

### Added

**Contracts (`@samix/shared`)**

- Tool contract with permission level, reversibility, Zod input schema and a
  mandatory verification strategy.
- Machine-readable error taxonomy (15 codes) for planner-driven recovery.
- 13-state agent state model, task/step types, confirmation request & response.
- 25-variant typed event union covering lifecycle, voice, planning, tools,
  permissions and logging.
- Closed-method IPC protocol with per-method Zod validation.
- Full application config schema with defaults for every field.

**Runtime (`@samix/core`)**

- Agent orchestrator: bounded loop (step count, per-step retries, wall clock),
  single-flight task execution, cancellation checked at every boundary.
- State machine with a declared transition table; illegal transitions throw.
  No edge from `executing` to `completed` — verification gates completion.
- Step executor pipeline: resolve → validate → permission → confirm → execute
  with timeout → verify → audit → emit.
- Permission engine: 5 levels × 4 modes as a data table, with a hard floor that
  `system` actions are never auto-approved.
- Path policy (spec §39) where deny beats trust, with traversal resolved before
  matching.
- Rule-based Phase 1 planner behind the `Planner` interface that Phase 3 will
  replace with an Anthropic-backed one.
- Tool registry enforcing contract invariants at registration time.
- Two read-only tools: `system.getInfo`, `agent.getStatus`.
- Config store: atomic writes, corruption quarantined rather than discarded,
  field-level recovery, forward migrations, refusal to overwrite a newer file.
- Structured NDJSON logger with size-based rotation, an in-memory ring for the
  UI, and **redaction applied on the write path** so it cannot be forgotten.
- Append-only audit trail, separate from diagnostics, never level-filtered,
  recording blocked and declined actions as well as successes.
- Typed synchronous event bus with handler isolation.
- Secret storage interface with an explicitly non-persistent implementation
  (see *Known limitations*).
- Two transports over one shared RPC router: stdio (production) and a
  token-authenticated loopback HTTP/SSE bridge (development only).

**Desktop (`@samix/desktop`)**

- Tauri 2 host: system tray with state-reflecting tooltip and menu, global
  emergency-stop hotkey, single-instance guard, close-to-tray.
- Sidecar supervision with request/response correlation and lifecycle coupling.
- React console with four panes — console, tools, settings, logs — rendering
  from the live event stream rather than polling.
- Confirmation prompt showing effect, reason and concrete facts.
- Task timeline that distinguishes *verified* from *unverified* success.

**Project**

- pnpm workspace, TypeScript strict mode with `exactOptionalPropertyTypes`.
- 103 tests on Node's built-in runner.
- Four ADRs, README, TODO, prerequisite checker, icon generator.

### Fixed during development

- `Agent.summarise()` reported a confident "Done." for single-step tasks before
  checking whether the step was verified — violating development rule 25. Found
  by the test written from ADR-0004.
- Confirmation flow left the state machine in `awaiting_confirmation`, making
  the subsequent transition to `verifying` illegal and failing approved tasks.

### Known limitations

- **No voice.** Phase 2.
- **No LLM.** The Phase 1 planner is deterministic and handles a small set of
  instructions; anything else gets an honest "I don't yet understand that."
- **No filesystem, process, browser or WhatsApp tools.** Phases 4–8.
- **Secret storage is in-memory only.** The `SecretStore` interface is defined
  and the settings seam exists, but the Windows Credential Manager
  implementation is deferred to Phase 3, when the first real secret exists.
  Nothing is persisted insecurely in the meantime.
- **Sidecar packaging.** Development spawns `node` from PATH. A packaged build
  must bundle a Node runtime; tracked in `TODO.md`.
- **Tests run against `dist/`.** Node's type stripping does not resolve `.js`
  specifiers to `.ts` sources, so `pnpm test` builds first.
