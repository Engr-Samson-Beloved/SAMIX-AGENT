# TODO

Forward work, ordered by the spec's phase plan (§70). Items are written so that
whoever picks one up knows what "done" means.

---

## Carried out of Phase 1

These are known gaps in shipped work, not future features.

- [ ] **Bundle a Node runtime with the installer.** Development spawns `node`
      from PATH. `sidecar.rs::node_executable()` already prefers a bundled
      `node/node.exe` resource; the packaging step to put one there is missing.
      Until then a packaged build requires Node installed.
      *Done when:* a clean Windows VM with no Node can install and run the app.
- [ ] **Windows Credential Manager secret store.** `SecretStore` is defined and
      `EphemeralSecretStore` is explicitly non-persistent. Implement the real
      backing store in the Rust host (the `keyring` crate) behind two new IPC
      methods, and mark the `secrets` subsystem `ready`.
      *Blocks:* Phase 3, which needs somewhere safe for the API key.
- [ ] **esbuild does not run on the primary development machine**, so
      `vite build` and `vite dev` hang. Diagnosis and remediation in
      `docs/PHASE-1-REPORT.md`. Not a code defect.
- [ ] Persist agent mode changes across restarts — currently written to config,
      but confirm behaviour after a crash mid-task.
- [ ] Crash recovery (spec §67): `runtime-state.json` path is reserved but
      nothing writes it. Detect an interrupted task on launch and offer to
      resume only reversible ones.

---

## Phase 2 — Voice

- [ ] Microphone capture and device enumeration; honour
      `voice.microphoneDisabled` as a hard mute (spec §83).
- [ ] Voice activity detection with silence timeout.
- [ ] faster-whisper transcription via a controlled local Python service
      (spec §5: call Python through a defined interface, do not scatter it).
- [ ] Wire `agent.transcription.*` events — the UI already renders them.
- [ ] Push-to-talk first; always-listening behind an explicit setting.
- [ ] Hotkey behaviour: idle → listening, listening → cancel (spec §34).
      Phase 1 wired only the emergency-stop half.
- [ ] Clear recording indicator whenever the microphone is open.

*Success:* say "Hello", see `Hello` in the console.

## Phase 3 — LLM (engine: Google Gemini)

- [ ] `src/ai/` provider abstraction: `provider.ts`, `google.ts`, `anthropic.ts`,
      `openai.ts`, `local.ts`, `model-router.ts` (spec §6).
- [ ] `GeminiPlanner implements Planner` — drops into the existing seam.
- [ ] **Make `registry.toLlmSchemas()` provider-aware.** It currently emits
      Anthropic's shape (`{ name, description, input_schema }`). Gemini wants
      `functionDeclarations` with a `parameters` object, and accepts only a
      restricted OpenAPI-style subset of JSON Schema — it rejects constructs
      that `z.toJSONSchema()` emits freely, notably `$ref`/`$defs`,
      `additionalProperties`, and some `anyOf` positions.
      *Do:* add a per-provider projection plus a sanitiser that inlines `$ref`s
      and strips unsupported keywords, and unit-test it against every registered
      tool so a future tool schema cannot silently break tool calling.
      *This is the one Phase 1 assumption the Gemini decision invalidates.*
- [ ] Confirm the exact model IDs in `llm.plannerModel` / `fastModel` /
      `visionModel` against the current Gemini model list before shipping —
      the defaults are a starting point, not a verified pin.
- [ ] Streaming responses so the UI updates during long turns (spec §47).
      Note Gemini streams a different envelope from Anthropic; keep the
      difference inside `google.ts`, never in the orchestrator.
- [ ] Decide how Gemini's thinking/reasoning budget maps onto
      `llm.maxOutputTokens`, and whether it needs its own config field.
- [ ] Implement `Planner.recover()` for real error recovery (spec §30).
- [ ] Context window management and summarisation (spec §62).
- [ ] Model routing: cheap model for classification, strong for planning (§63).
- [ ] Read the API key from the secret store, never from config or `.env` in a
      packaged build.

*Success:* "What is the current date?" is answered.

## Phase 4 — Filesystem

- [ ] `filesystem.{listDirectory,search,read,copy,move,rename,delete,
      createDirectory,exists,getMetadata,open}`.
- [ ] Every path passes `PathPolicy` (already built and tested).
- [ ] Real verifiers: after a copy, confirm the destination exists and matches
      size/hash. This is the first true test of the verification pipeline.
- [ ] `delete` is `destructive` + `irreversible` and must implement
      `describeEffect()` with the file count (spec §95).

*Success:* "Find my latest PDF and copy it to Desktop" works end to end.

## Phase 5 — Applications & processes

- [ ] Application registry with discovery (spec §14).
- [ ] `process.{list,find,launch,close,focus,isRunning}`.
- [ ] Never allow unrestricted process termination (spec §13).

## Phase 6 — Browser

- [ ] Playwright, DOM-first (spec §19).
- [ ] Download handling into the filesystem pipeline (spec §60).

## Phase 7 — Windows UI automation

- [ ] UI Automation tree inspection; prefer controls over coordinates (§15).
- [ ] `screen.capture`, `mouse.*`, `keyboard.*` with strict action limits (§16).
- [ ] Emergency stop must release synthetic input — hook is reserved in
      `Agent.emergencyStop()`.

## Phase 8 — WhatsApp

- [ ] Contact resolution with confidence scoring; **never guess** before an
      external action (spec §21, §94).
- [ ] Send verification: confirm the message appears in the conversation.

## Phase 9 — Memory

- [ ] SQLite + Drizzle at the reserved `paths.databaseFile`.
- [ ] Replace `TaskManager`'s in-memory history with persistence.
- [ ] Editable and deletable memories; never store secrets there (spec §24).

## Phase 10 — Developer tools

- [ ] `terminal.execute` behind `CommandPolicy` (spec §40) — allow-listed
      executables, argument checks, working directory, timeout, output cap.
      Gate behind `availableInModes: ['developer']` (already supported).
- [ ] Git and project tools.

## Phase 11 — Vision

- [ ] Screenshot → vision model → **structured observation**, never direct
      action (spec §18).

## Phase 12 — Advanced autonomy

- [ ] Scheduler, long-running tasks, workflows.
- [ ] Local models via Ollama/llama.cpp; offline mode.

---

## Engineering debt to watch

- [ ] `Agent.summarise()` will need rework once plans exceed a handful of steps.
- [ ] `EventBus` is synchronous; if a handler ever does real work it will need a
      queue. Keep handlers trivial until then.
- [ ] Log rotation is size-based only; consider age-based retention.
- [ ] No integration test yet across the real stdio transport — the RPC router
      is covered, the pipe is not.
- [ ] Frontend has no component tests (blocked by the same esbuild issue).
