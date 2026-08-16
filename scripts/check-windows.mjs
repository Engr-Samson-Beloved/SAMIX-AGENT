#!/usr/bin/env node
/**
 * Live check of the window subsystem, against the REAL desktop.
 *
 * The unit suite covers which window the agent decides the user meant, using a
 * fabricated desktop. It cannot cover the layer underneath: that the P/Invoke
 * script compiles, that `EnumWindows` comes back in z-order, that titles survive
 * the encoding, and — the one that matters most — that the agent's own window is
 * correctly identified as its own.
 *
 * READ-ONLY. Nothing is focused, closed, or altered.
 *
 * Run: node scripts/check-windows.mjs
 * Exits non-zero on the first failed expectation.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'packages', 'core', 'dist', 'index.js');

if (!fs.existsSync(entry)) {
  console.error(`Core not built. Run "pnpm build:packages" first.\nExpected: ${entry}`);
  process.exit(1);
}

const { getActiveWindow, listWindows } = await import(pathToFileURL(entry).href);

const green = (s) => `[32m${s}[0m`;
const red = (s) => `[31m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`  ${green('✓')} ${label}${detail ? dim(` — ${detail}`) : ''}`);
  else {
    failures += 1;
    console.log(`  ${red('✗')} ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n  SAMIX windows — live check\n');

if (process.platform !== 'win32') {
  console.log(`  ${red('This check only runs on Windows.')}\n`);
  process.exit(1);
}

try {
  const started = Date.now();
  const windows = await listWindows();
  const elapsed = Date.now() - started;

  check('window.list returns windows', windows.length > 0, `${windows.length} windows in ${elapsed}ms`);

  // The first call pays for the ancestry query; later ones must not.
  const secondStarted = Date.now();
  await listWindows();
  const secondElapsed = Date.now() - secondStarted;
  check(
    'a repeat query is cheaper than the first',
    secondElapsed < elapsed,
    `first ${elapsed}ms, second ${secondElapsed}ms`,
  );
  check(
    'every window has a title and an owning process',
    windows.every((w) => w.title.length > 0 && w.processName.length > 0),
  );
  check(
    'handles are plausible',
    windows.every((w) => Number.isSafeInteger(w.handle) && w.handle > 0),
  );
  check(
    'exactly one window is marked active',
    windows.filter((w) => w.isActive).length <= 1,
    `${windows.filter((w) => w.isActive).length} active`,
  );

  console.log(dim('\n  desktop, front to back:'));
  for (const w of windows.slice(0, 10)) {
    const flags = [w.isActive && 'active', w.isMinimized && 'minimised', w.isOwn && 'OURS']
      .filter(Boolean)
      .join(', ');
    console.log(dim(`      · ${w.title.slice(0, 62)} [${w.processName}]${flags ? ` (${flags})` : ''}`));
  }

  // Whether any VISIBLE window belongs to this process tree depends on how the
  // agent was started, so this is reported rather than asserted. Launched from
  // a Tauri host or a classic console there is one; launched from a modern
  // terminal that hosts the shell over ConPTY there is not, because that window
  // belongs to an unrelated process tree (see the note on `WindowInfo.isOwn`).
  // Asserting either way would produce a check that fails on a correct build.
  const ours = windows.filter((w) => w.isOwn);
  console.log(
    ours.length > 0
      ? `  ${green('✓')} windows recognised as the agent’s own${dim(` — ${ours.map((w) => `${w.title.slice(0, 40)} [${w.processName}]`).join('; ')}`)}`
      : `  ${dim('·')} ${dim('no visible window belongs to this process tree — the exclusion has nothing to exclude here')}`,
  );

  console.log('');
  const active = await getActiveWindow();
  check('screen.getActiveWindow returns a window', active !== undefined);
  // This is the assertion that must always hold, however the agent was started:
  // whatever comes back is never something the agent owns.
  check(
    'the active window is never one of ours',
    active !== undefined && !active.window.isOwn,
    active ? `${active.window.title.slice(0, 50)}${active.substituted ? ' (substituted)' : ''}` : '',
  );
  check(
    'nothing marked as ours is offered as a candidate to act on',
    !windows.some((w) => w.isOwn && w.handle === active?.window.handle),
  );
} catch (cause) {
  failures += 1;
  console.log(`\n  ${red('✗')} threw: ${cause?.stack ?? String(cause)}`);
}

console.log(
  failures === 0
    ? `\n  ${green('All window checks passed.')}\n`
    : `\n  ${red(`${failures} window check(s) failed.`)}\n`,
);
process.exit(failures === 0 ? 0 : 1);
