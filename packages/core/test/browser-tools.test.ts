import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createBrowserClickTool,
  createBrowserCloseTool,
  createBrowserExtractTextTool,
  createBrowserGotoTool,
  createBrowserScreenshotTool,
  createBrowserScrollTool,
  createBrowserSearchTool,
  parseWebUrl,
  type BrowserSession,
} from '../dist/index.js';

/**
 * Phase 6 browser tools.
 *
 * Nothing here starts a browser. What is tested is what a real browser cannot
 * tell you: the URL scheme boundary, the permission classification, and the
 * behaviour when there is no page to act on. Driving an actual Chrome belongs in
 * `pnpm dev:browser`, against the real machine.
 */

const ctx = {
  taskId: 'task_test',
  stepId: 'step_test',
  signal: new AbortController().signal,
  timeoutMs: 5_000,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};

/**
 * A session with nothing open.
 *
 * Structural rather than a real `BrowserSession`: the tools use four methods of
 * it, and constructing the real one would put a Chrome launch inside a unit
 * test.
 */
function emptySession(overrides: Partial<Record<string, unknown>> = {}): BrowserSession {
  return {
    activePage: () => undefined,
    page: () => Promise.reject(new Error('no browser in tests')),
    status: () => ({ connected: false }),
    close: () => Promise.resolve({ closed: 'nothing' as const }),
    ...overrides,
  } as unknown as BrowserSession;
}

/** A session whose page records what it was told to do. */
function fakePage(page: Record<string, unknown>): BrowserSession {
  const full = {
    url: () => 'https://example.com/',
    title: () => Promise.resolve('Example'),
    goto: () => Promise.resolve(null),
    waitForLoadState: () => Promise.resolve(),
    waitForSelector: () => Promise.resolve(null),
    waitForTimeout: () => Promise.resolve(),
    isClosed: () => false,
    $$eval: () => Promise.resolve([]),
    ...page,
  };
  return {
    activePage: () => full,
    page: () => Promise.resolve(full),
    status: () => ({ connected: true }),
    close: () => Promise.resolve({ closed: 'tab' as const }),
  } as unknown as BrowserSession;
}

// ---------------------------------------------------------------------------

describe('URLs the browser may be given', () => {
  const cases: Array<[string, boolean, string]> = [
    ['https://example.com', true, 'plain https'],
    ['http://example.com/path?q=1', true, 'http with a query'],
    ['example.com', true, 'a bare host becomes https'],
    ['file:///C:/Users/me/.ssh/id_rsa', false, 'file: would bypass PathPolicy entirely'],
    ['javascript:alert(1)', false, 'javascript: is script execution'],
    ['data:text/html,<script>alert(1)</script>', false, 'data: is script execution'],
    ['ftp://example.com', false, 'not a web page'],
  ];

  for (const [url, allowed, why] of cases) {
    test(`${allowed ? 'accepts' : 'rejects'} ${url} — ${why}`, () => {
      assert.equal(parseWebUrl(url) !== undefined, allowed);
    });
  }

  test('a rejected scheme never reaches the browser at all', async () => {
    // The check runs before the session is touched, so a hostile URL cannot even
    // cause a browser to start. `emptySession` would throw if it were used.
    const tool = createBrowserGotoTool(emptySession());

    const result = await tool.execute({ url: 'file:///C:/Windows/win.ini' }, ctx);

    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'INVALID_INPUT');
    assert.equal(result.error?.recoverable, false);
  });
});

describe('permission levels', () => {
  const session = emptySession();

  test('fetching and observing is READ, so CONTROLLED mode does not interrupt', () => {
    // The point of the reclassification: a search reveals the query to a search
    // engine, which is exactly what the user asked for. Confirming it trains
    // people to approve without reading, which costs more than it buys.
    for (const tool of [
      createBrowserGotoTool(session),
      createBrowserSearchTool(session),
      createBrowserScrollTool(session),
      createBrowserExtractTextTool(session),
      createBrowserScreenshotTool(session, 'C:\\temp'),
    ]) {
      assert.equal(tool.permission, 'read', `${tool.name} should be read`);
    }
  });

  test('clicking is not READ, because a click can submit or send', () => {
    const tool = createBrowserClickTool(session);

    assert.equal(tool.permission, 'write');
    // `unknown` reversibility is what makes CONTROLLED mode confirm it: nothing
    // in the arguments distinguishes "Next page" from "Place order".
    assert.equal(tool.reversibility, 'unknown');
    assert.match(tool.describeEffect!({ text: 'Place order' }), /Place order/);
  });

  test('closing the agent’s own tab needs no permission ceremony', () => {
    const tool = createBrowserCloseTool(session);

    assert.equal(tool.permission, 'write');
    assert.equal(tool.reversibility, 'reversible');
  });
});

describe('acting with no page open', () => {
  test('reports that nothing is open rather than throwing', async () => {
    const session = emptySession();

    for (const [tool, input] of [
      [createBrowserScrollTool(session), { direction: 'down' as const }],
      [createBrowserExtractTextTool(session), {}],
      [createBrowserClickTool(session), { text: 'Next' }],
      [createBrowserScreenshotTool(session, 'C:\\temp'), {}],
    ] as const) {
      const result = await (tool as { execute: (i: unknown, c: unknown) => Promise<{ success: boolean; error?: { code: string } }> }).execute(input, ctx);

      assert.equal(result.success, false);
      assert.equal(result.error?.code, 'WINDOW_NOT_FOUND', `${(tool as { name: string }).name}`);
    }
  });
});

