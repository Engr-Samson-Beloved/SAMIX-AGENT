# Launching and using SAMIX Agent

Everything here has been run on this machine. Where something does not work yet,
it says so rather than describing an intention.

---

## 1. One-time setup

```powershell
cd C:\SAMIX-AI
pnpm install
pnpm build:packages
```

Then put a Google AI Studio key in `C:\SAMIX-AI\.env`:

```
GEMINI_API_KEY=AIza...
```

Get one at <https://aistudio.google.com/apikey>. `.env` is gitignored, and the
only thing that reads it (`DevEnvSecretStore`) refuses to activate when
`NODE_ENV=production`, so a packaged build cannot pick it up by accident.

Check it worked:

```powershell
pnpm check:gemini     # is the key valid, and which models can it call?
pnpm check:llm        # drive real instructions through the whole agent loop
```

Without a key the agent still starts. It falls back to the deterministic Phase 1
planner, handles a handful of fixed phrasings, and reports `llm: unavailable`.

---

## 2. Launching it

### The REPL — what to use today

```powershell
pnpm repl
```

This spawns the compiled agent core exactly as the desktop host does — a child
process speaking NDJSON over stdin/stdout — and gives you a prompt. It is the
full agent: same planner, same permission engine, same verification, same audit
trail. Only the window is missing.

```
samix> what operating system am I running?
samix> find my three most recent PDFs
samix> open Chrome and search for the weather in Lagos
```

Commands, all prefixed with `/`:

| Command | Does |
| --- | --- |
| `/status` | agent state, mode, subsystem readiness |
| `/tools` | tools available in the current mode |
| `/mode <name>` | `safe`, `controlled`, `autonomous`, `developer` |
| `/history` | recent tasks |
| `/logs [n]` | last n log entries |
| `/cancel` | cancel the running task |
| `/stop` | emergency stop |
| `/quit` | shut down cleanly |

Add `--verbose` to see the core's own logs interleaved.

Use a throwaway data directory while experimenting:

```powershell
pnpm repl -- --data-dir C:\Temp\samix-scratch
```

### The desktop window — blocked on this machine

```powershell
pnpm tauri dev
```

This does not currently run here. `vite build` and `vite dev` hang because
esbuild's binary never produces output on this machine — diagnosed in
`docs/PHASE-1-REPORT.md`, and it is an environment problem rather than a code
defect. The usual fix is a Defender exclusion, which needs an **elevated**
PowerShell:

```powershell
Add-MpPreference -ExclusionPath 'C:\SAMIX-AI'
```

Until that is done, the REPL is the way in. Nothing about the agent itself is
missing from it.

---

## 3. What it can actually do

17 tools, in four namespaces.

### Answering questions about the machine

| Say | Tool |
| --- | --- |
| "What OS and CPU am I running?" | `system.getInfo` |
| "What mode are you in and what can you do?" | `agent.getStatus` |
| "What's using the most memory?" | `process.list` |

### Files

| Say | Tool |
| --- | --- |
| "What's in my Downloads folder?" | `filesystem.listDirectory` |
| "Find my latest PDF" | `filesystem.search` |
| "What's in notes.txt?" | `filesystem.readTextFile` |
| "How big is that file?" | `filesystem.getMetadata` |
| "Make a folder called Invoices on my Desktop" | `filesystem.createDirectory` |
| "Copy the report to my Desktop" | `filesystem.copy` |
| "Move these into Archive" | `filesystem.move` |
| "Rename it to final.docx" | `filesystem.rename` |
| "Delete that file" | `filesystem.delete` — **asks first, always** |

You can say `desktop`, `downloads`, `documents`, `pictures`, `music`, `videos`
or `home` instead of a full path. `~` and `%APPDATA%` are expanded too.

### Applications

| Say | Tool |
| --- | --- |
| "What can I open?" | `app.list` |
| "Open Chrome" / "Open VS Code" | `app.launch` |
| "Close Notepad" | `app.close` — **asks first** |

### The web

| Say | Tool |
| --- | --- |
| "Search for the weather in Lagos" | `browser.search` — **asks first** |
| "Open github.com" | `browser.openUrl` — **asks first** |

