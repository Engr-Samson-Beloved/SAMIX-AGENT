# SAMIX Agent — Handbook

A fast, plain-language guide to running SAMIX Agent and talking to it. For
architecture, internals and the full tool-by-tool detail, see
[`USING-SAMIX.md`](./USING-SAMIX.md) and the root [`README.md`](../README.md) —
this document is the quick version.

---

## 1. What this is

SAMIX Agent is a local Windows program you give plain-English instructions to.
It doesn't just describe what you should do — it opens the app, finds the
file, clicks the button, types into the field, and then **checks that it
actually happened** before telling you it's done.

Today you talk to it by typing, in a console window. Voice is planned but not
built yet.

---

## 2. Before you start

You need:

- Windows 10 or 11
- [Node.js](https://nodejs.org) 20 or newer, and [pnpm](https://pnpm.io) (`npm i -g pnpm`)
- (Optional but recommended) a free [Google AI Studio API key](https://aistudio.google.com/apikey) —
  this is what lets it understand free-form sentences instead of a fixed list
  of commands.

## 3. Running it

Once, from the project folder:

```powershell
cd C:\SAMIX-AI
pnpm install
```

Then create a file named `.env` in that same folder with your key in it:

```
GEMINI_API_KEY=AIza...
```

From then on, every time you want to use the agent:

```powershell
pnpm repl
```

Wait for the `samix>` prompt — that's it talking to you.

> **No API key yet?** It still starts. It just falls back to recognising a
> small set of fixed phrases ("what's my status", "what OS am I on") instead
> of understanding anything you type.

---

## 4. What you can say

Type like you're talking to a capable assistant, not a command line. A few
examples, grouped by what they touch — all of these work today:

**Your computer**
> "What OS and CPU is this computer running?"
> "What's using memory right now?"

**Files** — say `desktop`, `downloads`, `documents`, `pictures` or `home`
instead of typing a full path
> "Find my 3 most recently modified PDFs in Downloads"
> "Copy that to my Desktop"
> "Make a folder called Invoices"

**Applications**
> "Open Chrome"
> "Close Notepad"

**The web** — it reads a real Chrome page back to you rather than guessing
> "Search for the weather in Lagos"
> "What does that page actually say?"

**Windows on your screen**
> "What am I looking at right now?"
> "Bring Excel to the front"

**Controls inside a window** — buttons, checkboxes, text fields
> "Type 'Hello' into the Message field"
> "Check the Remember me box"
> "Click Send"

Before it touches a control, it quietly reads the window to see what's
actually there — it never guesses at a button that might not exist.

**It remembers what you just said, within the conversation**
> Agent: "Chrome isn't open. Want me to open it?"
> You: "yes" — runs exactly what was offered, no re-explaining.

---

## 5. How careful is it?

Four modes control how much it asks before acting:

| Mode | What it means |
| --- | --- |
| **Safe** | Looks, never touches anything |
| **Controlled** *(default)* | Does easy, reversible things on its own; asks first before anything risky or permanent |
| **Autonomous** | Does more without asking; still always asks before anything that reaches someone else or can't be undone |
| **Developer** | Same caution as Controlled, plus unlocks developer-only tools |

Change it any time: `/mode safe` (or `controlled`, `autonomous`, `developer`)

Regardless of mode, it **always** asks first before:
- deleting anything (permanently — there's no recycle bin here)
- sending or sharing something with anyone else
- closing a window that might have unsaved work in it

You always see exactly what it's about to do, and why, before it happens.

## 6. Does it actually check its work?

Yes — this is the core idea of the whole thing. It never just says "Done."
It looks again afterwards: did the file really land there? Is the box really
checked now? Is the page really showing what it should?

| If it says... | It means |
| --- | --- |
| **"Done. \[fact\]."** | It re-checked, and confirmed it really happened |
| a plain answer, no "Done" | It only read something — nothing to confirm, the answer *is* the result |
| **"...but I couldn't confirm..."** | It ran the action, but couldn't verify the result — told to you honestly |
| a reported failure | Its own check disagreed with what the action claimed — the check wins |

It is built so a language model can never talk its way into claiming success
for something that wasn't actually confirmed.

---

## 7. Quick command reference

Type any of these directly at the `samix>` prompt:

| Type | Does |
| --- | --- |
| *(any sentence)* | Gives it an instruction |
| `/status` | Shows its current mode and what's working |
| `/tools` | Lists everything it can currently do |
| `/history` | Shows recent tasks |
| `/mode <name>` | Changes how cautious it is |
| `/logs [n]` | Shows the last n log lines (default 20) |
| `/cancel` | Stops the task currently running |
| `/stop` | Emergency stop — everything, immediately |
| `/help` | Full command list |
| `/quit` | Exits |

---

## 8. What it can't do yet

Being upfront about the gaps:

- **No voice.** Typing only, for now.
- **Can't fill in web forms yet** — it can read, scroll and click a page, but
  not type into one.
- **No WhatsApp or messaging.**
- **No memory across restarts.** It follows the current conversation, so
  "yes, do that" and "close it" work while you're talking to it — but nothing
  is remembered once you quit.
- **No shell commands or scripts.** Deliberately blocked for safety — there's
  no way to ask it to run an arbitrary command.

---

## 9. If something goes wrong

- **It says `llm: unavailable` in `/status`** — no API key was found. Check
  your `.env` file is in the project root and correctly named.
- **`pnpm tauri dev` hangs with no output** — a corrupted download, not
  something you did wrong. Fix with:
  ```powershell
  pnpm store prune
  pnpm install --force
  ```
- **Anything else** — run `/logs 50` inside the REPL to see what actually
  happened.

---

## 10. Going further

This handbook covers everyday use. For the full technical picture —
architecture, every tool and its exact permission level, the safety design
in depth — read [`docs/USING-SAMIX.md`](./USING-SAMIX.md) and the root
[`README.md`](../README.md).
