import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DesktopContext,
  PermissionEngine,
  dangerousWordIn,
  type PermissionQuery,
} from '../dist/index.js';
import type { AgentMode } from '@samix/shared';

/**
 * The application-scope axis and the hard floors (Phase 7 §5).
 *
 * This is the file to read if you want to know what the agent will and will not
 * do without asking. Every case below is a sentence from the brief turned into
 * an assertion, and the ordering rules — that a floor cannot be pierced by a
 * mode, by config, or by "approve the rest of this task" — are tested as
 * properties rather than as individual cases, because that is what they are.
 */

const engine = new PermissionEngine();
const MODES: AgentMode[] = ['safe', 'controlled', 'autonomous', 'developer'];

const desktopTool = {
  name: 'desktop.invoke',
  permission: 'write' as const,
  reversibility: 'reversible' as const,
};

const trusted = { trustedApplications: ['Code', 'chrome', 'explorer', 'notepad'] };

function evaluate(patch: Partial<PermissionQuery> = {}) {
  return engine.evaluate({
    tool: desktopTool,
    mode: 'controlled',
    automation: { alwaysConfirm: ['external', 'destructive', 'system'] },
    security: trusted,
    ...patch,
  } as PermissionQuery);
}

// ---------------------------------------------------------------------------

describe('the application-scope axis', () => {
  test('a trusted application runs without a prompt in CONTROLLED', () => {
    const decision = evaluate({ target: { application: 'notepad', elementName: 'Bold' } });
    assert.equal(decision.effect, 'allow');
  });

  test('an untrusted application asks first', () => {
    const decision = evaluate({ target: { application: 'SomeBankApp', elementName: 'Bold' } });
    assert.equal(decision.effect, 'confirm');
    assert.equal(decision.rule, 'app-trust:untrusted');
    assert.match(decision.reason, /SomeBankApp/);
  });

  test('an application we could not identify asks first', () => {
    // Strictly less information than an untrusted name, so it cannot be the
    // safer case. This is what an expired or missing snapshot produces.
    const decision = evaluate({ target: {} });
    assert.equal(decision.effect, 'confirm');
    assert.equal(decision.rule, 'app-trust:unknown');
  });

  test('trust is matched case-insensitively, with or without .exe', () => {
    for (const name of ['Notepad', 'NOTEPAD', 'notepad.exe', 'Chrome']) {
      assert.equal(evaluate({ target: { application: name } }).effect, 'allow', name);
    }
  });

  test('an empty trust list trusts nothing', () => {
    const decision = evaluate({
      target: { application: 'notepad' },
      security: { trustedApplications: [] },
    });
    assert.equal(decision.effect, 'confirm');
  });

  test('trust cannot turn a confirm into an allow', () => {
    // Trust only avoids a tightening; it never widens. A destructive tool in a
    // trusted application still confirms.
    const decision = engine.evaluate({
      tool: { name: 'x.y', permission: 'destructive', reversibility: 'reversible' },
      mode: 'controlled',
      automation: { alwaysConfirm: [] },
      security: trusted,
      target: { application: 'notepad' },
    } as PermissionQuery);
    assert.equal(decision.effect, 'confirm');
  });

  test('tools with no target are untouched by any of this', () => {
    // The overwhelming majority of tools. A file copy has no application scope,
    // and adding one must not have changed its behaviour.
    const decision = engine.evaluate({
      tool: { name: 'filesystem.copy', permission: 'write', reversibility: 'reversible' },
      mode: 'controlled',
      automation: { alwaysConfirm: [] },
    } as PermissionQuery);
    assert.equal(decision.effect, 'allow');
    assert.equal(decision.rule, 'base:write/controlled');
  });
});

describe('the dangerous-element floor', () => {
  const DANGEROUS = [
    'Send',
    'Send to all',
    'Resend invitation',
    'Delete',
    'Delete all messages',
    'Remove account',
    'Pay now',
    'Payment',
    'Confirm order',
    'Submit',
    'Purchase',
    'Discard changes',
    'Transfer funds',
  ];

  test('every dangerous word is recognised, wherever it sits in the name', () => {
    for (const name of DANGEROUS) {
      assert.notEqual(dangerousWordIn(name), undefined, name);
    }
  });

  test('ordinary controls are not caught', () => {
    for (const name of ['Bold', 'Save', 'Open', 'Cancel', 'Close', 'Search', 'Reply', 'New tab']) {
      assert.equal(dangerousWordIn(name), undefined, name);
    }
  });

  test('it confirms in EVERY mode, including autonomous', () => {
    for (const mode of MODES) {
      const decision = evaluate({
        mode,
        target: { application: 'notepad', elementName: 'Send to all' },
      });
      if (mode === 'safe') {
        // SAFE refuses writes outright, which is stricter still.
        assert.equal(decision.effect, 'deny', mode);
        continue;
      }
      assert.equal(decision.effect, 'confirm', mode);
      assert.equal(decision.rule, 'floor:dangerous-element', mode);
    }
  });

  test('it survives a trusted application', () => {
    const decision = evaluate({
      target: { application: 'notepad', elementName: 'Delete everything' },
    });
    assert.equal(decision.effect, 'confirm');
    assert.equal(decision.rule, 'floor:dangerous-element');
  });

  test('it survives "approve the rest of this task"', () => {
    // The answer a user gives once and then stops reading. This is exactly the
    // action that must still stop them.
    const decision = evaluate({
      taskApproved: true,
      target: { application: 'notepad', elementName: 'Transfer funds' },
    });
    assert.equal(decision.effect, 'confirm');
    assert.equal(decision.rule, 'floor:dangerous-element');
  });

  test('the prompt quotes the element verbatim', () => {
    const decision = evaluate({
      target: { application: 'notepad', elementName: 'Send to everyone in Marketing' },
    });
    assert.match(decision.reason, /"Send to everyone in Marketing"/);
    assert.match(decision.reason, /SEND/);
  });

  test('a harmless element in a trusted application still runs freely', () => {
    const decision = evaluate({ target: { application: 'notepad', elementName: 'Bold (Ctrl+B)' } });
    assert.equal(decision.effect, 'allow');
  });
});

