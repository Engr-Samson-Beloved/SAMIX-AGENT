import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createResilientWindowAutomation,
  createSidecarWindowAutomation,
  resolveActive,
  SidecarError,
  type WindowAutomation,
  type WindowInfo,
} from '../dist/index.js';

/**
 * Window management over the sidecar (Phase 7 step 2).
 *
 * The risk in this step is not that the fast path is slow. It is that the fast
 * path is *different* — that porting four shipped tools onto a new back end
 * quietly changes which window "this window" means, or stops the agent
 * recognising its own console. So most of what is tested here is equivalence and
 * the substitution rule, not throughput.
 *
 * `pnpm check:windows` runs both back ends against the real desktop and diffs
 * them field by field. This suite covers what that cannot: the failure paths.
 */

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function win(patch: Partial<WindowInfo> & { handle: number; title: string }): WindowInfo {
  return {
    processId: 1000 + patch.handle,
    processName: 'chrome',
    isActive: false,
    isMinimized: false,
    isOwn: false,
    ...patch,
  };
}

/** A sidecar that answers from a script, without a Python process anywhere. */
function fakeSidecar(
  answers: Record<string, unknown | (() => unknown)>,
  options: { usable?: boolean; detail?: string } = {},
) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const sidecar = {
    calls,
    isUsable: () => options.usable ?? true,
    status: () => ({
      state: 'ready',
      detail: options.detail ?? 'Python 3.12.10 (venv)',
      handshake: undefined,
      respawns: 0,
      source: 'venv',
    }),
    call: (op: string, params: Record<string, unknown> = {}) => {
      calls.push({ op, params });
      const answer = answers[op];
      if (answer === undefined) {
        return Promise.reject(new SidecarError('INTERNAL_ERROR', `no answer for ${op}`));
      }
      const value = typeof answer === 'function' ? (answer as () => unknown)() : answer;
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    },
  };
  return sidecar;
}

/** The PowerShell side, as a spy. */
function fakeFallback(windows: WindowInfo[] = []) {
  const used: string[] = [];
  const automation: WindowAutomation = {
    list: () => {
      used.push('list');
      return Promise.resolve(windows);
    },
    active: () => {
      used.push('active');
      return Promise.resolve({ window: windows[0]!, substituted: false });
    },
    focus: (handle) => {
      used.push('focus');
      return Promise.resolve({ focused: true, active: windows.find((w) => w.handle === handle) });
    },
    close: () => {
      used.push('close');
      return Promise.resolve({ requested: true });
    },
    waitForClose: () => {
      used.push('waitForClose');
      return Promise.resolve(true);
    },
  };
  return { automation, used };
}

// ---------------------------------------------------------------------------

describe('the substitution rule', () => {
  // This is the rule that stops "close this window" closing the agent, so it is
  // tested directly rather than only through whichever back end is installed.
  const desktop = [
    win({ handle: 1, title: 'SAMIX', isOwn: true, isActive: true }),
    win({ handle: 2, title: 'Invoices' }),
    win({ handle: 3, title: 'Chrome' }),
  ];

  test('an ordinary foreground window is reported as-is', () => {
    const active = win({ handle: 2, title: 'Invoices', isActive: true });
    const result = resolveActive(desktop, active);
    assert.equal(result?.window.handle, 2);
    assert.equal(result?.substituted, false);
  });

  test("the agent's own foreground window yields the one behind it, flagged", () => {
    const result = resolveActive(desktop, desktop[0]);
    assert.equal(result?.window.handle, 2, 'the first window that is not ours, in z-order');
    assert.equal(
      result?.substituted,
      true,
      'silently reporting a different window as active would be a small, confident lie',
    );
  });

  test('a desktop of nothing but our own windows has no answer', () => {
    const ours = [win({ handle: 1, title: 'SAMIX', isOwn: true })];
    assert.equal(resolveActive(ours, ours[0]), undefined);
  });

  test('an unreadable foreground window still falls back to z-order', () => {
    const result = resolveActive(desktop, undefined);
    assert.equal(result?.window.handle, 2);
    assert.equal(result?.substituted, true);
  });
});

