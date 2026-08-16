import fs from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { z } from 'zod';
import {
  err,
  ok,
  verification,
  type AgentTool,
  type ToolExecutionContext,
  type ToolResult,
  type Verification,
} from '@samix/shared';
import { BrowserSessionError, type BrowserSession } from './session.js';

/**
 * Browser tools (spec §19) — Phase 6.
 *
 * Everything here drives a real page through {@link BrowserSession}, so every
 * action can be **observed afterwards**: `page.url()`, `page.title()` and the
 * DOM itself are read back from the browser once the load settles. That is what
 * makes verification meaningful rather than a formality — the previous
 * implementation could only report that a process existed.
 *
 * ## Permission levels (spec §31) — the deliberate reclassification
 *
 * These tools used to be `external`, which meant CONTROLLED mode stopped and
 * asked before every search. That was wrong on the spec's own terms and worse in
 * practice.
 *
 * Spec §31 gives EXTERNAL as "send WhatsApp message, send email, upload file,
 * post online" — the common thread is **transmitting the user's data to someone
 * else**. Opening a page or reading it back is retrieval: it is the browser
 * equivalent of `filesystem.read`, and §31 lists reads under READ. A Google
 * search reveals a query string to Google, which is precisely what the user
 * asked for when they said "search for X".
 *
 * The practical argument is the stronger one. A prompt that appears before
 * every harmless action is a prompt nobody reads. Training the user to approve
 * reflexively is not a safety measure — it is the *destruction* of one, because
 * the prompt that actually matters ("send this file to Charles") arrives looking
 * exactly like the forty they have already waved through. Confirmation is a
 * scarce resource and has to be spent where it changes an outcome.
 *
 * So:
 *
 *  - `goto`, `search`, `scroll`, `extractText`, `screenshot` → **read**, and run
 *    without a prompt. They fetch and observe; they transmit nothing the user
 *    did not ask to send.
 *  - `click` → **write**, reversibility **unknown**, so CONTROLLED confirms it.
 *    A click is the one action here that can submit a form, send a message or
 *    buy something, and nothing in the arguments reliably distinguishes "next
 *    page" from "Place order". Where the class of action cannot be known, the
 *    conservative reading is the correct one.
 *  - `close` → **write**, reversible: it closes the tab the agent is driving,
 *    leaving the browser and every other tab alone.
 *
 * The rule to apply when adding to this file: EXTERNAL is for sending, not for
 * fetching.
 */

/**
 * The browser globals used inside `page.evaluate` callbacks.
 *
 * Declared here rather than by adding `"dom"` to the package's `lib`. That
 * option is program-wide: it would put `fetch`, `Request`, `Response`,
 * `AbortSignal` and several hundred other names into every file in a **Node**
 * sidecar, where some of them collide with `@types/node` and all of them are
 * lies about the runtime. These few names are only real inside the callbacks
 * below, which are serialised and executed in the page — so declaring exactly
 * them, in exactly this file, says something true.
 */
declare const window: {
  readonly scrollY: number;
  readonly innerHeight: number;
  scrollTo(options: { top: number }): void;
  scrollBy(options: { top: number }): void;
};
declare const document: { readonly body: { readonly scrollHeight: number } };

/** The element shapes read back from the page. Structural, not the full DOM types. */
interface PageElement {
  readonly textContent?: string | null;
  querySelector?(selector: string): PageElement | null;
}

interface PageAnchor extends PageElement {
  readonly innerText?: string;
  readonly href?: string;
  closest?(selector: string): PageElement | null;
}

/** Ceiling on text handed back to the planner, so one page cannot eat the context budget. */
const MAX_EXTRACT_CHARS = 8_000;

/** Search engines, with the selector that finds their result links. */
const ENGINES = {
  google: {
    url: 'https://www.google.com/search?q=',
    results: 'div#search a:has(h3), div#rso a:has(h3)',
  },
  bing: { url: 'https://www.bing.com/search?q=', results: '#b_results h2 > a' },
  duckduckgo: {
    url: 'https://duckduckgo.com/?q=',
    results: 'a[data-testid="result-title-a"], article h2 a',
  },
} as const;

