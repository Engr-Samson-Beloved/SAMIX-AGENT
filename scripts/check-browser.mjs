#!/usr/bin/env node
/**
 * Live check of the browser subsystem, against a REAL browser.
 *
 * The unit suite covers the boundaries — URL schemes, permission levels, what
 * happens with no page open — using a stubbed page. It cannot cover the thing
 * that actually matters here: that a real Chrome starts with remote control
 * enabled, that Playwright attaches to it, and that `page.url()` and
 * `page.title()` come back with the truth. That is what this does.
 *
 * It WILL open a browser window on this machine. Nothing is typed, submitted or
 * sent; the pages visited are example.com and a search engine.
 *
 * Run: pnpm dev:browser
 * Exits non-zero on the first failed expectation.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'packages', 'core', 'dist', 'index.js');

if (!fs.existsSync(entry)) {
  console.error(`Core not built. Run "pnpm build:packages" first.\nExpected: ${entry}`);
  process.exit(1);
}

// `pathToFileURL`, not the bare path: Windows absolute paths look like a URL
// with a `c:` scheme to the ESM loader, which rejects them.
const { AppRegistry, BrowserSession, createToolRegistry } = await import(
  pathToFileURL(entry).href
);

const green = (s) => `[32m${s}[0m`;
const red = (s) => `[31m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ${green('✓')} ${label}${detail ? dim(` — ${detail}`) : ''}`);
  } else {
    failures += 1;
    console.log(`  ${red('✗')} ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const ctx = {
  taskId: 'check',
  stepId: 'check',
  signal: new AbortController().signal,
  timeoutMs: 45_000,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};

/** Run a tool and its verifier the way the executor does. */
async function run(registry, name, input) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`${name} is not registered`);
  const result = await tool.execute(input, ctx);
  const verified =
    tool.verification === 'intrinsic'
      ? { status: 'not-applicable', detail: 'read-only' }
      : await tool.verify(input, result, ctx);
  return { result, verified };
}

console.log('\n  SAMIX browser — live check\n');

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samix-browser-'));
const apps = new AppRegistry();
const session = new BrowserSession({
  apps,
  profileDir: path.join(cacheDir, 'browser-profile'),
});

const { registry } = createToolRegistry({
  cacheDir,
  pathPolicy: { /* unused by browser tools */ },
  statusProvider: () => ({}),
  browser: session,
  apps,
});

try {
  // --- 1. navigate -----------------------------------------------------------
  const goto = await run(registry, 'browser.goto', { url: 'https://example.com' });
  check('browser.goto succeeds', goto.result.success, goto.result.error?.message);
  check(
    'the page is verified by reading it back',
    goto.verified.status === 'verified',
    goto.verified.detail,
  );
  check(
    'page.url() reports where we landed',
    /example\.com/.test(goto.result.data?.url ?? ''),
    goto.result.data?.url,
  );
  check(
    'page.title() reports a real title',
    (goto.result.data?.title ?? '').length > 0,
    goto.result.data?.title,
  );

  console.log(dim(`\n  profile in use: ${JSON.stringify(session.status())}\n`));

  // --- 2. read the page back -------------------------------------------------
  const text = await run(registry, 'browser.extractText', {});
  check('browser.extractText returns the page text', (text.result.data?.text ?? '').length > 20);
  check(
    'the text is the page we asked for',
    /illustrative examples|Example Domain/i.test(text.result.data?.text ?? ''),
    (text.result.data?.text ?? '').slice(0, 60).replace(/\n/g, ' '),
  );

  // --- 3. search, and read the results ---------------------------------------
  const search = await run(registry, 'browser.search', { query: 'playwright cdp', limit: 5 });
  check('browser.search succeeds', search.result.success, search.result.error?.message);
  check(
    'results come back to the planner, not just to the screen',
    (search.result.data?.results.length ?? 0) > 0,
    `${search.result.data?.results.length ?? 0} results; ${search.verified.status}`,
  );
  check(
    'every result names the site it came from',
    (search.result.data?.results ?? []).every((hit) => (hit.source ?? '').includes('.')),
    (search.result.data?.results ?? []).map((hit) => hit.source).join(', '),
  );
  for (const hit of (search.result.data?.results ?? []).slice(0, 3)) {
    console.log(dim(`      · [${hit.source}] ${hit.title}`));
    console.log(dim(`        ${hit.url}`));
  }

  // --- 4. scroll -------------------------------------------------------------
  const scroll = await run(registry, 'browser.scroll', { direction: 'down' });
  check(
    'browser.scroll reports where the page ended up',
    scroll.result.success,
    `${scroll.verified.status}: ${scroll.verified.detail}`,
  );

  // --- 5. capture ------------------------------------------------------------
  const shot = await run(registry, 'browser.screenshot', {});
  check(
    'browser.screenshot writes a real image',
    shot.verified.status === 'verified',
    shot.verified.detail,
  );

  // --- 6. finish -------------------------------------------------------------
  const closed = await run(registry, 'browser.close', { target: 'tab' });
  check('browser.close closes the tab', closed.verified.status === 'verified', closed.verified.detail);

  const released = await run(registry, 'browser.close', { target: 'browser' });
  check(
    'releasing the browser leaves the user’s windows alone',
    released.result.success,
    released.verified.detail,
  );
} catch (cause) {
  failures += 1;
  console.log(`\n  ${red('✗')} threw: ${cause?.stack ?? String(cause)}`);
} finally {
  await session.dispose();
}

console.log(
  failures === 0
    ? `\n  ${green('All browser checks passed.')}\n`
    : `\n  ${red(`${failures} browser check(s) failed.`)}\n`,
);
process.exit(failures === 0 ? 0 : 1);
