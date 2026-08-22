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
- [x] ~~**esbuild does not run on the primary development machine.**~~ Fixed, and
      the long-standing diagnosis was wrong. It was never Defender and no
      exclusion helped. `@esbuild/win32-x64/esbuild.exe` in the pnpm store was
      **corrupt**: 533,504 bytes against a correct 11,694,592, and a 32-bit x86
      PE image inside a package that must hold a 64-bit one. All three Windows
      esbuild packages contained the *same* wrong file, which is what rules out a
      platform mismatch and points at the store. A fresh copy of the same version
      and package runs instantly. `vite build` now completes in 2.2s.
      *Durable repair:* `pnpm store prune && pnpm install --force`. The note in
      `docs/PHASE-1-REPORT.md` is superseded and should be corrected in place.
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
- [x] ~~**Multi-round planning (`Planner.continue`).**~~ Found by actually
      driving the agent through natural language against a real desktop
      window: `plan()` is one blind LLM turn, so it can never correctly call
      `desktop.setValue`/`desktop.invoke`/`desktop.click` — their `ref` and
      `tree` arguments do not exist until a prior `desktop.snapshot` has
      actually run. Gemini did the honest thing (called `window.list`, then
      stopped rather than invent a ref) and the orchestrator wrongly treated
      that single successful step as the whole task. `Agent.run()` now loops:
      after a batch of steps all succeed, it calls `planner.continue()` with
      their real results attached (reusing the conversation-replay shape
      `recover()` already had for failures) and asks whether more is needed,
      bounded by the new `automation.maxContinuationRounds` (default 8) on top
      of the existing `maxStepsPerTask`. A planner with no opinion (the
      rule-based fallback) is unaffected — one round, exactly as before.
      Confirmed live: "type X into the Message field, then check the Remember
      me box" now runs `window.list` → `desktop.snapshot` →
      `desktop.setValue` + `desktop.invoke` (using the real ref/tree from the
      snapshot) → done, each write verified against real UI state. 5 new tests
      in `agent-loop.test.ts`.
      *Cost, measured live:* every task now pays at least one extra
      round-trip to ask "anything else?" — ~1.3s on the fast model for a
      trivial single-step task, more for the planner-tier model. `ModelRouter`
      already routes a recognised-simple instruction's continuation check to
      the fast model, which is what keeps this cheap in the common case; it
      is not yet routed independently of the *original* instruction's
      classification, so a complex instruction's every continuation round
      pays planner-tier latency even once nothing but "yes/no more" remains.
      Worth revisiting if that turns out to matter in practice — not before.
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
- [x] ~~Multi-turn conversation memory.~~ The planner sees the last six
      exchanges, plus `AgentContext`: the structured tool call behind any offer
      it made, and what "it"/"that"/"this window" last pointed at. "Yes, do that
      then" now runs the offered call without re-planning it.
- [ ] The conversation window is a fixed six turns and the referents are a fixed
      four fields. Both are deliberate floors rather than designs; revisit
      against real transcripts once Phase 9 persists them.
- [ ] Read the API key from the secret store, never from config or `.env` in a
      packaged build. `DevEnvSecretStore` seeds from `GEMINI_API_KEY` and
      refuses to activate when `NODE_ENV=production`, so this is currently
      *safe* but *development-only* — the Credential Manager item above is what
      unblocks a shippable build.

*Success:* achieved — `pnpm check:llm` answers "What operating system and CPU is
this computer running?" from a real tool result, and refuses to invent a delete
tool for "Delete the thing I mentioned earlier."

## Phase 4 — Filesystem

- [x] ~~`filesystem.{listDirectory,search,readTextFile,getMetadata,
      createDirectory,copy,move,rename,delete}`.~~ Nine tools shipped.
- [x] ~~Every path passes `PathPolicy`.~~ Through one shared `guardPath()`, so
      the property is "one function" rather than "nine authors remembered".
- [x] ~~Real verifiers.~~ Copy compares destination size against source; move
      checks both ends (arrival *and* departure — the half-state is the
      dangerous one); delete confirms absence.