type EngineName = keyof typeof ENGINES;

const SAFE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Only `http` and `https` may be opened.
 *
 * A browser accepts far more than web pages. `file:///C:/Users/...` would turn
 * this into an arbitrary-file-read that bypasses PathPolicy entirely, and
 * `javascript:` and `data:` are script execution in the user's own session.
 * The allow-list is two schemes long because those are the two that mean
 * "a web page".
 */
export function parseWebUrl(raw: string): URL | undefined {
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

/** What every navigating tool reports, and what its verifier re-checks. */
export interface PageState {
  readonly url: string;
  readonly title: string;
}

async function readPage(page: Page): Promise<PageState> {
  return { url: page.url(), title: (await page.title().catch(() => '')) || '(untitled)' };
}

/**
 * Wait for the page to settle without letting a chatty page hang the step.
 *
 * `domcontentloaded` is awaited and matters; `load` is attempted and forgiven.
 * Plenty of real pages hold a connection open — analytics beacons, long-polling
 * chat widgets — and never fire `load` at all. Failing a navigation that plainly
 * worked, because a tracking pixel is still in flight, would be a verification
 * that lies in the *pessimistic* direction.
 */
async function settle(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForLoadState('load', { timeout: Math.min(timeoutMs, 5_000) }).catch(() => undefined);
}

/**
 * Turn a session or Playwright failure into a structured tool error.
 *
 * The error codes matter more than the messages: the planner branches on them
 * during recovery (spec §50), and "the element was not there" needs a different
 * response from "the browser would not start".
 */
function toBrowserError<T>(cause: unknown): ToolResult<T> {
  if (cause instanceof BrowserSessionError) {
    return err(cause.code, cause.message, { recoverable: cause.code !== 'APP_NOT_FOUND' });
  }
  const message = cause instanceof Error ? cause.message : String(cause);

  if (/Timeout .* exceeded|timeout/i.test(message)) {
    return err('TIMEOUT', `The browser did not respond in time: ${message.split('\n')[0]}`);
  }
  if (/strict mode violation|waiting for locator|not visible|not found|no element/i.test(message)) {
    return err('ELEMENT_NOT_FOUND', message.split('\n')[0] ?? message);
  }
  if (/net::ERR|NS_ERROR|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(message)) {
    return err('NETWORK_ERROR', `The page could not be loaded: ${message.split('\n')[0]}`);
  }
  return err('INTERNAL_ERROR', message.split('\n')[0] ?? message);
}

/**
 * Verify a navigation by re-reading the browser.
 *
 * Compares hosts rather than whole URLs. Redirects are the norm — a login wall,
 * a country variant, a canonical host, a tracking parameter appended by the
 * site — and treating any of those as a failure would report a page the user is
 * looking at as not having loaded. What must not pass is landing somewhere
 * unrelated, or on `about:blank`, which is what the host comparison catches.
 */
async function verifyNavigation(
  session: BrowserSession,
  expected: string | undefined,
  what: string,
): Promise<Verification> {
  const page = session.activePage();
  if (!page) {
    return verification('unverified', `${what} — the page could no longer be read back.`);
  }

  let state: PageState;
  try {
    state = await readPage(page);
  } catch (cause) {
    return verification('unverified', `${what} — could not read the page back: ${String(cause)}`);
  }

  if (state.url === '' || state.url === 'about:blank') {
    return verification('failed', `Nothing loaded — the tab is still blank.`);
  }

  const note = session.status().profileNote;
  const suffix = note ? ` ${note}` : '';

  if (expected) {
    const wanted = safeHost(expected);
    const landed = safeHost(state.url);
    if (wanted && landed && wanted !== landed) {
      return verification(
        'verified',
        `${landed} is showing "${state.title}" — note that ${wanted} redirected there.${suffix}`,
      );
    }
  }

  return verification('verified', `The page is showing "${state.title}" at ${state.url}.${suffix}`);
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * Race a browser operation against the user's cancellation.
 *
 * Playwright takes a timeout but not an `AbortSignal`, so an emergency stop
 * cannot reach into an in-flight call. This returns control to the agent
 * immediately, which is what spec §33 requires; the underlying operation runs
 * on until its own timeout, which is stated here rather than pretended away.
 */
async function withCancellation<T>(work: Promise<T>, ctx: ToolExecutionContext): Promise<T> {
  if (!ctx.signal.aborted) {
    return Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        ctx.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        );
      }),
    ]);
  }
  throw new DOMException('Cancelled before the browser was used', 'AbortError');
}

