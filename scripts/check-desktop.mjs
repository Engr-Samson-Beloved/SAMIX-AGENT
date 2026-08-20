#!/usr/bin/env node
/**
 * Live check of the desktop control sidecar, against a REAL desktop (Phase 7).
 *
 * READ-ONLY. Nothing is clicked, typed into, focused or closed. The one window
 * this touches is one it creates itself (`lib/desktop-fixture.ps1`) and disposes
 * of afterwards — never a real application, never near real user data.
 *
 * The unit suite covers everything that happens between the two processes:
 * framing, queueing, timeouts, crash recovery, degradation. It cannot cover the
 * layer underneath, which is where this phase's real risks live — that DPI
 * awareness is declared before UI Automation loads, that COM enters a
 * single-threaded apartment, that a cached tree walk returns the controls a
 * person can actually see, that the bounds are honoured, and that the structure
 * hash is stable enough to be worth guarding a click with.
 *
 * Run: pnpm check:desktop [--idle <seconds>]
 *
 * `--idle` measures processor time and working set while the sidecar sits doing
 * nothing. The design claims zero idle cost — no polling, no timers, no event
 * subscriptions — and that is a claim worth measuring rather than asserting.
 * Phase 7 §8 asks for five minutes: `pnpm check:desktop --idle 300`.
 *
 * Exits non-zero on the first failed expectation.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'packages', 'core', 'dist', 'index.js');
const fixtureScript = path.join(root, 'scripts', 'lib', 'desktop-fixture.ps1');
const FIXTURE_TITLE = 'SAMIX live check - safe to close';

if (!fs.existsSync(entry)) {
  console.error(`Core not built. Run "pnpm build:packages" first.\nExpected: ${entry}`);
  process.exit(1);
}

// `listWindows` is the existing PowerShell path. Used here only to find the
// fixture's handle: the sidecar cannot enumerate windows until step 2, and
// waiting for the fixture to take *foreground* is not something a check should
// depend on — the terminal running it usually keeps focus.
const { DesktopSidecar, SnapshotSchema, listWindows } = await import(pathToFileURL(entry).href);
const { defaultConfig } = await import(
  pathToFileURL(path.join(root, 'packages', 'shared', 'dist', 'index.js')).href
);

const green = (s) => `[32m${s}[0m`;
const red = (s) => `[31m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`  ${green('✓')} ${label}${detail ? dim(` — ${detail}`) : ''}`);
  else {
    failures += 1;
    console.log(`  ${red('✗')} ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const idleFlag = process.argv.indexOf('--idle');
const idleSeconds = idleFlag === -1 ? 0 : Number(process.argv[idleFlag + 1] ?? 60);

console.log('\n  SAMIX desktop sidecar — live check\n');

if (process.platform !== 'win32') {
  console.log(`  ${red('This check only runs on Windows.')}\n`);
  process.exit(1);
}

/** Processor seconds and working set for a pid, straight from the OS. */
function sampleProcess(pid) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
        `if ($p) { "$($p.CPU) $($p.WorkingSet64)" }`,
    ],
    { encoding: 'utf8' },
  );
  const [cpu, rss] = (result.stdout || '').trim().split(/\s+/);
  if (!cpu) return undefined;
  return { cpuSeconds: Number(cpu), rssBytes: Number(rss) };
}

const config = { ...defaultConfig().automation.desktop };
if (idleSeconds > 0) {
  // Idle shutdown defaults to five minutes, which is exactly the idle window
  // Phase 7 §8 asks to measure — so the sidecar exits partway through and the
  // measurement reports "the process is gone" rather than a CPU figure. Hold it
  // open for longer than the measurement; the shutdown path itself is covered by
  // the unit suite.
  config.idleShutdownMs = (idleSeconds + 120) * 1000;
}
const sidecar = new DesktopSidecar({
  config: () => config,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  ownPids: () => [process.pid, process.ppid].filter(Boolean),
});