- [x] ~~`delete` is `destructive` + `irreversible` with `describeEffect()`.~~
- [ ] **`describeEffect()` cannot state the file count**, which is what spec §95
      actually asks for ("this will permanently delete 184 files"). The contract
      is synchronous, so it cannot stat the tree. Either make it async or have
      the executor pass a pre-computed effect. The count *is* gathered during
      execute and reported afterwards; it is only missing from the prompt.
- [ ] **Untrusted paths cannot request confirmation**, so the guard refuses
      untrusted *writes* outright instead. Spec §39 wants "untrusted requires
      confirmation even for reads", which needs the permission engine to accept
      a runtime path decision, not just a tool's declared level. Reasoned
      through in `filesystem/guard.ts`.
- [ ] `filesystem.writeTextFile` — creating a file with content is still missing.
- [ ] Deletes bypass the Recycle Bin. A native shell call or an app-owned trash
      folder would make them recoverable; both are real design decisions.
- [ ] Hash comparison for copy verification. Size matching catches truncation,
      which is the common failure, but not corruption.

*Success:* achieved — "What are the 3 most recently modified files in my
Downloads folder?" is answered from a real search.

## Phase 5 — Applications & processes

- [x] ~~Application registry with discovery (spec §14).~~ Curated table probed at
      documented install locations, plus a depth-limited scan of the install
      roots filtered by a "is this the main binary?" heuristic.
- [x] ~~`app.{list,launch,close}` and `process.list`.~~
- [x] ~~Never allow unrestricted process termination (spec §13).~~ `taskkill`
      without `/F`, so an app with unsaved work keeps it and the refusal is
      reported honestly instead of being forced.
- [x] ~~No arbitrary-executable primitive.~~ `app.launch` takes a *name*
      resolved against discovery, never a path, and `NEVER_LAUNCHABLE` refuses
      shells, interpreters and living-off-the-land binaries even when found.
- [x] ~~Window focus.~~ Shipped as `window.focus` in Phase 7 below.
- [ ] `process.find`. `process.list` with a filter covers most of it; a dedicated
      tool would let the planner ask about one process without reading them all.
- [ ] Discovery misses apps whose binary is not named after its folder — the
      heuristic errs towards omitting rather than listing noise. Reading the
      `App Paths` registry key would close most of the gap.

*Success:* achieved — "Open Chrome" works.

## Phase 6 — Browser

**Status: DOM-first automation is done and verified against a live Chrome.**
`pnpm dev:browser` drives every tool end to end on the real machine.

- [x] ~~Playwright, DOM-first (spec §19).~~ `browser.{goto,search,scroll,click,
      extractText,screenshot,close}` over `chromium.connectOverCDP`, sharing one
      page handle. Every action re-reads `page.url()` and `page.title()` after
      the load settles, so verification observes the world instead of assuming.
- [x] ~~Keep the user's real session.~~ Attaches to a real Chrome rather than
      launching an automation profile: an already-listening debug port first,
      then their real profile, then a persistent SAMIX profile. The fallback is
      reported to the user, never hidden.
- [x] ~~Reclassify browsing as READ (spec §31).~~ Fetching and observing is
      retrieval, not transmission; only `click` still confirms.
- [x] ~~`http`/`https` only.~~ Boundary carried over unchanged in `parseWebUrl`.
- [ ] **Typing into a page.** `browser.type`, `select`, `press` (spec §19) — the
      subsystem can read and click but cannot fill in a form. These are the
      tools that will need `external` permission, since a form submission does
      transmit the user's data.
- [ ] Download handling into the filesystem pipeline (spec §60).
- [ ] `browser.find` and `browser.upload` from the spec's §19 list.
- [ ] `browser.back`, `forward`, `refresh` — trivial, simply not yet needed.
- [ ] **Consent walls are read through, not dismissed.** In Europe Google renders
      results behind a cookie overlay; the agent reads the DOM underneath, so its
      answer is correct while the user's screen shows a consent prompt. The
      answer and the screen disagree, which is worth resolving — probably by
      reporting the overlay rather than by clicking it, since clicking consent on
      the user's behalf is their decision.
