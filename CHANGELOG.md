# Changelog

All notable changes to SAMIX Agent are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Phases 3 through 7 and 10: the agent plans with Google Gemini, acts on the
machine, can now **read the web and the desktop back**, and — new — run its
own project's toolchain, detect and open a project, and search and edit
source code. 2 tools became 43. Phase 10 is now complete against spec §23.

### Added — Phase 10: project and code tools

- **`project.detect`.** Reports every project kind a folder matches — Node,
  Rust, Python, Go, .NET, more than one for a mixed repo — its declared name,
  package manager and `package.json` scripts, and whether it is a git
  repository. Structural only: no name resolution, since nothing maps "my
  SkoolConnect project" to a path yet. Confirmed live against this repo:
  correctly reported Node/pnpm and its own `test` script.
- **`project.open`.** Opens a project folder in an editor (VS Code by
  default) — deliberately the one place that passes an argument to a launched
  application, unlike `app.launch`, because "open my project" means opening
  scoped to that folder, not opening blank. Reuses `app.launch`'s own launch
  and verify helpers rather than duplicating them.
- **`code.search`.** Content search — distinct from `filesystem.search`,
  which finds files by name. Skips dependency and build directories and
  binary files automatically.
- **`code.read`.** Line-numbered file output, optionally bounded to a range —
  what a planner needs to quote exact text at an exact line back to
  `code.edit`, which `filesystem.readTextFile`'s plain blob does not give it.
- **`code.edit`.** The one new tool that writes: replaces one exact, unique
  block of *existing* text with new text, refusing outright if the text is
  missing or appears more than once rather than guessing which occurrence
  was meant — the same contract Claude Code's own edit tool uses. Verified by
  re-reading the file afterwards and comparing a content hash, not by
  trusting the write call not to have thrown. Cannot create a new file.
  Confirmed live end to end: "change the greeting from 'Hello, ' to
  'Hi there, '" read the file, quoted the real text back exactly, asked for
  confirmation, and the file matched exactly afterwards.

### Added — Phase 10: developer tools

- **`terminal.execute`.** One allow-listed development command per call
  (`git`, `node`, `npm`, `pnpm`, `npx` by default) — never a path, no shell,
  spawned as `command, args[]`. `permission: 'system'`, so the permission
  engine confirms every single call, showing the exact command and arguments
  first, in every mode including AUTONOMOUS. A nonzero exit is data, not a
  tool failure: running the tests and finding one fails is the tool doing its
  job.
- **`git.status`, `git.diff`, `git.log`, `git.branch`.** Dedicated read-only
  wrappers rather than routed through `terminal.execute` — each is one fixed
  git subcommand, so it is an unconfirmed read like any other, not a
  `'system'`-tier call. Confirmed live: "what's the git status of \<repo\>,
  and what were the last 3 commits" runs both tools in one plan and reports
  the actual branch and commit hashes.
- **`CommandPolicy`** (`security/command-policy.ts`), a fresh floor rather
  than a reuse of `app.launch`'s `NEVER_LAUNCHABLE`. That set blocks
  `node.exe`/`python.exe`, which is correct for launching a bare GUI-style
  app with no argument visibility and wrong for a tool where every call is
  confirmed with its arguments shown — reusing it made the first live test
  refuse `node --version` outright. `CommandPolicy`'s own floor covers real
  shells (`cmd`, `powershell`, `bash`, `wsl`, …) and standalone
  system-management binaries (`reg`, `diskpart`, `shutdown`, `cipher`,
  `certutil`, …), and no `allowedCommands` configuration can widen past it.
- All five tools are `availableInModes: ['developer']` — not offered to the
  planner at all outside DEVELOPER mode.

### Added — multi-round planning (`Planner.continue`)

- **The agent can now actually finish a task that requires reading a desktop
  control before acting on it.** `plan()` was one blind LLM turn: the model
  committed to concrete tool arguments before anything had run, which made it
  structurally impossible to call `desktop.setValue`, `desktop.invoke` or
  `desktop.click` correctly — their `ref` and `tree` arguments do not exist
  until a `desktop.snapshot` has actually executed and returned them. Driving
  the agent with a real typed instruction against a real window surfaced this
  directly: Gemini called `window.list`, correctly refused to invent a ref it
  did not have, and the orchestrator reported the task done after that one
  read — having typed nothing.
