# ADR-0006: Drive the user's own browser over CDP, and treat browsing as a read

- **Status:** Accepted
- **Date:** 2026-08-16
- **Phase:** 6

## Context

Phase 5 shipped `browser.openUrl` and `browser.search` as a `spawn` of
`chrome.exe` with a URL argument. It did the visible thing — a page appeared, in
the user's real browser, with their real session — and its own source defended
the choice: Playwright would drive a separate automation profile, so the user
would watch a *different* browser open, logged out of everything.

That reasoning was sound about profiles and wrong about consequences. Handing a
URL to a process yields **no handle to the page**. Nothing could be scrolled,
clicked, read back or confirmed, so:

- Every browser step ended `unverified` — "Chrome is running and was asked to
  open X; whether the page itself loaded has not been checked." True, and
  useless, and repeated until the user stopped reading it.
- `browser.search` could show results but never return them, so the agent could
  not answer any question whose answer was on the web. Its own description had
  to say so: "it does not return the results to you, so you cannot answer from
  them yourself."

Verification was impossible by construction. ADR-0004 makes honesty structural;
here the structure had nothing to be honest *about*.

## Decision

### 1. Playwright, attached to a real browser over CDP

Launch Chrome with `--remote-debugging-port=9222` and attach with
`chromium.connectOverCDP`. This keeps the profile argument that motivated the
original design — the user's session, cookies and extensions — while producing a
`Page`, which is the thing everything else needed.

`playwright-core`, not `playwright`: we attach to an installed browser and never
download one, so the browser-fetching package would add tens of megabytes to an
installer for a capability we deliberately do not use.

### 2. Three ordered attempts at a profile, and the fallback is reported

Chrome refuses to enable remote debugging when running on its **default**
user-data directory, and forwards a second launch on an already-open profile to
the running instance, silently dropping our flags. Neither is a bug to defeat.
So `BrowserSession` tries, in order:

1. **Attach to whatever is already listening on the port.** The only route that
   reaches the true default profile on a current Chrome.
2. **Launch against the real profile directory.** Works on older Chrome and on
   some Edge builds.
3. **Launch against a persistent SAMIX profile** under the agent's data
   directory. It survives restarts, so a login is a one-time cost.

When it lands on (3) the user is told, in the same sentence that reports the
page. A user who is unexpectedly signed out will otherwise conclude the agent is
broken, and they would be right to.

### 3. Verification observes the browser, not the process

Every navigating tool re-reads `page.url()` and `page.title()` after
`waitForLoadState` settles. Hosts are compared rather than whole URLs: redirects
are the norm — a login wall, a country variant, a tracking parameter — and
treating any of them as failure would report a page the user is looking at as
not having loaded. A redirect to a different host is reported as verified *with
the redirect named*, because "you asked for your dashboard and are looking at a
sign-in page" is the single most useful thing to say.

`browser.search` is stricter: a results page that loads with no readable results
verifies as **unverified**, not verified. The navigation genuinely happened, but
the caller wanted results, and letting the planner answer from results it never
received is exactly the failure ADR-0004 exists to prevent.

### 4. Browsing is READ (spec §31)

The old tools were `external`, so CONTROLLED mode confirmed before every search.
That was wrong on the spec's own terms and worse in practice.

Spec §31 gives EXTERNAL as "send WhatsApp message, send email, upload file, post
online". The common thread is **transmitting the user's data to someone else**.
Opening a page and reading it back is retrieval — the browser equivalent of
`filesystem.read`, which §31 lists under READ. A Google search reveals a query to
Google, which is precisely what the user asked for when they said "search for X".

The practical argument decides it. A prompt in front of every harmless action is
a prompt nobody reads. Training the user to approve reflexively is not a safety
measure but the *destruction* of one: the prompt that matters — "send this file
to Charles" — arrives looking exactly like the forty already waved through.
Confirmation is a scarce resource and must be spent where it changes an outcome.

So `goto`, `search`, `scroll`, `extractText` and `screenshot` are `read` and run
without asking. `click` is `write` with `unknown` reversibility, so CONTROLLED
confirms it: a click is the one action here that can submit a form or send a
message, and nothing in its arguments distinguishes "Next page" from "Place
order". Where the class of action cannot be known, the conservative reading wins.

**The rule for anything added to this namespace: EXTERNAL is for sending, not for
fetching.** `browser.type` and `browser.upload`, when they land, will be
external.

## Consequences

**Gained.** The agent can answer questions about the web. Search returns titles,
links and the site each result came from. A page can be read, scrolled, captured
and clicked, and each of those reports what was actually observed afterwards.
Ordinary browsing no longer interrupts the user.

**Lost.** A dependency — `playwright-core`, ~3 MB, no browser download. A second
Chrome window when the user's own Chrome is already running without a debug port.
And on a current Chrome, the default profile is only reachable if the user starts
the browser themselves with the flag.

**Not lost.** The `http`/`https` allow-list is carried over unchanged in
`parseWebUrl`: `file:` would bypass `PathPolicy` entirely and `javascript:` and
`data:` are script execution in the user's session. This is checked before the
session is touched, so a hostile URL cannot even cause a browser to start.

## Alternatives rejected

**Keep the `spawn` tools alongside Playwright.** Two ways to open a page, with
different verification guarantees and no rule the planner could use to choose
between them. The CDP path is a strict superset once it attaches to a real
browser.

**`chromium.launch()` with Playwright's own browser.** A throwaway profile,
logged out of everything. This is the objection the Phase 5 design got right, and
it still stands.

**Confirm every browser action, as before.** Rejected on the reasoning in §4:
over-confirming does not add safety, it spends it.
