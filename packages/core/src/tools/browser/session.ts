import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { AppRegistry, DiscoveredApp } from '../apps/app-registry.js';

/**
 * A live, inspectable browser (spec §19) — Phase 6.
 *
 * ## What changed, and why it mattered
 *
 * The previous implementation spawned `chrome.exe <url>` and stopped. It worked,
 * in the narrow sense that a window appeared, but it produced **no handle to the
 * page**: nothing could be scrolled, clicked, read back or confirmed. Every
 * browser step therefore ended as `unverified` — "Chrome is running and was
 * asked to open X; whether the page loaded has not been checked" — which is an
 * honest sentence that no user should have to keep reading. Verification was
 * impossible by construction, so honesty had nowhere to go but a shrug.
 *
 * Driving the page over the DevTools protocol makes the observation real:
 * `page.url()` and `page.title()` are read from the browser after the load
 * settles, so "Done" means the page is actually there.
 *
 * ## Why CDP rather than Playwright's own browser
 *
 * `chromium.launch()` starts a throwaway profile. The user would watch a
 * *different* Chrome open, logged out of everything, which is useless for
 * anything behind a login and disconcerting for everything else. Attaching to a
 * real Chrome over `--remote-debugging-port` keeps their profile, their session
 * cookies and their extensions.
 *
 * ## The profile problem, stated honestly
 *
 * Chrome refuses to enable remote debugging when it is running on its **default**
 * user-data directory — a deliberate hardening change, not a bug to work around.
 * Chrome also forwards a second launch on the same profile to the instance that
 * is already running, which silently drops our flags. So there are three cases,
 * tried in this order:
 *
 *   1. **Something is already listening on the port.** Someone (often the user,
 *      sometimes an earlier run of this agent) started Chrome with debugging on.
 *      Attach. This is the only route that can reach the true default profile on
 *      a current Chrome.
 *   2. **Launch against the real profile directory.** Works on older Chrome and
 *      on Edge builds that still permit it.
 *   3. **Launch against a dedicated SAMIX profile** kept under the agent's data
 *      directory. It is persistent, so a login survives between sessions — but
 *      it starts empty, and the user is told which profile they are looking at
 *      rather than left to wonder why they are signed out.
 *
 * The fallback is reported, never hidden. `profile` on {@link SessionStatus} is
 * what the tools quote when they say where a page was opened.
 */

export const DEFAULT_DEBUG_PORT = 9222;

/** Browsers that speak the DevTools protocol. Firefox does not. */
const CDP_CAPABLE: ReadonlySet<string> = new Set(['chrome', 'edge', 'brave', 'chromium', 'vivaldi', 'opera']);

/** Where each known browser keeps its real user data. */
const REAL_PROFILE_DIRS: Readonly<Record<string, string>> = {
  chrome: '%LOCALAPPDATA%\\Google\\Chrome\\User Data',
  edge: '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data',
  brave: '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data',
  vivaldi: '%LOCALAPPDATA%\\Vivaldi\\User Data',
  opera: '%APPDATA%\\Opera Software\\Opera Stable',
};

export type ProfileKind = 'attached' | 'user' | 'samix';

export interface SessionStatus {
  readonly connected: boolean;
  readonly browser?: string;
  readonly profile?: ProfileKind;
  readonly endpoint?: string;
  /** Human sentence for the report when the profile is not the user's own. */
  readonly profileNote?: string;
}

export class BrowserSessionError extends Error {
  constructor(
    message: string,
    readonly code: 'APP_NOT_FOUND' | 'NETWORK_ERROR' | 'TIMEOUT' | 'INTERNAL_ERROR' = 'INTERNAL_ERROR',
  ) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

export interface BrowserSessionOptions {
  readonly apps: AppRegistry;
  /** Where the SAMIX fallback profile lives. Usually `<cacheDir>/chrome-profile`. */
  readonly profileDir: string;
  readonly port?: number;
  /** How long to wait for a freshly launched Chrome to open the debug port. */
  readonly startupTimeoutMs?: number;
}

export class BrowserSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private current: Page | undefined;
  private profile: ProfileKind | undefined;
  private browserName: string | undefined;
  private connecting: Promise<void> | undefined;

  private readonly port: number;
  private readonly startupTimeoutMs: number;

