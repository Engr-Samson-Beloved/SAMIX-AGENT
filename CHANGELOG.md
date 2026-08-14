# Changelog

All notable changes to SAMIX Agent are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Phase 3: the LLM engine. The agent now plans with Google Gemini and answers in
its own words; the deterministic Phase 1 planner remains as the no-key fallback.

### Added

**AI layer (`packages/core/src/ai/`)**

- Provider-neutral LLM contract — `ToolSchema`, `LlmMessage`, `LlmRequest`,
  `LlmResponse`, `LlmProvider` — so nothing outside `src/ai/` names a provider
  (spec §6).
- `LlmError` taxonomy of 12 kinds with an explicit retryable set and a
  `userMessage()` for the console. A 429 is disambiguated into `rate_limit`
  (retry helps) versus `quota` (retrying can never help).
- `GoogleProvider`: Gemini v1beta over `fetch`, no SDK. Bounded retries with
  backoff, cancellation checked before every attempt and never retried, the key
  resolved per request (so a rotated key takes effect immediately) and sent only
  in the `x-goog-api-key` header — asserted by test to appear in no body or URL.
- JSON Schema → Gemini projection. Gemini rejects an entire request when any one
  declaration carries an unknown keyword, so one bad tool schema would kill tool
  calling for every tool. The converter is allow-list based, inlines `$ref`s
  with a cycle guard, collapses nullable unions, folds unsupported formats into
  the description, and reports degradations as warnings rather than failing.
- Tool-name codec (`system.getInfo` ⇄ `system_getInfo`) with a reserved control
  function `samix__ask_user`, which is how the model asks a question instead of
  guessing (spec §94).
- `ModelRouter` + `classifyInstruction()`: the fast model for classification and
  reporting, the planner model for everything else. Deliberately biased towards
  the strong model — it steps down only on recognised-simple instructions.

**Agent**

- `LlmPlanner`: the model proposes, the planner disposes. Every proposed call is
  re-validated against the registry (existence, mode availability, real Zod
  input schema); one repair round-trip is offered, then the agent gives up
  honestly. A truncated response is never executed.
- `HybridPlanner`: chooses per turn between the LLM and the rule-based planner
  by asking the secret store for credentials, so a key pasted into Settings
  takes effect on the next instruction and a throwing store degrades instead of
  taking the agent down.
- **REPORT stage** in the agent loop. `Planner.summarise()` turns tool results
  into an actual answer instead of "Done." — but `Agent.report()` only invites
  it when nothing failed and nothing is unverified, so honesty is enforced
  structurally rather than by prompt.
- `registry.toLlmSchemas()` now emits provider-neutral JSON Schema; the dialect
  is the provider's problem.

**Project**

- `pnpm check:llm` — end-to-end check against the live API through a real
  runtime in a temp directory. Unit tests prove the code does what we think;
  this proves what we think matches what Google accepts.
- 183 tests (up from 103).

### Fixed

- Step descriptions shown to the user were the LLM-facing tool documentation
  ("Report facts about the computer the agent is running on: operating
  system…"). They are now derived from the tool name and arguments.
- `apps/desktop`'s `typecheck` script emitted `.js` files beside their `.tsx`
  sources before failing on TS5096. A stale emitted `.js` silently shadows the
  source at build time, so the script is fixed and the artifacts are gitignored.

### Known limitations

- Each instruction is planned in isolation; there is no conversation memory yet.
- Over-budget requests are refused rather than compacted (spec §62 pending).
- The API key still comes from `.env` via `DevEnvSecretStore`, which refuses to
  activate under `NODE_ENV=production`. Windows Credential Manager is the
  blocker for a packaged build.
- No streaming, so the console shows nothing during a turn.

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