- `Agent.run()` now loops: once a batch of steps all succeed, it goes back to
  the planner with their real results attached (`Planner.continue`, reusing
  the conversation-replay shape `recover()` already had for the failure path)
  and asks whether the task, seen from what actually happened, needs more.
  Bounded independently of the existing per-task step cap by
  `automation.maxContinuationRounds` (default 8), since round count is what
  actually governs LLM round-trips. A planner with no opinion on this (the
  deterministic fallback) leaves every existing single-round task unchanged.
- Confirmed live end to end: "type X into the Message field, then check the
  Remember me box" now runs `window.list` → `desktop.snapshot` →
  `desktop.setValue` + `desktop.invoke`, the last two using the exact ref and
  tree hash the snapshot just returned, each verified against real UI state
  read back afterwards.

### Added — Phase 6: real browser automation

- **Playwright over the DevTools protocol** replaces the previous
  `spawn chrome.exe <url>`. `browser.goto`, `search`, `scroll`, `click`,
  `extractText`, `screenshot`, `close` — seven tools driving one shared page.
- **Verification is now real.** Every action re-reads `page.url()` and
  `page.title()` after `waitForLoadState` settles, so "Done" means the page is
  actually there and a redirect to a login wall is reported rather than hidden.
  The old implementation had no page handle at all, so *every* browser step
  ended `unverified` — honest, but only because nothing could be checked.
- `browser.search` **returns the results** — titles, links and the site each came
  from — instead of only putting them on screen. Google's click-tracking
  redirects are unwrapped where they are decodable, and where they are not
  (the opaque `/goto?url=<blob>` form) the visible site name is read from the
  page, so the planner can still tell official documentation from a content farm.
- Attaches to the user's real Chrome rather than launching a throwaway profile,
  in three ordered attempts: an already-listening debug port, their real profile,
  then a persistent SAMIX profile. Chrome refuses remote control on its default
  profile, so the fallback is sometimes unavoidable — and it is *reported*, not
  hidden, because a user who is unexpectedly signed out deserves to know why.
- Releasing the browser never closes the user's windows or tabs.

### Added — Phase 7 (partial): windows on the desktop

- `window.list`, `window.focus`, `window.close`, `screen.getActiveWindow`, via
  `user32.dll` P/Invoke through a constant PowerShell script. Parameters travel
  in environment variables and are validated integers, so no caller can
  influence a character of what runs.
- **"This window" never means the agent's own.** The agent's window is very often
  the foreground window when an instruction arrives — the user just typed into
  it — so a naive `GetForegroundWindow` would make "close this window" close the
  agent. Resolution walks the process ancestry (stopping before the session
  host, so File Explorer is never mistaken for ours) and falls back to the
  window behind, saying that is what it did.
- Ambiguity is resolved by risk: `window.focus` takes the frontmost match
  because focusing is reversible; `window.close` refuses and returns the
  candidates, because closing is not.

### Added — following up on what the agent offered (spec §80)

- When the agent offers an action it did not take, the **structured tool call**
  is stored, not just the sentence. "Yes", "go ahead" and "do that then" now run
  exactly what was offered, without re-planning — previously they produced a
  request to clarify a suggestion the agent itself had made.
- The yes/no test is deterministic and deliberately narrow: every word must be
  an affirmative or a filler, so "yes, but use Firefox" reaches the planner
  instead of running the stored call. Offers are consumed on use and expire.
- `AgentContext` also tracks what "it", "that" and "this window" point at — the
  last application, window, page and path the agent actually observed.

### Changed — confirmation is spent where it changes an outcome (spec §31)

- Browsing was reclassified from `external` to `read`. Spec §31 gives EXTERNAL
  as sending a message, an email, an upload, a post — the common thread is
  transmitting the user's data. Fetching and reading a page is retrieval, and
  §31 lists reads under READ.
- The practical argument is the stronger one: a prompt before every harmless
  action is a prompt nobody reads. Training the user to approve reflexively is
  not a safety measure but the destruction of one, because the prompt that
  matters arrives looking like the forty already waved through.
- `browser.click` stays behind a confirmation (`write` / `unknown`
  reversibility): nothing in its arguments distinguishes "Next page" from
  "Place order".

### Changed — three verification outcomes, three tones

- `verified` now leads with the **observation** rather than the step description
  — "Done. The page is showing "GitHub" at https://github.com", not "Done. Open
  a web page." The observation is the answer; the step is only the mechanism.
- `not-applicable` (a pure read, whose result *is* the observation) is reported
  plainly, with no confirmation language and no hedge.
- `unverified` states what was seen and then what was not, and can no longer be
  rounded up to "Done" — guaranteed structurally by `hedge()` rather than by
  each verifier remembering to phrase it.
