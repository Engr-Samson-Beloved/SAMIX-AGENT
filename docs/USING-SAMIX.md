# Using SAMIX Agent

Everything here has been run on this machine. Where something does not work yet,
it says so rather than describing an intention.

---

## 1. Setup

```powershell
cd C:\SAMIX-AI
pnpm install
pnpm build:packages
```

Put a [Google AI Studio key](https://aistudio.google.com/apikey) in `.env`:

```
GEMINI_API_KEY=AIza...
```

`.env` is gitignored, and the only thing that reads it refuses to activate under
`NODE_ENV=production`, so a packaged build cannot pick it up by accident.

Without a key the agent still starts — it falls back to a deterministic planner,
handles a few fixed phrasings, and reports `llm: unavailable`.

---

## 2. Running it

```powershell
pnpm repl                                  # this is the way in today
pnpm repl -- --data-dir C:\Temp\scratch    # throwaway data dir while experimenting
```

The REPL spawns the compiled core exactly as the desktop host does. It is the
full agent — same planner, permissions, verification and audit trail. Only the
window is missing.

```
samix> what operating system am I running?
samix> find my three most recent PDFs
samix> open Chrome and search for the weather in Lagos
```

| Command | |
| --- | --- |
| `/status` `/tools` `/history` `/logs [n]` | what it is and what it did |
| `/mode safe\|controlled\|autonomous\|developer` | change how much it asks |
| `/cancel` `/stop` `/quit` | stop the task, stop everything, exit |

Add `--verbose` for the core's own logs.

```powershell
pnpm tauri dev            # the desktop window
```

**If `vite` hangs and never prints anything**, esbuild's binary is corrupt. This
happened on the development machine and was misdiagnosed for a long time as a
Defender problem; it is not, and no exclusion fixes it. Check it directly:

```powershell
node_modules\.pnpm\@esbuild+win32-x64@*\node_modules\@esbuild\win32-x64\esbuild.exe --version
```

A healthy binary prints its version instantly and is about **11.7 MB**. The
broken one here was **533 KB**, was a 32-bit x86 image in a package that should
hold a 64-bit one, and hung forever with no output. All three Windows esbuild
packages held the *same* wrong file, which is how you can tell it was corruption
rather than a platform mismatch. Repair it with:

```powershell
pnpm store prune
pnpm install --force
```

---

## 3. What it can do

26 tools. **⚠ = asks before it acts.**

| Ask for | Tools |
| --- | --- |
| **Machine** — *"what OS am I on?"*, *"what's using memory?"* | `system.getInfo` `agent.getStatus` `process.list` |
| **Files** — *"find my latest PDF"*, *"copy that to my Desktop"* | `filesystem.` `listDirectory` `search` `readTextFile` `getMetadata` `createDirectory` `copy` `move` `rename` `delete`⚠ |
| **Apps** — *"open Chrome"*, *"close Notepad"* | `app.list` `app.launch` `app.close`⚠ |
| **Web** — *"search for X"*, *"what does that page say?"* | `browser.` `goto` `search` `scroll` `click`⚠ `extractText` `screenshot` `close` |
| **Windows** — *"what am I looking at?"*, *"bring Excel forward"* | `window.list` `window.focus` `window.close`⚠ `screen.getActiveWindow` |

**Files.** Say `desktop`, `downloads`, `documents`, `pictures`, `music`, `videos`
or `home` instead of a full path. `~` and `%APPDATA%` expand too.

**Web.** Drives a real Chrome over the DevTools protocol, so it can *read* a page,
not just open one. It reports the address the page actually settled on, so a
redirect to a login wall is visible rather than reported as success.

**Which profile you get, and why you may be signed out.** Chrome 136 and later
refuse `--remote-debugging-port` outright whenever the profile is the default
one. This is a deliberate hardening change, and there is no flag that undoes it.
So the browser you are normally signed into **cannot be driven**, by this agent
or any other, and the workarounds that claim otherwise work by copying your
cookie and login databases — which this project refuses to do, and which its own
blocked-path rules forbid.

What happens instead: the agent keeps its own persistent Chrome profile under
`%APPDATA%\SamixAgent\cache\browser-profile`. **Sign in there once and it stays
signed in.** Until you do, searches run logged out, which is why Google
occasionally shows a CAPTCHA.

"Open Chrome" is different — that launches your ordinary Chrome, because nothing
needs to drive it. So the browser you asked for and the browser the agent
searches in are genuinely two different windows. The agent now says so; it used
to attach to its own leftover browser, report it as yours, and stay quiet.

**Windows.** *"This window"* means the front window on **your** desktop, never the
agent's own console — if the agent's window has focus, the one behind it is used
and it says so. Ambiguity is handled by risk: *"focus the Chrome window"* with two
open takes the frontmost; *"close the Chrome window"* refuses and asks which.

These used to take several seconds each, because every call started a PowerShell
process to reach `user32.dll`. They now go through a long-lived UI Automation
sidecar: measured on this machine, a repeat `window.list` went from **1,083 ms to
3 ms**. If the sidecar can't start, the PowerShell path answers instead and
`/status` says which one you're on — nothing breaks, it just gets slow again.

---

## 4. What it cannot do yet

- **Voice.** Phase 2. No microphone, no speech.
- **Typing into a page**, uploading, downloading. It reads, scrolls and clicks.
- **Anything on screen outside a browser** — no clicking, keyboard, mouse or
  desktop screenshots. Windows can be listed, focused and closed; the controls
  inside them cannot be driven. Rest of Phase 7.
- **WhatsApp or any messaging.** Phase 8.
- **Memory across restarts.** It follows the last six exchanges and what it just
  acted on, so *"yes, do that"* and *"close it"* work within a session. Nothing
  survives a restart. Phase 9.
- **Running commands or scripts.** Deliberately gated — there is no shell tool,
  and `app.launch` refuses `cmd`, `powershell`, `wscript`, `certutil` and similar.
- **Creating a file with content.** Copy, move, rename and delete exist.

---

## 5. Safety

The part worth reading before you let it near real files.

| Mode | Behaviour |
| --- | --- |
| `safe` | reads only — every write, launch or search is refused |
| `controlled` **(default)** | reads and reversible writes run; irreversible, external and destructive ask first |
| `autonomous` | writes run without asking; external and destructive still ask |
| `developer` | same confirmations as controlled, plus dev-gated tools |

**Confirmation prompts** show what will happen, why, and the real arguments:

```
CONFIRMATION REQUIRED (destructive)
  Close the Invoices window. Any unsaved work in it may be lost.
  title: Invoices
  reply y =approve, a =approve rest, n =decline
```

**You'll be asked less than you expect, on purpose.** Searching, opening, reading
and scrolling are reads — they transmit nothing you didn't ask to send.
Confirmation is reserved for what reaches other people or can't be undone. A
prompt on every harmless action is a prompt nobody reads, and then the one that
matters looks exactly like the forty already waved through.

**Writes stay inside trusted folders** — Desktop, Documents, Downloads by
default (`security.trustedFolders`). Elsewhere it can read but not modify.
**Blocked paths beat trusted folders**: `.ssh`, `*.key`, `C:\Windows` and similar
are refused even inside one, and hidden from search and listings entirely.

**Deletes are permanent** — no Recycle Bin. Always confirmed, and the prompt names
the exact path.

**Emergency stop:** `/stop`, or `Ctrl+Shift+Space` once the desktop shell runs.

### The honesty rule

Every action that changes something is re-checked by re-observing the world — a
copy is confirmed by stat-ing the destination against the source; a page load by
reading the address back out of the browser.

| Outcome | Means | Sounds like |
| --- | --- | --- |
| **verified** | re-checked, and it happened | *"Done. The page is showing "GitHub" at github.com."* |
| **not applicable** | a pure read — the answer *is* the observation | the result, stated plainly |
| **unverified** | it ran; the check couldn't settle it | *"Brought Excel forward — the front window is now something else, so it may not have taken focus."* |
| **failed** | the verifier disagreed with the tool. The verifier wins | reported as a failure |

When anything is unverified, the language model is **not even asked** to write the
summary — enforced in `Agent.report()`, not by prompting. But a verified result is
allowed to sound like one: hedging work that plainly happened teaches you to
ignore the hedge.

**Follow-ups.** When it offers something — *"Chrome isn't running. Shall I open
it?"* — it keeps the actual tool call. *"Yes"* runs exactly what was offered.
Anything with new content in it (*"yes, but use Firefox"*) goes back to the
planner. Offers expire after ten minutes.

---

## 6. Files and checks

```
%APPDATA%\SamixAgent\
├── config.json       modes, trusted folders, models
├── logs\samix.log    diagnostics, rotated, secrets redacted
└── logs\audit.log    every tool run, including blocked and declined ones
```

```powershell
pnpm verify          # typecheck, lint, 352 tests, stdio smoke test
pnpm check:gemini    # are the pinned models still available?
pnpm check:llm       # live end-to-end against the Gemini API
pnpm dev:browser     # drives a real Chrome — opens a window
pnpm check:windows   # read-only; enumerates your actual desktop
pnpm check:desktop   # read-only; opens one window of its own, then closes it
```

The last three run against the real machine on purpose, and each caught a defect
the unit suite could not: a search that read the results page before the results
arrived, an agent that didn't recognise its own console, and a coordinate bug
that silently discarded every control in a window.

`pnpm check:desktop` needs a Python environment built once with
`pnpm setup:desktop`. It is groundwork for the rest of Phase 7 and changes
nothing you can ask the agent to do yet (see §4); skipping it breaks nothing.

Run `pnpm check:gemini` periodically regardless — Google retires models without
warning, and the pinned ones are verified rather than assumed.