- [ ] **Sessions are not multiplexed.** One page handle, so a plan cannot work
      across two tabs. Fine today; a real limit for anything comparative.

## Phase 7 — Windows UI automation

**Status: windows and the controls inside them are both covered and confirmed
working end to end from typed natural language** — `desktop.snapshot`,
`findElement`, `invoke`, `setValue`, `click`, `type` and `pressKey` are wired,
registered, and (as of the `Planner.continue` fix above) actually reachable by
the planner across a real multi-step chain, not just by direct unit/live
checks. This status line was stale until 2026-08-22; the steps below were
already marked done.

- [x] ~~`window.{list,focus,close}` and `screen.getActiveWindow`~~ via `user32`
      P/Invoke through a constant PowerShell script (spec §15).
- [x] ~~"This window" resolves to the user's active window, never the agent's
      own~~ (spec §13). Walks the process ancestry, stopping before the session
      host so File Explorer is never mistaken for ours.
- [x] ~~**Step 1 — the sidecar skeleton.**~~ A long-lived Python process
      (`packages/core/python/samix_desktop`) speaking NDJSON over stdin/stdout,
      with `DesktopSidecar` as its client. Per-monitor-v2 DPI declared before UI
      Automation loads; COM in a single-threaded apartment; `ping`, `shutdown`,
      `cancel`, `stop`, and a bounded read-only `snapshot`. Lazy spawn, idle
      shutdown, one request in flight, crash-and-respawn to a ceiling of three,
      then degradation. Measured: 0.000% CPU over 300s idle, 41MB RSS, 66ms
      median snapshot of a small window.
- [ ] **Start-up is slower than the ~600ms the design assumed.** Six consecutive
      fresh spawns measured 455/554/670/684/688/898ms — median 684ms — and a
      genuinely cold start, immediately after a build with Defender scanning the
      venv, took **8,981ms**. Comfortably inside the tools' 30–40s timeouts, but
      the first desktop call in a session is something the user will feel, and
      the argument for lazy spawn rests on that cost being small.
      *Options:* trim the `uiautomation` import (it does work at import time we
      do not need), or start the sidecar on the first *window* tool call rather
      than the first desktop one so the cost lands somewhere already slow.
      *Done when:* a cold first call is under two seconds on this machine.
- [x] ~~**Step 2 — port the window tools onto it.**~~ `window.list`,
      `window.focus`, `window.close` and `screen.getActiveWindow` are unchanged
      in name, schema, confirmation and verification behaviour; only the back end
      moved, through the `WindowAutomation` seam. Measured on this machine: a
      repeat `window.list` went from **1,083ms to 3ms** (361x), and
      `screen.getActiveWindow` from 1,053ms to 2ms. `pnpm check:windows` now runs
      both back ends against the real desktop and diffs them field by field.
      Falling back is per call, not latched, so a transient sidecar failure does
      not condemn the session to five-second window queries.
- [x] ~~**Step 3 — `desktop.findElement`, `invoke`, `setValue`.**~~ The
      stale-ref guard refuses an action whose tree hash is stale or missing
      before it reaches the sidecar. Verification is by delta, not by echo:
      `setValue` reads the field back, `invoke` reads the toggle state rather
      than the structure hash, since most invokes (a plain button) never move
      it. The honesty rule holds even here — `pnpm check:desktop` presses a
      button wired to nothing and gets `unverified`, never `verified`.
      `setValue` on a read-only control is refused with `PATTERN_UNAVAILABLE`.
      Confirmed live against the fixture window, not just the unit suite.