- The honesty guarantee is unchanged and still structural: when any step is
  unverified the language model is never invited to write the summary.

### Added — Phases 4 and 5

**Filesystem (9 tools)**

- `listDirectory`, `search`, `readTextFile`, `getMetadata`, `createDirectory`,
  `copy`, `move`, `rename`, `delete`.
- One shared `guardPath()` every tool calls, so "the path was checked" is a
  property of one function rather than of nine authors remembering.
- Path shorthands (`desktop`, `downloads`, `documents`, …) plus `~` and
  `%VAR%` expansion, so the planner looks a path up instead of inventing one.
- The first verifiers that re-observe real state: a copy is confirmed by
  stat-ing the destination and comparing its size to the source; a move checks
  both that the file arrived *and* that it left, because the half-state is the
  dangerous one.
- `delete` is `destructive` + `irreversible`, names the exact path in its
  confirmation prompt, and states that it does not use the Recycle Bin.

**Applications and processes (4 tools)**

- `app.list`, `app.launch`, `app.close`, `process.list`.
- Application discovery: a curated table probed at documented install
  locations, plus a depth-limited scan of the install roots filtered by
  a "is this the program's main binary?" heuristic.
- `app.launch` takes a **name**, never a path, resolved against discovery — an
  arbitrary-executable primitive would be exactly the escape hatch spec §40
  forbids. `NEVER_LAUNCHABLE` additionally refuses shells, interpreters and
  living-off-the-land binaries (`certutil`, `regsvr32`, `rundll32`) even when
  discovery finds them.
- `app.close` uses `taskkill` **without** `/F`: an application with unsaved work
  shows its save prompt and stays open, and the verifier reports that honestly
  rather than the agent forcing it.
- The only two native binaries the agent invokes are `tasklist` and `taskkill`,
  resolved to absolute `System32` paths (never via `PATH`), with `shell: false`
  and a strict pattern on the one caller-influenced argument.

**Browser (2 tools)** — superseded by the Playwright subsystem above.

- `browser.openUrl` and `browser.search` opened a page by handing a URL to
  `chrome.exe`. Kept the user's real session, but produced no page handle, so
  nothing could be read, scrolled or confirmed.
- `http`/`https` only. `file:` would bypass `PathPolicy` entirely; `javascript:`
  and `data:` are script execution in the user's session. **This boundary
  survives unchanged** in `parseWebUrl`.

### Fixed — found by the tests written for this work

- **`filesystem.search` returned blocked files.** `isBlocked` was checked on
  directories only, but deny patterns are usually written against the file
  (`**/.ssh/**`, `**/*.key`) and match no directory — so pruning the walk left
  the files themselves reachable. A test expecting an empty result got an SSH
  private key. Both `search` and `listDirectory` now check every entry.
- `AppRegistry.suggestions()` returned each application twice.
- The Program Files scan listed `ffmpeg`, `git-receive-pack` and
  `gpgme-w32spawn` as openable applications, burying Chrome.

### Fixed — found by running the Phase 6/7 work against the real machine

- **`browser.search` read the results page before the results arrived.** Search
  engines redirect once before serving results, and both `domcontentloaded` and
  `load` fire on the intermediate document. Every search returned zero results
  against a live Google. Now waits for the result selector, in the `attached`
  state rather than `visible` — in Europe the results render behind a cookie
  consent overlay, and waiting for visibility would time out on a page that has
  the answer on it.
- **A tracking redirect could be turned into a plausible URL for a site that
  does not exist.** `parseWebUrl` reads a bare word as a hostname, which is
  right for something a person typed; applied to Google's opaque
  `?url=CAESaAHuR6pN…` parameter it produced `https://caesaahur6pn…/`.
  Recovery now requires an already-absolute URL.
- **The agent's own console was not recognised as its own.** The ancestry check
  looked only at the parent process, but the window a user sees the agent
  inside is several levels up (`node → shell → OpenConsole → Terminal`). Found
  by `pnpm check:windows` against the real desktop, where the unit tests —
  which use a fabricated desktop — could not see it. Now walks the full chain,
  stopping before the session host so File Explorer is never claimed as ours.
  The remaining ConPTY case is documented on `WindowInfo.isOwn` rather than
  worked around, because the available workarounds would make the agent refuse
  to act on windows that really are the user's.

### Added — Phase 3: the LLM engine

The agent plans with Google Gemini and answers in its own words; the
deterministic Phase 1 planner remains as the no-key fallback.

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
