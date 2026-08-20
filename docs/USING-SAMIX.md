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

26 tools, in six namespaces.

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
| "Search for the weather in Lagos" | `browser.search` |
| "Open github.com" | `browser.goto` |
| "What does that page say?" | `browser.extractText` |
| "Scroll down" | `browser.scroll` |
| "Click Sign in" | `browser.click` — **asks first** |
| "Show me what it looks like" | `browser.screenshot` |
| "Close that tab" | `browser.close` |

These drive a real Chrome (or Edge/Brave) over the DevTools protocol, so the
agent can now **read** a page, not just show you one: `browser.search` returns
the result titles and links, and `browser.extractText` returns the text of
whatever is open. It reports the address and title the page actually settled on,
so a redirect to a login wall is visible rather than silently reported as
success.

Only `browser.click` asks first, because a click is the one action here that can
submit a form or send something. Fetching and reading are not confirmed at all —
see §5.

**Which profile you get.** Chrome refuses to enable remote control on its default
profile, and a second launch on a profile that is already open just hands off to
the running window. So the agent tries three things in order: attach to a browser
already listening on port 9222; launch on your real profile; fall back to a
profile of its own under `%APPDATA%\SamixAgent\cache\browser-profile`. If it
lands on the last one it says so — you will be signed out of everything until you
sign in once, and that profile then remembers you.

To get your real profile, start Chrome yourself with:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

### Windows on your desktop

| Say | Tool |
| --- | --- |
| "What am I looking at?" | `screen.getActiveWindow` |
| "What have I got open?" | `window.list` |
| "Bring Excel to the front" | `window.focus` |
| "Close this window" | `window.close` — **asks first** |

"This window" means the window in front on *your* desktop, never the agent's own
console — if the agent's window is in focus, the one behind it is used and the
agent says that is what it did. Ambiguity is handled by risk: "focus the Chrome
window" with two open takes the frontmost, "close the Chrome window" with two
open refuses and asks which.

These are noticeably slower than the other tools — several seconds each —
because each call starts a PowerShell process to reach `user32.dll`. That is
measured and explained at the top of `tools/windows/ui-automation.ts`.

---

## 4. What it cannot do yet

Stated plainly, because the agent will tell you the same thing if you ask it to:

- **Voice.** Phase 2. No microphone, no speech.
- **Filling in forms, typing into a page, uploading, downloading.** The browser
  can read, scroll and click; it cannot yet type. Rest of Phase 6.
- **Clicking things on screen outside a browser, keyboard/mouse control,
  screenshots of the desktop.** Windows can be listed, focused and closed;
  controls inside them cannot be driven. Rest of Phase 7.
- **WhatsApp or any messaging.** Phase 8.
- **Remembering across restarts.** The agent follows the last six exchanges and
  remembers what it just acted on, so "yes, do that", "close it" and "this
  window" work within a session. Nothing survives a restart, and it is dialogue
  memory rather than a record of machine state — Phase 9.
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
CONFIRMATION REQUIRED (destructive)
  Close the Invoices window. Any unsaved work in it may be lost.
  DESTRUCTIVE actions require your confirmation.
  title: Invoices
  reply y =approve, a =approve rest, n =decline
```

**You will be asked less than you might expect, on purpose.** Searching the web,
opening a page, reading one, scrolling and taking a screenshot all run without a
prompt. They are reads: they fetch and observe, and transmit nothing you did not
ask to send. Confirmation is reserved for actions that reach other people or
cannot be undone — clicking (which may submit a form), closing a window,
deleting a file. A prompt in front of every harmless action is a prompt nobody
reads, and that costs more than it buys: the one that matters would arrive
looking exactly like the forty already waved through.

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
stat-ing the destination and comparing its size to the source; a page load is
confirmed by reading the address and title back out of the browser. Three
outcomes, and each gets its own tone:

| Outcome | Means | Sounds like |
| --- | --- | --- |
| **verified** | re-checked, and it happened | *"Done. The page is showing "GitHub" at https://github.com."* |
| **not applicable** | a pure read — the answer *is* the observation, so there is nothing to confirm | the result, stated plainly, with no hedging |
| **unverified** | it ran, and the check could not settle it | *"Brought Excel forward — the window in front is now something else, so it may not have taken focus."* |
| **failed** | the verifier disagreed with the tool. The verifier wins | reported as a failure |

The distinction matters in both directions. An unverified result never says
"Done", and when anything is unverified the language model is **not even asked**
to write the summary — enforced in `Agent.report()`, not by prompting. But a
verified result is allowed to sound like one: hedging work that plainly happened
teaches you to ignore the hedge, which destroys the warning exactly when it is
needed.

**Following up.** When the agent offers something it did not do — *"Chrome isn't
running. Shall I open it?"* — it keeps the actual tool call, not just the
sentence. Say "yes", "go ahead" or "do that then" and it runs precisely what was
offered, without re-planning it. Say anything with new content in it ("yes, but
use Firefox") and it goes back to the planner instead, so what you actually said
is what happens. Offers expire after ten minutes.

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
pnpm verify          # typecheck, lint, 331 tests, stdio smoke test
pnpm check:llm       # live end-to-end against the Gemini API
pnpm check:gemini    # re-confirm model availability before a release
pnpm dev:browser     # drives a real Chrome through every browser tool
pnpm check:windows   # read-only; enumerates your actual desktop
pnpm check:desktop   # read-only; reads the controls inside one window
```

The last three run against the real machine on purpose. `pnpm dev:browser` will
open a browser window; `pnpm check:windows` changes nothing at all;
`pnpm check:desktop` opens one small window of its own and closes it again. All
of them caught defects the unit suite could not — a search that read the results
page before the results arrived, an agent that did not recognise its own
console, and a screen-coordinate bug that silently discarded every control in a
window (see below).

`pnpm check:desktop` needs a Python environment that does not exist until you
build it:

```powershell
pnpm setup:desktop        # one-time; creates packages/core/python/.venv
pnpm check:desktop --idle 300
```

This is groundwork for the rest of Phase 7 and changes nothing you can ask the
agent to do yet — see §4. If you never run it, nothing breaks: the window tools
keep using the PowerShell path they use today.

Run `pnpm check:gemini` periodically regardless — Google retires models without
warning, and the pinned ones are verified rather than assumed.