  constructor(private readonly options: BrowserSessionOptions) {
    this.port = options.port ?? DEFAULT_DEBUG_PORT;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  status(): SessionStatus {
    if (!this.browser?.isConnected()) return { connected: false };
    return {
      connected: true,
      ...(this.browserName ? { browser: this.browserName } : {}),
      ...(this.profile ? { profile: this.profile } : {}),
      endpoint: this.endpoint,
      ...(this.profileNote() ? { profileNote: this.profileNote()! } : {}),
    };
  }

  private profileNote(): string | undefined {
    if (this.profile !== 'samix') return undefined;
    return (
      `This is the agent's own browser profile, not your everyday one. Chrome 136 and later ` +
      `refuse remote control on the default profile outright, so there is no way to drive the ` +
      `browser you are normally signed into — this profile is the alternative, and it remembers ` +
      `a sign-in permanently. Sign in once here and it will stay signed in. Until then expect ` +
      `logged-out pages and the occasional CAPTCHA.`
    );
  }

  /**
   * Is a browser already running on the agent's own profile directory?
   *
   * This distinguishes the two cases that both look like "something is listening
   * on the debug port": the user's own Chrome started with the flag, and the
   * agent's fallback browser left over from an earlier session.
   *
   * Getting it wrong is not cosmetic. Attaching to our own leftover browser and
   * calling it `attached` meant the agent believed it had the user's profile,
   * suppressed the note above, and quietly ran every search logged out — which
   * the user discovers when a CAPTCHA appears, not when the agent says so.
   *
   * Chrome holds an exclusive handle on `lockfile` for as long as it is running,
   * so opening it for writing fails while the browser is up and succeeds when
   * the file is merely left behind. Cheap, synchronous, and no dependency on
   * enumerating processes.
   */
  private ownProfileInUse(): boolean {
    try {
      const handle = openSync(path.join(this.options.profileDir, 'lockfile'), 'r+');
      closeSync(handle);
      return false;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      // ENOENT means the profile has never been used. Anything else means the
      // file exists and something is holding it.
      return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
    }
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  /**
   * Get a page to work with, connecting or launching if necessary.
   *
   * Single-flight: several tools in one plan will call this at once, and two
   * concurrent launches would race to bind the same debug port and leave one of
   * them attached to nothing.
   */
  async page(options: { newTab?: boolean } = {}): Promise<Page> {
    await this.connect();
    const context = this.context;
    if (!context) throw new BrowserSessionError('The browser connection has no context.');

    // A page can be closed by the user at any moment; a stale handle throws on
    // the next call, which reads to the planner as a mysterious failure.
    if (this.current && !this.current.isClosed() && options.newTab !== true) {
      return this.current;
    }

    if (options.newTab === true) {
      this.current = await context.newPage();
      return this.current;
    }

    const open = context.pages().filter((page) => !page.isClosed());
    // Last, not first: on an attached browser the last page is the one most
    // recently opened, which is the one the user is looking at.
    this.current = open.at(-1) ?? (await context.newPage());
    return this.current;
  }

  /** The page currently being driven, without creating one. */
  activePage(): Page | undefined {
    return this.current && !this.current.isClosed() ? this.current : undefined;
  }

  private async connect(): Promise<void> {
    if (this.browser?.isConnected() && this.context) return;
    this.connecting ??= this.doConnect().finally(() => {
      this.connecting = undefined;
    });
    await this.connecting;
  }

  private async doConnect(): Promise<void> {
    // A dead handle from an earlier session must not be reused.
    this.browser = undefined;
    this.context = undefined;
    this.current = undefined;

    // --- 1. attach to whatever is already listening -------------------------
    //
    // Whose browser it is matters as much as that there is one. A leftover
    // agent browser from an earlier session listens on exactly the same port as
    // the user's own, and mistaking the first for the second is how the agent
    // ends up quietly searching the web logged out.
    if (await this.isPortOpen()) {
      await this.attach(this.ownProfileInUse() ? 'samix' : 'attached');
      return;
    }

    const app = await this.selectBrowser();

    // --- 2. launch on the user's real profile -------------------------------
    //
    // Chrome 136 and later refuse `--remote-debugging-port` whenever the
    // user-data-dir is the default one, so on a current Chrome this cannot
    // succeed and the attempt costs the full startup timeout before falling
    // through. It is kept because it still works on older builds and on some
    // Edge and Brave versions, but it is skipped when the browser is already
    // running on that profile — a second launch is forwarded to the running
    // instance, our flags are dropped, and the port never opens.
    const realProfile = expand(REAL_PROFILE_DIRS[app.id] ?? '');
    if (realProfile) {
      this.launch(app, realProfile);
      if (await this.waitForPort()) {
        await this.attach('user', app.displayName);
        return;
      }
    }

    // --- 3. fall back to the agent's own profile ----------------------------
    this.launch(app, this.options.profileDir);
    if (!(await this.waitForPort())) {
      throw new BrowserSessionError(
        `${app.displayName} started but never opened its remote-control port on ${this.endpoint}. ` +
          `Close every ${app.displayName} window and try again, or start it yourself with ` +
          `--remote-debugging-port=${this.port}.`,
        'TIMEOUT',
      );
    }
    await this.attach('samix', app.displayName);
  }

  private async attach(profile: ProfileKind, name?: string): Promise<void> {
    try {
      this.browser = await chromium.connectOverCDP(this.endpoint, { timeout: 15_000 });
    } catch (cause) {
      throw new BrowserSessionError(
        `Could not attach to the browser on ${this.endpoint}: ${String(cause)}`,
        'NETWORK_ERROR',
      );
    }

    // An attached Chrome exposes its existing profile as the first context.
    // Creating a new one would give a fresh, logged-out session — the exact
    // thing this whole approach exists to avoid.
    this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
    this.profile = profile;
    if (name) this.browserName = name;
    else this.browserName ??= 'the running browser';

    this.browser.on('disconnected', () => {
      this.browser = undefined;
      this.context = undefined;
      this.current = undefined;
      this.profile = undefined;
    });
  }

  private async selectBrowser(): Promise<DiscoveredApp> {
    const installed = (await this.options.apps.list()).filter((app) => app.kind === 'browser');
    const usable = installed.filter((app) => CDP_CAPABLE.has(app.id));

    const preferred =
      usable.find((app) => app.id === 'chrome') ??
      usable.find((app) => app.id === 'edge') ??
      usable[0];

    if (preferred) return preferred;

    throw new BrowserSessionError(
      installed.length > 0
        ? `Automation needs a Chromium-based browser (Chrome, Edge or Brave). Only ` +
          `${installed.map((app) => app.displayName).join(', ')} is installed, which cannot be driven this way.`
        : 'No web browser was found on this computer.',
      'APP_NOT_FOUND',
    );
  }

  /**
   * Start the browser with remote control enabled.
   *
   * Detached and unref'd so the browser outlives the agent — closing SAMIX must
   * not take the user's browser with it. `shell: false` and an argv array, so
   * the profile path is a path and not a command line.
   */
  private launch(app: DiscoveredApp, userDataDir: string): void {
    const child = spawn(
      app.executablePath,
      [
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${userDataDir}`,
        // Neither of these changes what the user sees in a profile they already
        // use; both stop a first run of the SAMIX profile from opening wizards.
        '--no-first-run',
        '--no-default-browser-check',
      ],
      { detached: true, stdio: 'ignore', shell: false, windowsHide: false },
    );
    child.unref();
    // A launch failure surfaces as "the port never opened", which is the
    // condition the caller actually needs to handle; an unhandled 'error' event
    // on a detached child would take the sidecar down instead.
    child.on('error', () => undefined);
  }

  // -------------------------------------------------------------------------
  // Port probing
  // -------------------------------------------------------------------------

  /**
   * Is a DevTools endpoint answering?
   *
   * `/json/version` rather than a bare TCP connect: something else could hold
   * port 9222, and attaching Playwright to an unrelated service produces a
   * baffling protocol error instead of a clear "nothing is there".
   */
  private async isPortOpen(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/json/version`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as { Browser?: unknown };
      return typeof payload.Browser === 'string';
    } catch {
      return false;
    }
  }

  private async waitForPort(): Promise<boolean> {
    const deadline = Date.now() + this.startupTimeoutMs;
    for (;;) {
      if (await this.isPortOpen()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Close the page being driven, or let go of the browser entirely.
   *
   * `disconnect` deliberately does not close the browser. The user's windows,
   * tabs and unsaved form input are theirs; an agent that ends a task by closing
   * their browser has overstepped. Chrome keeps running with the debug port
   * open, so the next instruction reattaches instantly.
   */
  async close(target: 'tab' | 'browser'): Promise<{ closed: 'tab' | 'browser' | 'nothing' }> {
    if (target === 'tab') {
      const page = this.activePage();
      if (!page) return { closed: 'nothing' };
      await page.close({ runBeforeUnload: true });
      this.current = undefined;
      return { closed: 'tab' };
    }

    if (!this.browser?.isConnected()) return { closed: 'nothing' };
    await this.browser.close();
    this.browser = undefined;
    this.context = undefined;
    this.current = undefined;
    this.profile = undefined;
    return { closed: 'browser' };
  }

  /** Release the connection at shutdown. Never throws. */
  async dispose(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      // Shutting down is not a moment to fail over a socket that is already gone.
    }
    this.browser = undefined;
    this.context = undefined;
    this.current = undefined;
  }
}

/** Expand `%VAR%`; returns undefined if any variable is unset. */
function expand(template: string): string | undefined {
  if (template === '') return undefined;
  let failed = false;
  const expanded = template.replace(/%([^%]+)%/g, (_match, name: string) => {
    const value = process.env[name];
    if (value === undefined || value === '') {
      failed = true;
      return '';
    }
    return value;
  });
  return failed ? undefined : path.normalize(expanded);
}