describe('sidecar-backed window automation', () => {
  const raw = {
    handle: 42,
    title: 'Invoices',
    processId: 900,
    processName: 'excel',
    isActive: true,
    isMinimized: false,
    isOwn: false,
  };

  test('list maps the wire shape onto WindowInfo', async () => {
    const uia = createSidecarWindowAutomation(fakeSidecar({ 'window.list': { windows: [raw] } }) as never);
    assert.deepEqual(await uia.list(), [
      {
        handle: 42,
        title: 'Invoices',
        processId: 900,
        processName: 'excel',
        isActive: true,
        isMinimized: false,
        isOwn: false,
      },
    ]);
  });

  test('a window with an implausible handle is dropped, not surfaced', async () => {
    const uia = createSidecarWindowAutomation(
      fakeSidecar({ 'window.list': { windows: [raw, { handle: 0 }, { handle: -3 }, null] } }) as never,
    );
    assert.equal((await uia.list()).length, 1);
  });

  test('missing fields become defaults rather than undefined', async () => {
    const uia = createSidecarWindowAutomation(
      fakeSidecar({ 'window.list': { windows: [{ handle: 7 }] } }) as never,
    );
    const [only] = await uia.list();
    assert.equal(only?.title, '');
    assert.equal(only?.processName, '');
    assert.equal(only?.isOwn, false);
  });

  test('active applies the substitution rule to what the sidecar returned', async () => {
    const ours = { ...raw, handle: 1, isOwn: true, processName: 'node' };
    const theirs = { ...raw, handle: 2, isOwn: false };
    const uia = createSidecarWindowAutomation(
      fakeSidecar({ 'window.active': { windows: [ours, theirs], active: ours } }) as never,
    );
    const result = await uia.active();
    assert.equal(result?.window.handle, 2);
    assert.equal(result?.substituted, true);
  });

  test('focus reports whether it actually took, not whether it was asked', async () => {
    const uia = createSidecarWindowAutomation(
      fakeSidecar({ 'window.focus': { focused: false, active: { ...raw, handle: 9 } } }) as never,
    );
    const result = await uia.focus(42);
    assert.equal(result.focused, false);
    assert.equal(result.active?.handle, 9, 'and says what is in front instead');
  });

  test('close carries the reason a refusal came with', async () => {
    const uia = createSidecarWindowAutomation(
      fakeSidecar({ 'window.close': { requested: false, reason: 'no-such-window' } }) as never,
    );
    assert.deepEqual(await uia.close(42), { requested: false, reason: 'no-such-window' });
  });

  test('waitForClose polls until the window is gone', async () => {
    let checks = 0;
    const uia = createSidecarWindowAutomation(
      fakeSidecar({
        'window.exists': () => ({ exists: (checks += 1) < 3 }),
      }) as never,
    );
    assert.equal(await uia.waitForClose(42), true);
    assert.equal(checks, 3, 'a graceful close is not instantaneous');
  });

  test('waitForClose gives up rather than hanging', async () => {
    const uia = createSidecarWindowAutomation(fakeSidecar({ 'window.exists': { exists: true } }) as never);
    assert.equal(await uia.waitForClose(42, 500), false);
  });
});

describe('falling back to PowerShell', () => {
  const windows = [win({ handle: 5, title: 'Slow' })];

  test('the sidecar serves the call when it works', async () => {
    const fallback = fakeFallback(windows);
    const uia = createResilientWindowAutomation({
      sidecar: fakeSidecar({ 'window.list': { windows: [] } }) as never,
      fallback: fallback.automation,
      logger,
    });
    await uia.list();
    assert.deepEqual(fallback.used, [], 'PowerShell was not touched');
    assert.equal(uia.status().path, 'sidecar');
  });

  test('a sidecar failure is answered by PowerShell, not raised', async () => {
    const fallback = fakeFallback(windows);
    const uia = createResilientWindowAutomation({
      sidecar: fakeSidecar({ 'window.list': () => new SidecarError('TIMEOUT', 'too slow') }) as never,
      fallback: fallback.automation,
      logger,
    });

    // The tool above this must see a normal answer. Degrading is the designed
    // outcome, not an error path the planner has to recover from.
    assert.deepEqual(await uia.list(), windows);
    assert.deepEqual(fallback.used, ['list']);
    assert.equal(uia.status().path, 'powershell');
    assert.equal(uia.status().everFellBack, true);
  });

  test('a fallback is not latched — the sidecar is tried again next call', async () => {
    let attempt = 0;
    const fallback = fakeFallback(windows);
    const uia = createResilientWindowAutomation({
      sidecar: fakeSidecar({
        'window.list': () =>
          (attempt += 1) === 1 ? new SidecarError('TIMEOUT', 'blip') : { windows: [] },
      }) as never,
      fallback: fallback.automation,
      logger,
    });

    await uia.list();
    assert.equal(uia.status().path, 'powershell');
    await uia.list();
    assert.equal(uia.status().path, 'sidecar', 'a transient blip must not cost the whole session');
    assert.equal(fallback.used.length, 1);
  });

  test('a degraded sidecar is not called at all', async () => {
    const sidecar = fakeSidecar({ 'window.list': { windows: [] } }, {
      usable: false,
      detail: 'exited 3 times this session',
    });
    const fallback = fakeFallback(windows);
    const uia = createResilientWindowAutomation({
      sidecar: sidecar as never,
      fallback: fallback.automation,
      logger,
    });

    await uia.list();
    assert.equal(sidecar.calls.length, 0, 'no point paying a timeout to learn what we know');
    assert.deepEqual(fallback.used, ['list']);
    assert.match(uia.status().detail, /exited 3 times/);
  });

  test('every operation has a fallback, not just list', async () => {
    const fallback = fakeFallback(windows);
    const uia = createResilientWindowAutomation({
      sidecar: fakeSidecar({}, { usable: false }) as never,
      fallback: fallback.automation,
      logger,
    });

    await uia.list();
    await uia.active();
    await uia.focus(5);
    await uia.close(5);
    await uia.waitForClose(5);
    assert.deepEqual(fallback.used, ['list', 'active', 'focus', 'close', 'waitForClose']);
  });

  test('the path change is announced once, not on every call', async () => {
    const seen: string[] = [];
    const fallback = fakeFallback(windows);
    const uia = createResilientWindowAutomation({
      sidecar: fakeSidecar({ 'window.list': { windows: [] } }) as never,
      fallback: fallback.automation,
      logger,
      onPathChange: (status) => seen.push(status.path),
    });

    await uia.list();
    await uia.list();
    await uia.list();
    assert.deepEqual(seen, ['sidecar'], '/status should not be rewritten on every window query');
  });
});