let fixture;
try {
  // --- handshake ----------------------------------------------------------
  const started = Date.now();
  const windows = await sidecar.call('snapshot', {}, 20_000).catch((error) => ({ error }));
  const warmStartMs = Date.now() - started;

  const status = sidecar.status();
  if (status.state !== 'ready') {
    console.log(`  ${red('✗')} The sidecar did not start: ${status.detail}`);
    console.log(`\n    Run ${green('pnpm setup:desktop')} to build its Python environment.`);
    console.log(`    The agent works without it; window tools fall back to PowerShell.\n`);
    process.exit(1);
  }
  const hs = status.handshake;

  check('sidecar starts and answers', true, `${warmStartMs}ms cold, via ${status.source}`);
  check(
    'DPI awareness is per-monitor-v2',
    hs.dpiAwareness === 'per-monitor-v2',
    // Anything weaker and every coordinate we report is wrong on a second
    // monitor with a different scale factor — plausibly wrong, which is worse.
    hs.dpiAwareness,
  );
  check('COM is in a single-threaded apartment', hs.com.startsWith('sta'), hs.com);
  check('UI Automation is reachable', hs.uia === true, hs.uiaDetail);
  check('architecture matches the host', hs.architecture.length > 0, hs.architecture);
  check('a snapshot of the focused window came back', !windows.error, windows.error?.message);

  // --- a window we own ----------------------------------------------------
  fixture = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureScript],
    { stdio: 'ignore', windowsHide: false },
  );

  let target;
  for (let attempt = 0; attempt < 10 && !target; attempt += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const open = await listWindows().catch(() => []);
    target = open.find((w) => w.title === FIXTURE_TITLE);
  }

  if (!target) {
    check('the fixture window appeared', false, 'it never opened');
  } else {
    const handle = target.handle;
    check('the fixture window appeared', true, `handle ${handle}`);
    const snap = SnapshotSchema.parse(await sidecar.call('snapshot', { handle }, 10_000));

    console.log(`\n${dim(snap.text.replace(/^/gm, '    '))}\n`);

    const named = (name) => snap.elements.find((e) => e.name === name);
    check('the tree walk finds a button', named('Send')?.role === 'Button');
    check(
      'a writable field reports its value and its pattern',
      named('Message')?.value === 'hello' && named('Message')?.patterns.includes('value'),
      JSON.stringify(named('Message')?.patterns ?? []),
    );
    check(
      'a checkbox reports its toggle state',
      named('Remember me')?.toggle === 'off',
      String(named('Remember me')?.toggle),
    );
    check('static text is kept', named('Status: ready')?.role === 'Text');
    check('a named group is kept as a landmark', named('Options')?.role === 'Group');
    check(
      'nesting is reflected in depth',
      (named('Plain text')?.depth ?? 0) > (named('Options')?.depth ?? 0),
    );

    const bounds = named('Send')?.bounds ?? [0, 0, 0, 0];
    check(
      'bounds are physical pixels with a positive size',
      // The bug this catches: the UIA property array is [left, top, width,
      // height], not a RECT. Read as a RECT, every control right of the origin
      // gets a negative size and is silently pruned as invisible.
      bounds[2] > 0 && bounds[3] > 0,
      `[${bounds.join(', ')}]`,
    );

    const again = await sidecar.call('snapshot', { handle }, 10_000);
    check('the structure hash is stable across reads', again.tree === snap.tree, snap.tree);
    check('an unchanged window is not reported as truncated', snap.truncated === false);

    // --- bounds, and truncation as a result rather than an error ----------
    const capped = await sidecar.call('snapshot', { handle, maxNodes: 3 }, 10_000);
    check(
      'maxNodes truncates and says so',
      capped.elements.length === 3 && capped.truncated && capped.truncatedReason === 'nodes',
      `${capped.elements.length} nodes, reason ${capped.truncatedReason}`,
    );

    const shallow = await sidecar.call('snapshot', { handle, maxDepth: 1 }, 10_000);
    check(
      'maxDepth prunes the branch but keeps walking siblings',
      shallow.truncatedReason === 'depth',
      `${shallow.elements.length} nodes at depth 1`,
    );

    const rushed = await sidecar.call('snapshot', { handle, timeoutMs: 1 }, 10_000);
    check('a wall-clock stop is a result, not a failure', rushed.truncated === true, 'truncated: true');

    // --- the refusal that matters -----------------------------------------
    const excluded = await sidecar
      .call('snapshot', { handle, excludePids: [target.processId] }, 10_000)
      .then(() => undefined)
      .catch((error) => error);
    check(
      'naming a handle does not defeat the own-window exclusion',
      excluded?.code === 'WINDOW_NOT_FOUND',
      excluded?.code ?? 'the snapshot succeeded',
    );

    // --- latency ----------------------------------------------------------
    const runs = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = Date.now();
      await sidecar.call('snapshot', { handle }, 10_000);
      runs.push(Date.now() - t0);
    }
    runs.sort((a, b) => a - b);
    check('warm snapshots stay well inside the budget', runs[2] < config.snapshotTimeoutMs,
      `median ${runs[2]}ms of ${config.snapshotTimeoutMs}ms (${runs.join(', ')})`);
  }

  // --- idle cost ----------------------------------------------------------
  const first = sampleProcess(hs.pid);
  check('the sidecar process is measurable', first !== undefined, first && `${(first.rssBytes / 1e6).toFixed(1)} MB`);

  if (first && idleSeconds > 0) {
    console.log(`\n  ${dim(`measuring ${idleSeconds}s of idle…`)}`);
    await new Promise((r) => setTimeout(r, idleSeconds * 1000));
    const second = sampleProcess(hs.pid);
    if (!second) {
      check('the sidecar survived the idle window', false, 'the process is gone');
    } else {
      const usedMs = (second.cpuSeconds - first.cpuSeconds) * 1000;
      const percent = (usedMs / (idleSeconds * 1000)) * 100;
      check(
        'idle CPU is zero',
        percent < 0.05,
        `${percent.toFixed(3)}% over ${idleSeconds}s (${usedMs.toFixed(0)}ms of CPU)`,
      );
      check(
        'warm memory stays under 80 MB',
        second.rssBytes < 80e6,
        `${(second.rssBytes / 1e6).toFixed(1)} MB`,
      );
    }
  } else if (first) {
    console.log(`  ${dim('idle cost not measured; pass --idle 300 for the five-minute run')}`);
  }
} catch (error) {
  failures += 1;
  console.log(`\n  ${red('✗')} ${error?.stack ?? error}`);
} finally {
  fixture?.kill();
  await sidecar.dispose();
}

console.log(
  failures === 0
    ? `\n  ${green('All desktop checks passed.')}\n`
    : `\n  ${red(`${failures} check(s) failed.`)}\n`,
);
process.exit(failures === 0 ? 0 : 1);