- [x] ~~**Step 4 — mouse and keyboard.**~~ `desktop.click`, `desktop.type`,
      `desktop.pressKey` over `SendInput` — the last resort for a control with
      no pattern to call. An element-targeted click reuses `invoke`'s exact
      stale-ref guard and three-signal delta; a raw `(x, y)` click has nothing
      to check against, so `floor:raw-coordinates` confirms it in every mode,
      and `desktop.type`/`desktop.pressKey` report `unverified`
      unconditionally — there is no Value pattern to read back, by
      definition, or the action would have gone through `setValue` instead.
      Movement is interpolated over `cursorMoveMs` (real intermediate
      `WM_MOUSEMOVE` messages, not one teleporting `SetCursorPos` — hover and
      drag targets are computed from those, not the endpoint), and
      `maxActionsPerTask` is enforced in the executor as a hard fail before
      confirmation is even considered, never a prompt.
      Emergency stop now does what `Agent.emergencyStop()`'s comment always
      promised: releases whatever the sidecar is holding, on the reader
      thread, ahead of the cancellation token. The harder case — `stop`
      arriving mid-chord, after a modifier went down but before the tap — is
      closed by one lock in `input.py`'s `InputState` covering the OS call
      *and* the bookkeeping as a single unit on both sides, so a release and a
      press can never interleave with the release landing first.
      Confirmed live: `pnpm check:desktop` toggles a checkbox by screen
      position and gets the same toggle evidence `invoke` does, types into a
      field then continues with no ref into whatever now has focus, and
      drives the action budget to its limit and back off.
      **Deferred, deliberately:** the target overlay. Different kind of work —
      a new transparent always-on-top Tauri window and an event channel
      through `sidecar.rs` — worth doing once the input plumbing above has
      been trusted on its own for a while.
- [ ] **Step 5** — `screen.capture` and vision as a metered fallback (§16, §18).
- [ ] **Step 6** — per-application recipes as declarative YAML data.
- [x] ~~Emergency stop must release synthetic input.~~ See Step 4 above —
      `releaseInputControl` is wired end to end, and the release-ordering race
      it depends on is what that entry's locking note is about.
- [ ] **The equivalence check cannot prove `isOwn` is right, only that both back
      ends agree.** On this machine both report zero own windows, because of the
      ConPTY limitation below, so the one field where a port could do real damage
      is the one field the live diff cannot exercise. The substitution rule
      itself is unit-tested directly (`resolveActive`), but confirming the
      ancestry walk needs a machine where the agent's console *is* in its own
      process tree — a classic `conhost`, or the packaged Tauri build.
- [ ] **`isOwn` cannot see through ConPTY.** Launch the agent from a terminal
      that hosts the shell over ConPTY and the terminal window is in a different
      process tree, so it is indistinguishable from any other application.
      Development-only — a packaged build spawns the sidecar from the Tauri host,
      which *is* the parent. Documented on `WindowInfo.isOwn`; the obvious
      workarounds (matching window titles, or `WindowsTerminal.exe`) would make
      the agent refuse to act on windows that really are the user's.
- [ ] **Windows 11 Notepad is unusable as a live-write fixture.** It is a
      single-instance tabbed Store app, so "launch a Notepad and close it
      afterwards" actually means "add a tab to the user's session, then kill the
      whole application with their unsaved work in it". `pnpm check:desktop`
      builds its own WinForms window instead (`scripts/lib/desktop-fixture.ps1`).
      Step 4's `pnpm dev:desktop` needs the same treatment, or a way to force a
      genuinely new Notepad process.
- [ ] **A browser snapshot returns the browser, not the page.** Chrome exposes
      its own chrome fully — measured at 38 controls including the address bar
      with its current value — but not page content, which stays behind the
      accessibility tree until a screen reader asks for it. That is fine: the
      browser has DOM-first tools from Phase 6. The planner needs to know to
      prefer them rather than snapshotting a browser window and concluding the
      page is empty.

## Phase 8 — WhatsApp

- [ ] Contact resolution with confidence scoring; **never guess** before an
      external action (spec §21, §94).
- [ ] Send verification: confirm the message appears in the conversation.

## Phase 9 — Memory

- [ ] SQLite + Drizzle at the reserved `paths.databaseFile`.
- [ ] Replace `TaskManager`'s in-memory history with persistence.
- [ ] Editable and deletable memories; never store secrets there (spec §24).

