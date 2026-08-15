import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  err,
  ok,
  verification,
  type AgentTool,
  type ToolResult,
  type Verification,
} from '@samix/shared';
import type { AppRegistry, DiscoveredApp } from './app-registry.js';
import { isProcessRunning } from '../windows/processes.js';

/**
 * Opening web pages (a useful slice of spec's Phase 6).
 *
 * ## Why this is not Playwright
 *
 * Full browser automation — reading the DOM, clicking elements, filling forms —
 * is Phase 6 and genuinely needs Playwright. But "open Chrome and search for X",
 * which is the request people actually make first, needs none of it: a browser
 * launched with a URL argument does exactly that, in the user's real browser,
 * with their real session and extensions.
 *
 * Playwright would instead drive a separate automation profile, so the user
 * would watch a *different* browser open, logged out of everything. For this
 * task the simple mechanism is not a compromise; it is the better one.
 *
 * ## Permission level
 *
 * `external`, deliberately, which means CONTROLLED mode confirms it. Opening a
 * URL reaches the network on the user's behalf, and the URL may have come from
 * a model that was reasoning about untrusted text. The confirmation prompt shows
 * the exact address before anything is fetched, which is the whole point.
 */

/**
 * Only `http` and `https` may be opened.
 *
 * A browser command line accepts far more than web pages. `file:///C:/Users/...`
 * would turn this into an arbitrary-file-read that bypasses PathPolicy entirely;
 * `javascript:` and `data:` are script execution in the user's session. The
 * allow-list is two schemes long because those are the two that mean "a web
 * page".
 */
const SAFE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

function parseWebUrl(raw: string): URL | undefined {
  // A bare "example.com" is what people type; treat it as https rather than
  // failing, but never guess a scheme that is not http(s).
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  return SAFE_SCHEMES.has(url.protocol) ? url : undefined;
}

const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
} as const;

/**
 * Pick the browser to use.
 *
 * When the user named one, only that one will do — silently substituting Edge
 * for a user who asked for Chrome is the kind of "helpful" liberty that makes an
 * agent untrustworthy. When they did not, any installed browser is fine.
 */
async function selectBrowser(
  apps: AppRegistry,
  requested: string | undefined,
): Promise<{ app: DiscoveredApp } | { error: string; installed: string[] }> {
  const installed = (await apps.list()).filter((app) => app.kind === 'browser');

  if (requested !== undefined) {
    const match = await apps.resolve(requested);
    if (match && match.kind === 'browser') return { app: match };
    return {
      error: `${requested} is not an installed browser on this computer.`,
      installed: installed.map((app) => app.displayName),
    };
  }

  const preferred =
    installed.find((app) => app.id === 'chrome') ??
    installed.find((app) => app.id === 'edge') ??
    installed[0];

  if (!preferred) {
    return { error: 'No web browser was found on this computer.', installed: [] };
  }
  return { app: preferred };
}

function openInBrowser(browser: DiscoveredApp, url: string): number | undefined {
  // Detached, so the browser outlives the agent; `--` is not used because these
  // are separate argv entries, never a command line the browser re-parses.
  const child = spawn(browser.executablePath, [url], {
    detached: true,
    stdio: 'ignore',
    shell: false,
  });
  child.unref();
  return child.pid;
}

/**
 * Verifying a page open is honest about its limits.
 *
 * We can confirm the browser process is running. We cannot confirm the page
 * loaded, or that the user is looking at it — that needs Playwright or UI
 * Automation. So this reports `unverified` with a plain statement of what was
 * and was not checked, rather than `verified` for a weaker claim than the user
 * would assume. Development rule 25 is about exactly this gap.
 */