describe('raw coordinates', () => {
  test('always confirm, in every mode', () => {
    for (const mode of MODES.filter((m) => m !== 'safe')) {
      const decision = evaluate({ mode, target: { application: 'notepad', rawCoordinates: true } });
      assert.equal(decision.effect, 'confirm', mode);
      assert.equal(decision.rule, 'floor:raw-coordinates', mode);
    }
  });

  test('and survive a per-task approval', () => {
    const decision = evaluate({
      taskApproved: true,
      target: { application: 'notepad', rawCoordinates: true },
    });
    assert.equal(decision.effect, 'confirm');
  });
});

describe("the agent's own window", () => {
  test('is refused, not confirmed, in every mode', () => {
    for (const mode of MODES) {
      const decision = evaluate({ mode, target: { application: 'node', ownWindow: true } });
      assert.equal(decision.effect, 'deny', mode);
      assert.equal(decision.rule, 'floor:own-window', mode);
    }
  });

  test('a per-task approval does not reach it', () => {
    const decision = evaluate({ taskApproved: true, target: { ownWindow: true } });
    assert.equal(decision.effect, 'deny');
  });

  test('nor does a read-level tool', () => {
    const decision = engine.evaluate({
      tool: { name: 'desktop.snapshot', permission: 'read', reversibility: 'reversible' },
      mode: 'autonomous',
      automation: { alwaysConfirm: [] },
      target: { ownWindow: true },
    } as PermissionQuery);
    assert.equal(decision.effect, 'deny');
  });
});

describe('nothing was weakened to make this fit', () => {
  test('SAFE mode is still read-only', () => {
    const decision = evaluate({ mode: 'safe', target: { application: 'notepad' } });
    assert.equal(decision.effect, 'deny');
  });

  test('a system-level tool still confirms even in a trusted application', () => {
    const decision = engine.evaluate({
      tool: { name: 'x.y', permission: 'system', reversibility: 'reversible' },
      mode: 'autonomous',
      automation: { alwaysConfirm: [] },
      security: trusted,
      target: { application: 'notepad' },
    } as PermissionQuery);
    assert.equal(decision.effect, 'confirm');
  });

  test('an irreversible write still confirms in a trusted application', () => {
    const decision = engine.evaluate({
      tool: { name: 'x.y', permission: 'write', reversibility: 'irreversible' },
      mode: 'controlled',
      automation: { alwaysConfirm: [] },
      security: trusted,
      target: { application: 'notepad' },
    } as PermissionQuery);
    assert.equal(decision.effect, 'confirm');
  });

  test('reads are still free', () => {
    const decision = engine.evaluate({
      tool: { name: 'desktop.snapshot', permission: 'read', reversibility: 'reversible' },
      mode: 'controlled',
      automation: { alwaysConfirm: [] },
      security: trusted,
      target: { application: 'SomethingUntrusted' },
    } as PermissionQuery);
    assert.equal(decision.effect, 'allow', 'reading a window transmits nothing');
  });
});

describe('DesktopContext answers describeTarget synchronously', () => {
  const snapshot = {
    window: {
      handle: 42,
      title: 'Invoices - Notepad',
      processName: 'notepad',
      processId: 900,
      bounds: [0, 0, 800, 600] as [number, number, number, number],
      isOwn: false,
    },
    tree: 'abc12345',
    elements: [
      {
        ref: 1,
        depth: 0,
        role: 'Button',
        name: 'Send to all',
        value: null,
        automationId: '',
        runtimeId: '42.1',
        nativeHandle: 0,
        bounds: [0, 0, 10, 10] as [number, number, number, number],
        enabled: true,
        patterns: ['invoke'],
        toggle: null,
      },
    ],
  };

  test('a remembered window yields application and element name', () => {
    const context = new DesktopContext();
    context.remember(snapshot);
    assert.deepEqual(context.describe(42, 1), {
      application: 'notepad',
      elementName: 'Send to all',
    });
  });

  test('an unknown window yields an empty target, which confirms', () => {
    const context = new DesktopContext();
    const target = context.describe(999, 1);
    assert.deepEqual(target, {});
    assert.equal(evaluate({ target }).effect, 'confirm');
  });

  test('a remembered window with an unknown ref still names the application', () => {
    const context = new DesktopContext();
    context.remember(snapshot);
    assert.deepEqual(context.describe(42, 77), { application: 'notepad' });
  });

  test('a stale memory is not used to answer a security question', () => {
    let now = 1_000_000;
    const context = new DesktopContext(() => now);
    context.remember(snapshot);
    assert.equal(context.describe(42, 1).application, 'notepad');

    now += 5 * 60_000;
    assert.deepEqual(context.describe(42, 1), {}, 'a five-minute-old view is not evidence');
  });

  test("the agent's own window is reported as such", () => {
    const context = new DesktopContext();
    context.remember({ ...snapshot, window: { ...snapshot.window, isOwn: true } });
    assert.equal(context.describe(42, 1).ownWindow, true);
    assert.equal(evaluate({ target: context.describe(42, 1) }).effect, 'deny');
  });

  test('with no handle it uses the most recent window', () => {
    const context = new DesktopContext();
    context.remember(snapshot);
    assert.equal(context.describe(undefined, 1).elementName, 'Send to all');
  });
});