// ---------------------------------------------------------------------------
// browser.goto
// ---------------------------------------------------------------------------

const GotoInput = z
  .object({
    url: z.string().min(1).describe('The web address to open. Must be http or https.'),
    newTab: z
      .boolean()
      .optional()
      .describe('Open in a new tab instead of reusing the tab the agent is driving.'),
  })
  .strict();
type GotoInput = z.infer<typeof GotoInput>;

export function createBrowserGotoTool(session: BrowserSession): AgentTool<GotoInput, PageState> {
  return {
    name: 'browser.goto',
    description:
      'Open a web page in the user’s browser and wait for it to load. Returns the address and title ' +
      'the page actually settled on, so redirects and login walls are visible. The page stays open and ' +
      'can then be read with browser.extractText, scrolled, clicked or captured. Use browser.search ' +
      'instead when the user wants to look something up rather than visit a known address.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: GotoInput,
    verification: 'explicit',
    timeoutMs: 60_000,

    async execute(input, ctx): Promise<ToolResult<PageState>> {
      const url = parseWebUrl(input.url);
      if (!url) {
        return err(
          'INVALID_INPUT',
          `"${input.url}" is not an http or https web address. Only web pages can be opened.`,
          { recoverable: false, details: { url: input.url } },
        );
      }

      try {
        const page = await withCancellation(
          session.page(input.newTab === true ? { newTab: true } : {}),
          ctx,
        );
        await withCancellation(
          page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: ctx.timeoutMs }),
          ctx,
        );
        await settle(page, 10_000);
        return ok(await readPage(page));
      } catch (cause) {
        return toBrowserError<PageState>(cause);
      }
    },

    async verify(input, result): Promise<Verification> {
      if (!result.success) return verification('not-applicable', 'Nothing was opened.');
      return verifyNavigation(session, input.url, 'Navigated');
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
    limit: z.number().int().min(1).max(20).optional().describe('How many results to read back.'),
  })
  .strict();
type SearchInput = z.infer<typeof SearchInput>;

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  /** The site the result is from, as shown on the results page, e.g. `playwright.dev`. */
  readonly source: string;
}

export interface SearchOutput extends PageState {
  readonly query: string;
  readonly engine: EngineName;
  readonly results: SearchResult[];
}

export function createBrowserSearchTool(session: BrowserSession): AgentTool<SearchInput, SearchOutput> {
  return {
    name: 'browser.search',
    description:
      'Search the web and read the results back. This is the right tool for "search for X", "look up X" ' +
      'or "google X". It shows the results page to the user AND returns the result titles and links to ' +
      'you, so you can answer from them or follow one with browser.goto. If the results are not enough, ' +
      'open a result and use browser.extractText.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: SearchInput,
    verification: 'explicit',
    timeoutMs: 60_000,

    async execute(input, ctx): Promise<ToolResult<SearchOutput>> {
      const engine: EngineName = input.engine ?? 'google';
      // encodeURIComponent, not template interpolation: a query containing `&`
      // or `#` would otherwise silently become extra URL parameters.
      const url = `${ENGINES[engine].url}${encodeURIComponent(input.query)}`;

      try {
        const page = await withCancellation(session.page(), ctx);
        await withCancellation(
          page.goto(url, { waitUntil: 'domcontentloaded', timeout: ctx.timeoutMs }),
          ctx,
        );
        await settle(page, 10_000);

        const results = await readResults(page, engine, input.limit ?? 8);
        return ok({ ...(await readPage(page)), query: input.query, engine, results });
      } catch (cause) {
        return toBrowserError<SearchOutput>(cause);
      }
    },

    async verify(_input, result): Promise<Verification> {
      if (!result.success || !result.data) return verification('not-applicable', 'Nothing was searched.');

      const navigated = await verifyNavigation(session, undefined, 'Searched');
      if (navigated.status !== 'verified') return navigated;

      const count = result.data.results.length;
      if (count === 0) {
        // The page is genuinely there — that part is confirmed — but the thing
        // the caller wanted (results) was not obtained, and saying "verified"
        // would let the planner answer from results it never received. A consent
        // interstitial or a changed layout both land here.
        return verification(
          'unverified',
          `The ${result.data.engine} results page loaded, but no results could be read from it — ` +
            `it may be showing a consent or verification page. The user can see it on screen.`,
        );
      }
      return verification(
        'verified',
        `Read ${count} result${count === 1 ? '' : 's'} from ${result.data.engine} for "${result.data.query}".`,
      );
    },
  };
}

