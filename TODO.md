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
      *Now the top blocker:* Phase 3 works, but only because
      `DevEnvSecretStore` reads `GEMINI_API_KEY` from the environment, which it
      refuses to do under `NODE_ENV=production`. Until this lands there is no
      way for a packaged build to hold a key at all.
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

**Status: the core path is done and verified against the live API.**
`pnpm check:llm` drives real instructions through the whole loop; the remaining
unticked items are refinements, not blockers.

- [x] ~~`src/ai/` provider abstraction (spec §6).~~ `types.ts` (provider-neutral
      contract and `LlmError` taxonomy), `json-schema.ts`, `google.ts`,
      `model-router.ts`, `index.ts` with `createProvider()`. Unimplemented
      providers throw rather than silently falling back to Google.
- [x] ~~`GeminiPlanner implements Planner`.~~ Shipped as `LlmPlanner`
      (provider-neutral, per spec §6 — nothing outside `src/ai/` names a
      provider) plus `HybridPlanner`, which re-checks credentials each turn and
      falls back to the rule-based planner when no key is configured.
- [x] ~~Make `registry.toLlmSchemas()` provider-aware.~~ The registry now emits
      neutral JSON Schema and `ai/json-schema.ts` projects it into Gemini's
      dialect. The sanitiser is **allow-list based**: it copies keywords it
      understands rather than stripping ones it knows are bad, so a future Zod
      construct degrades to a warning instead of poisoning the request. 18 unit
      tests plus a startup assertion over every registered tool.
- [x] ~~Confirm the exact model IDs against the live API.~~ Done 2026-08-13 via
      `pnpm check:gemini`. Defaults are now `gemini-3.6-flash` (planner/vision)
      and `gemini-3.5-flash-lite` (fast), each verified to complete a function
      call with a SAMIX-shaped tool schema.
- [x] ~~Model routing: cheap model for classification, strong for planning
      (§63).~~ `ModelRouter` + `classifyInstruction()`. Biased towards the
      strong model: it steps down only on positively-recognised simple
      instructions, because mis-planning costs more than 2s of latency.
- [x] ~~Implement `Planner.recover()` for real error recovery (spec §30).~~
      A prose-only answer during recovery becomes a give-up, never a `reply` —
      a `reply` would drive `Agent.complete()` and mark a failed task done.
- [x] ~~REPORT stage.~~ `Planner.summarise()` turns tool results into an answer.
      Honesty is structural, not prompted: `Agent.report()` only invites the
      planner to write a summary when nothing failed and nothing is unverified,
      so no model can talk the agent into "everything worked perfectly".
- [ ] **The current key has no Pro access** — every `*-pro-*` model returns
      `RESOURCE_EXHAUSTED` (quota/billing), so the planner is Flash-class.
      Flash handles the tool-calling probe fine, but Pro would plan
      multi-step tasks better. Revisit once billing is enabled, and re-run
      `pnpm check:gemini` to confirm entitlement before changing the pin.
- [ ] Re-run `pnpm check:gemini` in CI, or at least before each release —
      Google retires models without warning. The 2.5 family was already
      "no longer available to new users" the day these defaults were written.
- [ ] Streaming responses so the UI updates during long turns (spec §47).
      Note Gemini streams a different envelope from Anthropic; keep the
      difference inside `google.ts`, never in the orchestrator.
- [ ] Decide how Gemini's thinking/reasoning budget maps onto
      `llm.maxOutputTokens`, and whether it needs its own config field.
- [ ] Context window management and summarisation (spec §62). Today the planner
      refuses a request over the character-estimated budget rather than
      compacting history; that is honest but not yet useful for long tasks.
- [ ] Multi-turn conversation memory: each instruction is planned in isolation,
      so "and now do the same for the other one" cannot work.
- [ ] Read the API key from the secret store, never from config or `.env` in a
      packaged build. `DevEnvSecretStore` seeds from `GEMINI_API_KEY` and
      refuses to activate when `NODE_ENV=production`, so this is currently
      *safe* but *development-only* — the Credential Manager item above is what
      unblocks a shippable build.

*Success:* achieved — `pnpm check:llm` answers "What operating system and CPU is
this computer running?" from a real tool result, and refuses to invent a delete
tool for "Delete the thing I mentioned earlier."

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