## Phase 10 — Developer tools

**Status: `terminal.execute` and the read-only git tools are done and
confirmed live against the real repository, driven by typed natural
language.**

- [x] ~~`terminal.execute` behind `CommandPolicy` (spec §40).~~ Allow-listed
      bare executable names (`git`, `node`, `npm`, `pnpm`, `npx` by default),
      never a path, spawned with `shell: false` and an argv array so there is
      no string for a shell to reinterpret. `permission: 'system'` — the one
      level the permission engine never auto-approves in any mode, so every
      call is confirmed with the literal command and arguments shown first.
      A nonzero exit is reported as data (failing tests are a successful use
      of the tool), never a tool failure; only a genuine execution problem —
      not on the allow list, the executable does not exist, a timeout, the
      working directory doesn't exist — is. Timeout and output-byte cap are
      config-driven (`developer.terminal`) and live-updatable.
      *Not the same list as `app.launch`'s `NEVER_LAUNCHABLE`* — found by
      writing the tests: that set also refuses `node.exe`/`python.exe`,
      which makes sense for launching a bare GUI-style app with no argument
      visibility, but wrongly blocks the exact commands this tool needs to
      allow, since every call here is confirmed with its arguments visible
      before running. `CommandPolicy` has its own floor (`NEVER_ALLOWED`) —
      real shells and standalone system-management binaries (`reg`,
      `diskpart`, `shutdown`, `cipher`, `certutil`, …) — that no config value
      can widen past.
- [x] ~~Git tools.~~ `git.status`, `git.diff`, `git.log`, `git.branch` — spec
      §22/§23's exact list. Dedicated `permission: 'read'` wrappers rather
      than routed through `terminal.execute`, on the same "APIs over pixels"
      reasoning the rest of the tool system uses: each runs one fixed git
      subcommand, so it can be a plain, unconfirmed read instead of a
      `'system'`-tier call. A nonzero exit ("not a git repository" outside
      one) is still `ok()` — git's own honest answer, not a tool error.
- [ ] `project.detect`, `project.open`, `code.search`, `code.read`, `code.edit`
      (spec §23) — the rest of the Developer Mode capability list. Not
      started; `terminal.execute` + `git.*` cover the immediately useful
      subset ("run the tests", "check the build", "show me the last commit").
- [ ] `git.branch` is read-only (`-vv`, listing only). Creating, switching or
      deleting a branch would need its own tool with its own confirmation
      story — deliberately not bundled in here.

## Phase 11 — Vision

- [ ] Screenshot → vision model → **structured observation**, never direct
      action (spec §18).

## Phase 12 — Advanced autonomy

- [ ] Scheduler, long-running tasks, workflows.
- [ ] Local models via Ollama/llama.cpp; offline mode.

---

## Engineering debt to watch

- [ ] `Agent.summarise()` will need rework once plans exceed a handful of steps.
      It now reports verifier observations for up to three steps and falls back
      to a count beyond that, which is a threshold picked by eye.
- [ ] `hedge()` decides whether an unverified sentence already admits doubt with
      a regex over free text. It cannot produce an overclaim — the failure modes
      are a doubled hedge or none added to a sentence that had one — but a
      structured `Verification` field (`observed` / `unconfirmed`) would remove
      the guesswork entirely.
- [ ] `classifyResponse()` is an English word list. It will not recognise
      agreement in any other language, and will silently fall through to the
      planner — which is the safe direction, but it is not multilingual.
- [ ] The PowerShell script in `ui-automation.ts` is a template literal, so a
      backtick silently truncates it. TypeScript catches it today because the
      result does not compile; that is luck rather than design.
- [ ] `EventBus` is synchronous; if a handler ever does real work it will need a
      queue. Keep handlers trivial until then.
- [ ] Log rotation is size-based only; consider age-based retention.
- [ ] No integration test yet across the real stdio transport — the RPC router
      is covered, the pipe is not.
- [ ] Frontend has no component tests (blocked by the same esbuild issue).