/**
 * Pull result titles and links off a results page.
 *
 * Engine-specific selectors first, then a generic sweep. Search engines change
 * their markup without notice, and a tool that returns nothing the week Google
 * renames a class is worse than one that returns slightly noisier links. The
 * generic pass keeps this useful — and when both find nothing, the verifier says
 * so rather than reporting an empty answer as a successful search.
 */
async function readResults(page: Page, engine: EngineName, limit: number): Promise<SearchResult[]> {
  // Wait for the results to exist before reading. `domcontentloaded` and `load`
  // both fire on the document a search engine serves *first*, and at least one
  // of them redirects (the `&sei=` parameter) before the real results arrive —
  // so reading immediately returns an empty page that looks like "no results".
  //
  // `state: 'attached'`, not `'visible'`, and this is the important part: in
  // Europe the results are rendered behind a cookie-consent overlay. They are
  // genuinely in the response and genuinely readable; waiting for visibility
  // would time out on a page that has the answer on it.
  await page
    .waitForSelector(ENGINES[engine].results, { state: 'attached', timeout: 8_000 })
    .catch(() => undefined);

  const collect = async (selector: string): Promise<RawResult[]> =>
    page
      .$$eval(selector, (nodes) =>
        (nodes as unknown as PageAnchor[])
          .map((anchor) => {
            // `innerText` is empty for anything the page has hidden — which is
            // every result on a consent-walled page — so `textContent` is not a
            // fallback for exotic markup, it is the normal path in Europe.
            const label = (anchor.innerText || anchor.textContent || '').trim();
            const container = anchor.closest?.('div[data-hveid], article, li, div.g');
            const cite = container?.querySelector?.('cite')?.textContent ?? '';
            return { title: label.split('\n')[0] ?? '', url: anchor.href ?? '', cite: cite.trim() };
          })
          .filter((item) => item.title !== '' && /^https?:/.test(item.url)),
      )
      .catch(() => []);

  const specific = await collect(ENGINES[engine].results);
  const found =
    specific.length > 0 ? specific : await collect('main a[href^="http"], #links a[href^="http"]');

  const engineHost = safeHost(ENGINES[engine].url);
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  for (const item of found) {
    const resolved = resolveResultUrl(item, engineHost);
    // Engines wrap one result in several anchors; dedupe by destination.
    if (resolved === undefined || seen.has(resolved.url) || item.title.length < 3) continue;
    seen.add(resolved.url);
    results.push({ title: item.title.slice(0, 160), ...resolved });
    if (results.length >= limit) break;
  }
  return results;
}

interface RawResult {
  readonly title: string;
  readonly url: string;
  readonly cite?: string;
}

/**
 * Recover the destination a result actually points at.
 *
 * Search engines rewrite result links for click tracking, and the rewriting gets
 * more aggressive the less the browser has consented to. Google alone produces
 * three shapes: the real URL, `/url?q=<real url>` — recoverable — and
 * `/goto?url=<opaque blob>`, which is not decodable by anyone outside Google.
 *
 * Handing a planner `google.com/goto?url=CAESaAHuR6pN…` is barely better than
 * handing it nothing: it cannot tell whether a result is from official
 * documentation or from a content farm, which is most of what result links are
 * *for*. So when the destination cannot be recovered, the visible `cite` line —
 * which the user is looking at anyway — supplies the origin, and the tracking
 * URL is kept as something `browser.goto` can still follow.
 */