async function verifyBrowserOpen(browser: DiscoveredApp, url: string): Promise<Verification> {
  const deadline = Date.now() + 10_000;
  do {
    try {
      if (await isProcessRunning(browser.imageName)) {
        return verification(
          'unverified',
          `${browser.displayName} is running and was asked to open ${url}. ` +
            `Whether the page itself loaded has not been checked.`,
        );
      }
    } catch (cause) {
      return verification('unverified', `Could not read the process list: ${String(cause)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  } while (Date.now() < deadline);

  return verification('failed', `${browser.displayName} did not start.`);
}

// ---------------------------------------------------------------------------
// browser.openUrl
// ---------------------------------------------------------------------------

const OpenUrlInput = z
  .object({
    url: z.string().min(1).describe('The web address to open. Must be http or https.'),
    browser: z
      .string()
      .optional()
      .describe('Which browser to use, e.g. "Chrome". Omit to use the default installed browser.'),
  })
  .strict();
type OpenUrlInput = z.infer<typeof OpenUrlInput>;

export interface OpenUrlResult {
  readonly url: string;
  readonly browser: string;
  readonly pid?: number;
}

export function createBrowserOpenUrlTool(apps: AppRegistry): AgentTool<OpenUrlInput, OpenUrlResult> {
  return {
    name: 'browser.openUrl',
    description:
      'Open a web page in a real browser window on the user’s screen. Accepts http and https ' +
      'addresses only. Use browser.search instead when the user wants to search for something ' +
      'rather than visit a specific address. This shows the page to the user; it does not read ' +
      'the page back, so it cannot be used to fetch content.',
    permission: 'external',
    reversibility: 'reversible',
    inputSchema: OpenUrlInput,
    verification: 'explicit',
    timeoutMs: 20_000,

    describeEffect(input): string {
      const target = input.browser ? ` in ${input.browser}` : '';
      return `Open ${input.url}${target}.`;
    },

    async execute(input): Promise<ToolResult<OpenUrlResult>> {
      const url = parseWebUrl(input.url);
      if (!url) {
        return err(
          'INVALID_INPUT',
          `"${input.url}" is not an http or https web address. Only web pages can be opened.`,
          { recoverable: false, details: { url: input.url } },
        );
      }

      const selection = await selectBrowser(apps, input.browser);
      if ('error' in selection) {
        return err('APP_NOT_FOUND', selection.error, { details: { installed: selection.installed } });
      }

      const pid = openInBrowser(selection.app, url.href);
      return ok({
        url: url.href,
        browser: selection.app.displayName,
        ...(pid === undefined ? {} : { pid }),
      });
    },

    async verify(input, result): Promise<Verification> {
      if (!result.success || !result.data) {
        return verification('not-applicable', 'Nothing was opened.');
      }
      const selection = await selectBrowser(apps, input.browser);
      if ('error' in selection) return verification('unverified', 'The browser could not be re-resolved.');
      return verifyBrowserOpen(selection.app, result.data.url);
    },
  };
}

// ---------------------------------------------------------------------------
// browser.search
// ---------------------------------------------------------------------------

const SearchInput = z
  .object({
    query: z.string().min(1).describe('What to search for, in the user’s own words.'),
    engine: z
      .enum(['google', 'bing', 'duckduckgo'])
      .optional()
      .describe('Search engine to use. Defaults to Google.'),
    browser: z.string().optional().describe('Which browser to use, e.g. "Chrome".'),
  })
  .strict();
type SearchInput = z.infer<typeof SearchInput>;

export function createBrowserSearchTool(apps: AppRegistry): AgentTool<SearchInput, OpenUrlResult> {
  return {
    name: 'browser.search',
    description:
      'Search the web for something and show the results to the user in a browser window. ' +
      'This is the right tool for "search for X", "look up X" or "google X". It opens the results ' +
      'page for the user to read — it does not return the results to you, so you cannot answer ' +
      'from them yourself.',
    permission: 'external',
    reversibility: 'reversible',
    inputSchema: SearchInput,
    verification: 'explicit',
    timeoutMs: 20_000,

    describeEffect(input): string {
      const engine = input.engine ?? 'google';
      const target = input.browser ? ` in ${input.browser}` : '';
      return `Search ${engine} for “${input.query}”${target}.`;
    },

    async execute(input): Promise<ToolResult<OpenUrlResult>> {
      const selection = await selectBrowser(apps, input.browser);
      if ('error' in selection) {
        return err('APP_NOT_FOUND', selection.error, { details: { installed: selection.installed } });
      }

      // encodeURIComponent, not template interpolation: a query containing `&`
      // or `#` would otherwise silently become extra URL parameters.
      const url = `${SEARCH_ENGINES[input.engine ?? 'google']}${encodeURIComponent(input.query)}`;
      const pid = openInBrowser(selection.app, url);

      return ok({
        url,
        browser: selection.app.displayName,
        ...(pid === undefined ? {} : { pid }),
      });
    },

    async verify(input, result): Promise<Verification> {
      if (!result.success || !result.data) {
        return verification('not-applicable', 'Nothing was searched.');
      }
      const selection = await selectBrowser(apps, input.browser);
      if ('error' in selection) return verification('unverified', 'The browser could not be re-resolved.');
      return verifyBrowserOpen(selection.app, result.data.url);
    },
  };
}