describe('search', () => {
  test('encodes the query instead of interpolating it into the URL', async () => {
    // A query containing & or # would otherwise silently become extra URL
    // parameters, and the user would be shown results for a different search.
    const visited: string[] = [];
    const session = fakePage({
      goto: (url: string) => {
        visited.push(url);
        return Promise.resolve(null);
      },
    });

    await createBrowserSearchTool(session).execute({ query: 'cats & dogs #1' }, ctx);

    assert.equal(visited.length, 1);
    assert.match(visited[0]!, /q=cats%20%26%20dogs%20%231|q=cats\+%26\+dogs\+%231/);
    assert.doesNotMatch(visited[0]!, /q=cats & dogs/);
  });

  test('a results page with no readable results is not reported as verified', async () => {
    // A consent interstitial loads perfectly well and contains no results. The
    // navigation is real, but answering from results that were never read would
    // be the exact failure verification exists to prevent.
    const session = fakePage({ $$eval: () => Promise.resolve([]) });
    const tool = createBrowserSearchTool(session);

    const result = await tool.execute({ query: 'anything' }, ctx);
    const verified = await tool.verify!({ query: 'anything' }, result, ctx);

    assert.equal(result.success, true);
    assert.deepEqual(result.data?.results, []);
    assert.equal(verified.status, 'unverified');
    assert.match(verified.detail, /consent|no results could be read/i);
  });

  test('reads result titles and links back, deduplicated by destination', async () => {
    const session = fakePage({
      $$eval: () =>
        Promise.resolve([
          { title: 'Next.js Docs', url: 'https://nextjs.org/docs' },
          { title: 'Next.js Docs', url: 'https://nextjs.org/docs' },
          { title: 'Learn Next.js', url: 'https://nextjs.org/learn' },
        ]),
    });

    const result = await createBrowserSearchTool(session).execute({ query: 'next.js' }, ctx);

    // Search engines wrap one result in several anchors; without the dedupe the
    // planner is handed the same page three times and thinks it found three.
    assert.deepEqual(result.data?.results, [
      { title: 'Next.js Docs', url: 'https://nextjs.org/docs', source: 'nextjs.org' },
      { title: 'Learn Next.js', url: 'https://nextjs.org/learn', source: 'nextjs.org' },
    ]);
  });

  test('recovers the real destination from a tracking redirect', async () => {
    const session = fakePage({
      $$eval: () =>
        Promise.resolve([
          {
            title: 'CDPSession',
            url: 'https://www.google.com/url?sa=t&url=https%3A%2F%2Fplaywright.dev%2Fdocs',
          },
        ]),
    });

    const result = await createBrowserSearchTool(session).execute({ query: 'cdp' }, ctx);

    assert.deepEqual(result.data?.results, [
      { title: 'CDPSession', url: 'https://playwright.dev/docs', source: 'playwright.dev' },
    ]);
  });

  test('falls back to the visible site name when the redirect cannot be decoded', async () => {
    // Google's `/goto?url=<blob>` form is not decodable by anyone outside
    // Google. Without the `cite` fallback the planner cannot tell official
    // documentation from a content farm, which is most of what a link is for.
    const session = fakePage({
      $$eval: () =>
        Promise.resolve([
          {
            title: 'CDPSession',
            url: 'https://www.google.com/goto?url=CAESaAHuR6pNMlPv5KAJhjYD',
            cite: 'https://playwright.dev › docs › api › class-cdpsession',
          },
        ]),
    });

    const result = await createBrowserSearchTool(session).execute({ query: 'cdp' }, ctx);

    assert.equal(result.data?.results[0]?.source, 'playwright.dev');
    // The tracking URL is kept, because browser.goto can still follow it.
    assert.match(result.data?.results[0]?.url ?? '', /google\.com\/goto/);
  });
});

describe('navigation verification', () => {
  test('states the page that was actually reached, not the one requested', async () => {
    const session = fakePage({
      url: () => 'https://accounts.example.com/login',
      title: () => Promise.resolve('Sign in'),
    });
    const tool = createBrowserGotoTool(session);
    const input = { url: 'https://app.example.com/dashboard' };

    const verified = await tool.verify!(input, await tool.execute(input, ctx), ctx);

    // A redirect to a login wall is the single most important thing to report:
    // the user asked for their dashboard and is looking at a sign-in page.
    assert.equal(verified.status, 'verified');
    assert.match(verified.detail, /accounts\.example\.com/);
    assert.match(verified.detail, /Sign in/);
    assert.match(verified.detail, /redirected/);
  });

  test('a blank tab is a failure, not a success', async () => {
    const session = fakePage({ url: () => 'about:blank', title: () => Promise.resolve('') });
    const tool = createBrowserGotoTool(session);
    const input = { url: 'https://example.com' };

    const verified = await tool.verify!(input, await tool.execute(input, ctx), ctx);

    assert.equal(verified.status, 'failed');
  });
});