function resolveResultUrl(
  item: RawResult,
  engineHost: string | undefined,
): { url: string; source: string } | undefined {
  const host = safeHost(item.url);
  if (host === undefined) return undefined;

  // Not the engine's own host: this is already the real destination.
  if (engineHost === undefined || host !== engineHost) {
    return { url: item.url, source: host };
  }

  // A redirect that carries the destination in a query parameter.
  try {
    const parsed = new URL(item.url);
    for (const key of ['url', 'q', 'u']) {
      const value = parsed.searchParams.get(key);
      // An absolute URL only. `parseWebUrl` helpfully reads a bare word as a
      // hostname, which is right for something a person typed and badly wrong
      // here: Google's opaque `?url=CAESaAHuR6pN…` blob would become
      // `https://caesaahur6pn…/`, a confident-looking address for a site that
      // does not exist. A recovered destination is either already a URL or is
      // not recoverable.
      if (value === null || !/^https?:\/\//i.test(value)) continue;
      const target = parseWebUrl(value);
      if (target && safeHost(target.href) !== engineHost) {
        return { url: target.href, source: safeHost(target.href) ?? engineHost };
      }
    }
  } catch {
    // Fall through to the cite line.
  }

  const cited = citedHost(item.cite);
  return cited ? { url: item.url, source: cited } : { url: item.url, source: host };
}

/** `https://playwright.dev › docs › api` → `playwright.dev`. */
function citedHost(cite: string | undefined): string | undefined {
  if (!cite) return undefined;
  const first = cite.split(/[›»]/)[0]?.trim();
  return first ? safeHost(first) ?? safeHost(`https://${first}`) : undefined;
}

// ---------------------------------------------------------------------------
// browser.scroll
// ---------------------------------------------------------------------------

const ScrollInput = z
  .object({
    direction: z
      .enum(['down', 'up', 'top', 'bottom'])
      .describe('Which way to move. "top" and "bottom" jump to the ends.'),
    pages: z
      .number()
      .min(0.1)
      .max(20)
      .optional()
      .describe('How far to scroll, in screenfuls. Defaults to one. Ignored for top and bottom.'),
  })
  .strict();
type ScrollInput = z.infer<typeof ScrollInput>;

export interface ScrollResult {
  readonly position: number;
  readonly pageHeight: number;
  readonly atBottom: boolean;
  readonly moved: number;
}

export function createBrowserScrollTool(session: BrowserSession): AgentTool<ScrollInput, ScrollResult> {
  return {
    name: 'browser.scroll',
    description:
      'Scroll the open web page, so the user can see further down it or so more content loads before ' +
      'you read it with browser.extractText. Use this when a page is long or loads more as you scroll.',
    // Moving the viewport neither changes the user's data nor sends anything.
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: ScrollInput,
    verification: 'explicit',
    timeoutMs: 30_000,

    async execute(input, ctx): Promise<ToolResult<ScrollResult>> {
      const page = session.activePage();
      if (!page) {
        return err('WINDOW_NOT_FOUND', 'No web page is open to scroll. Open one first with browser.goto.');
      }

      try {
        const before = await withCancellation(
          page.evaluate(() => window.scrollY) as Promise<number>,
          ctx,
        );

        await withCancellation(
          page.evaluate(
            ({ direction, pages }: { direction: string; pages: number }) => {
              const step = window.innerHeight * pages;
              if (direction === 'top') window.scrollTo({ top: 0 });
              else if (direction === 'bottom') window.scrollTo({ top: document.body.scrollHeight });
              else window.scrollBy({ top: direction === 'down' ? step : -step });
            },
            { direction: input.direction, pages: input.pages ?? 1 },
          ),
          ctx,
        );

        // Lazy-loading pages need a beat to render what the scroll revealed;
        // reading immediately reports the height before the new content exists.
        await page.waitForTimeout(350);

        const after = await withCancellation(
          page.evaluate(() => ({
            position: window.scrollY,
            pageHeight: document.body.scrollHeight,
            viewport: window.innerHeight,
          })) as Promise<{ position: number; pageHeight: number; viewport: number }>,
          ctx,
        );

        return ok({
          position: Math.round(after.position),
          pageHeight: Math.round(after.pageHeight),
          atBottom: after.position + after.viewport >= after.pageHeight - 4,
          moved: Math.round(after.position - before),
        });
      } catch (cause) {
        return toBrowserError<ScrollResult>(cause);
      }
    },

    async verify(_input, result): Promise<Verification> {
      if (!result.success || !result.data) return verification('not-applicable', 'Nothing was scrolled.');
      const { moved, atBottom, position } = result.data;

      if (moved === 0) {
        // Not a failure: a page shorter than the window, or one already at the
        // end, genuinely cannot move. Saying which is more useful than "failed".
        return verification(
          'not-applicable',
          atBottom
            ? 'The page was already at the bottom, so nothing moved.'
            : 'The page is not long enough to scroll.',
        );
      }
      return verification(
        'verified',
        `Scrolled ${Math.abs(moved)} pixels${atBottom ? ' to the bottom of the page' : ` to position ${position}`}.`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// browser.click
// ---------------------------------------------------------------------------

const ClickInput = z
  .object({
    text: z
      .string()
      .min(1)
      .optional()
      .describe('The visible label of the link or button, e.g. "Sign in" or "Next page".'),
    selector: z.string().min(1).optional().describe('A CSS selector, when the label is not distinctive.'),
    role: z
      .enum(['link', 'button', 'checkbox', 'radio', 'tab', 'menuitem', 'option'])
      .optional()
      .describe('Accessible role of the element, used with `text` to disambiguate.'),
    index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Which match to click when several are the same, counting from 0.'),
  })
  .strict()
  .refine((value) => value.text !== undefined || value.selector !== undefined, {
    message: 'Give either the visible text of the element or a CSS selector.',
  });
type ClickInput = z.infer<typeof ClickInput>;

export interface ClickResult extends PageState {
  readonly clicked: string;
  readonly urlChanged: boolean;
}

export function createBrowserClickTool(session: BrowserSession): AgentTool<ClickInput, ClickResult> {
  return {
    name: 'browser.click',
    description:
      'Click a link, button or control on the open web page, identified by its visible text or a CSS ' +
      'selector. Waits for the element to be genuinely clickable and reports where the page ended up. ' +
      'The user is asked to confirm first, because a click can submit a form or send something.',
    // Not `external`: most clicks navigate and send nothing. Not plain
    // `reversible` either — some submit. `unknown` is the honest answer, and it
    // is what makes CONTROLLED mode ask. See the file header.
    permission: 'write',
    reversibility: 'unknown',
    inputSchema: ClickInput,
    verification: 'explicit',
    timeoutMs: 45_000,

    describeEffect(input): string {
      const what = input.text ? `“${input.text}”` : `the element matching ${input.selector}`;
      return `Click ${what} on the page that is open.`;
    },

    async execute(input, ctx): Promise<ToolResult<ClickResult>> {
      const page = session.activePage();
      if (!page) {
        return err('WINDOW_NOT_FOUND', 'No web page is open. Open one first with browser.goto.');
      }

      try {
        const before = page.url();
        const target = locate(page, input);
        const count = await withCancellation(target.count(), ctx);

        if (count === 0) {
          return err('ELEMENT_NOT_FOUND', `Nothing on this page matches ${describeTarget(input)}.`, {
            details: { clickable: await nearbyLabels(page) },
          });
        }

        const element = target.nth(input.index ?? 0);
        const label = (await element.innerText().catch(() => ''))?.trim().split('\n')[0];

        // Playwright waits for the element to be attached, visible, stable and
        // hit-testable before dispatching, and throws otherwise. So reaching the
        // next line means a real element really received a real click.
        await withCancellation(element.click({ timeout: Math.min(ctx.timeoutMs, 20_000) }), ctx);
        await settle(page, 8_000);

        const state = await readPage(page);
        return ok({
          ...state,
          clicked: label && label !== '' ? label : describeTarget(input),
          urlChanged: state.url !== before,
        });
      } catch (cause) {
        return toBrowserError<ClickResult>(cause);
      }
    },

    async verify(_input, result): Promise<Verification> {
      if (!result.success || !result.data) return verification('not-applicable', 'Nothing was clicked.');
      const { clicked, urlChanged, title, url } = result.data;

      return verification(
        'verified',
        urlChanged
          ? `Clicked "${clicked}" and the page moved to "${title}" at ${url}.`
          : `Clicked "${clicked}"; the page is still "${title}".`,
      );
    },
  };
}

function locate(page: Page, input: ClickInput): Locator {
  if (input.selector !== undefined) return page.locator(input.selector);

  const text = input.text ?? '';
  if (input.role !== undefined) return page.getByRole(input.role, { name: text });

  // Restrict to things that are actually clickable before falling back to any
  // element containing the text. Without the narrowing, "Sign in" matches the
  // <body> that contains it, and clicking the body does nothing at all while
  // looking like a success.
  const clickable = page
    .locator('a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"], summary')
    .filter({ hasText: text });

  return clickable;
}

function describeTarget(input: ClickInput): string {
  if (input.selector !== undefined) return `the selector "${input.selector}"`;
  return `"${input.text}"${input.role ? ` (${input.role})` : ''}`;
}

/** A few clickable labels, so a miss gives the planner something to re-plan against. */
async function nearbyLabels(page: Page): Promise<string[]> {
  return page
    .$$eval('a, button, [role="button"]', (nodes) =>
      (nodes as unknown as PageAnchor[])
        .map((node) => node.innerText?.trim().split('\n')[0] ?? '')
        .filter((label) => label.length > 0 && label.length < 60)
        .slice(0, 20),
    )
    .catch(() => []);
}

// ---------------------------------------------------------------------------
// browser.extractText
// ---------------------------------------------------------------------------

const ExtractInput = z
  .object({
    selector: z
      .string()
      .min(1)
      .optional()
      .describe('CSS selector to read from. Omit to read the whole page.'),
    maxChars: z.number().int().min(100).max(MAX_EXTRACT_CHARS).optional(),
  })
  .strict();
type ExtractInput = z.infer<typeof ExtractInput>;

export interface ExtractResult extends PageState {
  readonly text: string;
  readonly truncated: boolean;
  readonly characters: number;
}

export function createBrowserExtractTextTool(
  session: BrowserSession,
): AgentTool<ExtractInput, ExtractResult> {
  return {
    name: 'browser.extractText',
    description:
      'Read the visible text of the open web page, or of one part of it, and return it to you. This is ' +
      'how you actually answer questions about a page — its content, an error message on it, a price, ' +
      'an article. Scroll first if what you need is further down a page that loads as it scrolls.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: ExtractInput,
    // A pure read: the returned text IS the observation of the page (spec §29).
    verification: 'intrinsic',
    timeoutMs: 45_000,

    async execute(input, ctx): Promise<ToolResult<ExtractResult>> {
      const page = session.activePage();
      if (!page) {
        return err('WINDOW_NOT_FOUND', 'No web page is open to read. Open one first with browser.goto.');
      }

      try {
        const selector = input.selector ?? 'body';
        const limit = input.maxChars ?? MAX_EXTRACT_CHARS;

        const raw = await withCancellation(
          page.innerText(selector, { timeout: Math.min(ctx.timeoutMs, 15_000) }),
          ctx,
        );

        // `innerText` preserves the page's own layout whitespace, which on a
        // typical site is more than half the characters. Collapsing it is not
        // cosmetic: it is what keeps a page inside the planner's context budget.
        const text = raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

        return ok({
          ...(await readPage(page)),
          text: text.slice(0, limit),
          truncated: text.length > limit,
          characters: text.length,
        });
      } catch (cause) {
        return toBrowserError<ExtractResult>(cause);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// browser.screenshot
// ---------------------------------------------------------------------------

const ScreenshotInput = z
  .object({
    fullPage: z.boolean().optional().describe('Capture the whole page rather than just the viewport.'),
    selector: z.string().min(1).optional().describe('Capture just this element.'),
  })
  .strict();
type ScreenshotInput = z.infer<typeof ScreenshotInput>;

export interface ScreenshotResult extends PageState {
  readonly path: string;
  readonly bytes: number;
}

export function createBrowserScreenshotTool(
  session: BrowserSession,
  screenshotDir: string,
): AgentTool<ScreenshotInput, ScreenshotResult> {
  return {
    name: 'browser.screenshot',
    description:
      'Capture a picture of the open web page and save it. Use this when the user asks what a page ' +
      'looks like, or when a page cannot be understood from its text alone. Returns the file path.',
    // Spec §31 lists "take screenshot" under READ. This one writes only into the
    // agent's own cache directory, never into the user's files.
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: ScreenshotInput,
    verification: 'explicit',
    timeoutMs: 45_000,

    async execute(input, ctx): Promise<ToolResult<ScreenshotResult>> {
      const page = session.activePage();
      if (!page) {
        return err('WINDOW_NOT_FOUND', 'No web page is open to capture. Open one first with browser.goto.');
      }

      try {
        await fs.mkdir(screenshotDir, { recursive: true });
        const file = path.join(
          screenshotDir,
          `page-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
        );

        const shot =
          input.selector !== undefined
            ? page.locator(input.selector).first().screenshot({ path: file, timeout: 15_000 })
            : page.screenshot({ path: file, fullPage: input.fullPage === true, timeout: 20_000 });

        const buffer = await withCancellation(shot, ctx);

        return ok({ ...(await readPage(page)), path: file, bytes: buffer.byteLength });
      } catch (cause) {
        return toBrowserError<ScreenshotResult>(cause);
      }
    },

    async verify(_input, result): Promise<Verification> {
      if (!result.success || !result.data) return verification('not-applicable', 'Nothing was captured.');

      try {
        const stats = await fs.stat(result.data.path);
        if (!stats.isFile() || stats.size === 0) {
          return verification('failed', `No image was written to ${result.data.path}.`);
        }
        return verification(
          'verified',
          `Saved a ${Math.round(stats.size / 1024)} KB screenshot of "${result.data.title}" to ${result.data.path}.`,
        );
      } catch (cause) {
        return verification('unverified', `Could not check the saved image: ${String(cause)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// browser.close
// ---------------------------------------------------------------------------

const CloseInput = z
  .object({
    target: z
      .enum(['tab', 'browser'])
      .optional()
      .describe(
        'What to close. "tab" (the default) closes only the page the agent is driving; ' +
          '"browser" lets go of the browser without closing the user’s windows.',
      ),
  })
  .strict();
type CloseInput = z.infer<typeof CloseInput>;

export interface BrowserCloseResult {
  readonly closed: 'tab' | 'browser' | 'nothing';
}

export function createBrowserCloseTool(
  session: BrowserSession,
): AgentTool<CloseInput, BrowserCloseResult> {
  return {
    name: 'browser.close',
    description:
      'Finish with the browser: close the tab the agent opened, or release the browser connection. ' +
      'Neither closes the user’s other tabs or their browser window. Use this when a browsing task is ' +
      'done and the page is no longer needed.',
    // Only the agent's own tab, and the browser survives either way — so nothing
    // of the user's is at stake and there is nothing worth stopping them for.
    permission: 'write',
    reversibility: 'reversible',
    inputSchema: CloseInput,
    verification: 'explicit',
    timeoutMs: 20_000,

    async execute(input): Promise<ToolResult<BrowserCloseResult>> {
      try {
        return ok(await session.close(input.target ?? 'tab'));
      } catch (cause) {
        return toBrowserError<BrowserCloseResult>(cause);
      }
    },

    async verify(_input, result): Promise<Verification> {
      if (!result.success || !result.data) return verification('not-applicable', 'Nothing was closed.');

      switch (result.data.closed) {
        case 'nothing':
          return verification('not-applicable', 'There was nothing open to close.');
        case 'tab':
          return session.activePage() === undefined
            ? verification('verified', 'The page the agent had open is closed.')
            : verification('failed', 'The page is still open.');
        case 'browser':
          return session.status().connected
            ? verification('failed', 'The browser connection is still open.')
            : verification('verified', 'Let go of the browser; the user’s windows are untouched.');
      }
    },
  };
}
