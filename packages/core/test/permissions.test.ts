import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMode, PermissionLevel, Reversibility } from '@samix/shared';
import { PermissionEngine } from '../dist/index.js';

/**
 * The permission matrix is the product's safety story (spec §31, §32, §55).
 * These tests assert the policy exhaustively, so a future edit that quietly
 * loosens a rule cannot pass CI.
 */

const engine = new PermissionEngine();
const DEFAULT_ALWAYS_CONFIRM: PermissionLevel[] = ['external', 'destructive', 'system'];

function decide(
  permission: PermissionLevel,
  mode: AgentMode,
  options: {
    reversibility?: Reversibility;
    alwaysConfirm?: PermissionLevel[];
    taskApproved?: boolean;
  } = {},
) {
  return engine.evaluate({
    tool: {
      name: 'test.tool',
      permission,
      reversibility: options.reversibility ?? 'reversible',
    },
    mode,
    automation: { alwaysConfirm: options.alwaysConfirm ?? DEFAULT_ALWAYS_CONFIRM },
    ...(options.taskApproved !== undefined ? { taskApproved: options.taskApproved } : {}),
  });
}

const ALL_MODES: AgentMode[] = ['safe', 'controlled', 'autonomous', 'developer'];

describe('SAFE mode', () => {
  it('permits reads', () => {
    assert.equal(decide('read', 'safe').effect, 'allow');
  });

  it('denies every level above read', () => {
    for (const level of ['write', 'external', 'destructive', 'system'] as PermissionLevel[]) {
      assert.equal(decide(level, 'safe').effect, 'deny', `${level} must be denied in SAFE`);
    }
  });
});

describe('CONTROLLED mode (the default)', () => {
  it('runs reads and reversible writes without asking', () => {
    assert.equal(decide('read', 'controlled').effect, 'allow');
    assert.equal(decide('write', 'controlled', { reversibility: 'reversible' }).effect, 'allow');
  });

  it('asks before an irreversible or unknown-reversibility write', () => {
    assert.equal(decide('write', 'controlled', { reversibility: 'irreversible' }).effect, 'confirm');
    assert.equal(decide('write', 'controlled', { reversibility: 'unknown' }).effect, 'confirm');
  });

  it('always asks before external, destructive and system actions', () => {
    for (const level of ['external', 'destructive', 'system'] as PermissionLevel[]) {
      assert.equal(decide(level, 'controlled').effect, 'confirm');
    }
  });
});

describe('AUTONOMOUS mode', () => {
  it('relaxes writes fully, including irreversible ones', () => {
    assert.equal(decide('write', 'autonomous', { reversibility: 'irreversible' }).effect, 'allow');
  });

  it('still confirms external and destructive under the default config', () => {
    assert.equal(decide('external', 'autonomous').effect, 'confirm');
    assert.equal(decide('destructive', 'autonomous').effect, 'confirm');
  });

  /**
   * `alwaysConfirm` is a widening switch only. Removing a level from it must not
   * be able to turn a base-policy `confirm` into an `allow`.
   */
  it('does not let removing a level from alwaysConfirm loosen the base policy', () => {
    assert.equal(
      decide('external', 'autonomous', { alwaysConfirm: ['destructive', 'system'] }).effect,
      'confirm',
    );
  });
});

describe('DEVELOPER mode', () => {
  it('is no more permissive about confirmation than CONTROLLED', () => {
    for (const level of ['external', 'destructive', 'system'] as PermissionLevel[]) {
      assert.equal(decide(level, 'developer').effect, decide(level, 'controlled').effect);
    }
  });
});

describe('invariants that must hold in every mode', () => {
  it('never auto-approves a SYSTEM action', () => {
    for (const mode of ALL_MODES) {
      assert.notEqual(decide('system', mode).effect, 'allow', `SYSTEM auto-approved in ${mode}`);
    }
  });

  it('holds even under the most permissive configuration a user can set', () => {
    for (const mode of ALL_MODES) {
      assert.notEqual(decide('system', mode, { alwaysConfirm: [] }).effect, 'allow');
      assert.notEqual(decide('destructive', mode, { alwaysConfirm: [] }).effect, 'allow');
    }
  });

  it('lets alwaysConfirm tighten an otherwise automatic action', () => {
    const decision = decide('write', 'controlled', { alwaysConfirm: ['write'] });
    assert.equal(decision.effect, 'confirm');
    assert.equal(decision.rule, 'config:alwaysConfirm');
  });
});

describe('per-task blanket approval', () => {
  it('upgrades a prompt to automatic for the rest of the task', () => {
    assert.equal(decide('external', 'controlled', { taskApproved: true }).effect, 'allow');
  });

  it('cannot bypass the system-level floor', () => {
    assert.equal(decide('system', 'controlled', { taskApproved: true }).effect, 'confirm');
  });

  it('cannot resurrect a denial', () => {
    assert.equal(decide('destructive', 'safe', { taskApproved: true }).effect, 'deny');
  });
});

describe('mode availability gating', () => {
  it('denies a tool that is not offered in the current mode', () => {
    const decision = engine.evaluate({
      tool: {
        name: 'terminal.execute',
        permission: 'system',
        reversibility: 'irreversible',
        availableInModes: ['developer'],
      },
      mode: 'controlled',
      automation: { alwaysConfirm: DEFAULT_ALWAYS_CONFIRM },
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.rule, 'mode-availability');
  });

  it('treats an unrestricted tool as available everywhere', () => {
    assert.equal(engine.isAvailable({ name: 'system.getInfo' }, 'safe'), true);
  });
});

describe('autoApprovedCeiling', () => {
  it('reports read for SAFE and write for CONTROLLED', () => {
    assert.equal(engine.autoApprovedCeiling('safe', { alwaysConfirm: DEFAULT_ALWAYS_CONFIRM }), 'read');
    assert.equal(
      engine.autoApprovedCeiling('controlled', { alwaysConfirm: DEFAULT_ALWAYS_CONFIRM }),
      'write',
    );
  });
});