These open a page in your real browser, with your real session. They do **not**
read the page back, so the agent cannot answer questions *about* a web page.
That needs Playwright and is Phase 6.

---

## 4. What it cannot do yet

Stated plainly, because the agent will tell you the same thing if you ask it to:

- **Voice.** Phase 2. No microphone, no speech.
- **Reading web pages, clicking, filling forms.** Phase 6.
- **Clicking things on screen, keyboard/mouse control, screenshots.** Phase 7.
- **WhatsApp or any messaging.** Phase 8.
- **Remembering across restarts.** The agent follows the last six exchanges, so
  "yes, do that", "close it" and "the other one" work within a session. Nothing
  survives a restart, and it is dialogue memory rather than a record of machine
  state — Phase 9.
- **Running commands or scripts.** Phase 10, and deliberately gated: there is no
  shell tool, and `app.launch` refuses `cmd`, `powershell`, `wscript`,
  `certutil` and similar outright.
- **Writing files.** Copy, move, rename and delete exist; creating a file with
  content does not.

---

## 5. Safety — what will stop you

This is the part worth reading before you let it near real files.

**Four modes.** `/mode safe|controlled|autonomous|developer`. It starts in
`controlled`, which is the sensible default.

| Mode | Behaviour |
| --- | --- |
| `safe` | reads only — every write, launch or search is refused outright |
| `controlled` | reads and reversible writes run; irreversible, external and destructive actions ask first |
| `autonomous` | writes run without asking; external and destructive still ask |
| `developer` | same confirmations as controlled, plus dev-gated tools |

**Confirmation prompts.** When an action needs approval the REPL shows what will
happen, why, and the concrete arguments:

```
CONFIRMATION REQUIRED (external)
  Search google for "weather in Lagos".
  External actions always require confirmation in this mode.
  query: weather in Lagos
  reply y =approve, a =approve rest, n =decline
```

**Trusted folders.** Writes only happen inside them — Desktop, Documents,
Downloads by default. Anywhere else the agent can read but not modify, and it
says so. Change them in `config.json` under `security.trustedFolders`.

**Blocked paths beat trusted folders.** `.ssh` keys, `*.key`, `C:\Windows` and
similar are refused even inside a trusted folder, and they are hidden from
search and directory listings rather than merely being unreadable.

**Deletes are permanent.** `filesystem.delete` does not use the Recycle Bin. It
is `destructive` + `irreversible`, so it always asks, and the prompt names the
exact path.

**Emergency stop.** `/stop` in the REPL, `Ctrl+Shift+Space` globally once the
desktop shell runs.

**Verification, and the honesty rule.** Every action that changes something is
re-checked afterwards by re-observing the world — a copy is confirmed by
stat-ing the destination and comparing its size to the source. Three outcomes,
kept distinct:

- **verified** — checked, and it happened.
- **failed** — the verifier disagreed with the tool. The verifier wins.
- **unverified** — it could not be checked. You will see
  *"I completed 1 step, but could not confirm it. I have not assumed that
  succeeded."*

That last one is not a bug. Opening a web page reports `unverified` on purpose:
we can confirm the browser is running, not that the page loaded, and the agent
is not permitted to claim the stronger thing. When anything is unverified the
language model is **not even asked** to write the summary — that is enforced in
`Agent.report()`, not by prompting.

---

## 6. Where things are

```
%APPDATA%\SamixAgent\
├── config.json          settings — modes, trusted folders, models
├── logs\samix.log       diagnostics, NDJSON, rotated, secrets redacted
└── logs\audit.log       every tool run, including blocked and declined ones
```

`/logs 40` tails the first from inside the REPL.

---

## 7. Checking it still works

```powershell
pnpm verify         # typecheck, lint, 227 tests, stdio smoke test
pnpm check:llm      # live end-to-end against the Gemini API
pnpm check:gemini   # re-confirm model availability before a release
```

Run `pnpm check:gemini` periodically regardless — Google retires models without
warning, and the pinned ones are verified rather than assumed.
