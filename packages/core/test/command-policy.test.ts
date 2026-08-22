import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CommandPolicy } from '../dist/index.js';

/**
 * `CommandPolicy` (spec §22, §40) — Phase 10.
 *
 * The policy is the only gate `terminal.execute` calls before spawning
 * anything, so what matters here is that the boundary holds under the exact
 * inputs an LLM might plausibly produce: a path instead of a bare name, a
 * shell it was never meant to reach, and a live config change.
 */

function policy(overrides: Partial<{ allowedCommands: string[]; timeoutMs: number; maxOutputBytes: number }> = {}): CommandPolicy {
  return new CommandPolicy({
    allowedCommands: ['git', 'node', 'npm', 'pnpm', 'npx'],
    timeoutMs: 60_000,
    maxOutputBytes: 200_000,
    ...overrides,
  });
}

describe('CommandPolicy', () => {
  test('allows a command on the list', () => {
    assert.deepEqual(policy().evaluate('git'), { allowed: true });
  });

  test('is case-insensitive and tolerates a trailing .exe on either side', () => {
    assert.equal(policy().evaluate('Git').allowed, true);
    assert.equal(policy().evaluate('git.exe').allowed, true);
    assert.equal(policy({ allowedCommands: ['git.exe'] }).evaluate('git').allowed, true);
  });

  test('refuses a command not on the list', () => {
    const decision = policy().evaluate('curl');
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', /not in the allowed command list/);
  });

  test('refuses a path instead of a bare name, even one that ends in an allowed name', () => {
    const decision = policy().evaluate('C:\\Windows\\System32\\git.exe');
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', /bare name/);
  });

  test('refuses a relative-path-shaped command', () => {
    const decision = policy().evaluate('../evil/git');
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', /bare name/);
  });

  test('refuses an empty command', () => {
    assert.equal(policy().evaluate('   ').allowed, false);
  });

  test(
    'refuses a shell or interpreter even if a misconfiguration adds it to the allow list',
    () => {
      // This is the floor spec §40 asks for: no configuration value can reopen
      // the door NEVER_LAUNCHABLE closes, unlike the allow list itself.
      const decision = policy({ allowedCommands: ['powershell', 'git'] }).evaluate('powershell');
      assert.equal(decision.allowed, false);
      assert.match(decision.reason ?? '', /shell or system-management tool/);
    },
  );

  test('refuses known living-off-the-land binaries the same way', () => {
    assert.equal(policy({ allowedCommands: ['certutil'] }).evaluate('certutil').allowed, false);
    assert.equal(policy({ allowedCommands: ['reg'] }).evaluate('reg').allowed, false);
  });

  test('update() changes the allow list live, without recreating the policy', () => {
    const p = policy({ allowedCommands: ['git'] });
    assert.equal(p.evaluate('npm').allowed, false);
    p.update({ allowedCommands: ['git', 'npm'], timeoutMs: 5_000, maxOutputBytes: 1_000 });
    assert.equal(p.evaluate('npm').allowed, true);
    assert.equal(p.timeoutMs, 5_000);
    assert.equal(p.maxOutputBytes, 1_000);
  });

  test('reports plainly when nothing at all is configured as allowed', () => {
    const decision = policy({ allowedCommands: [] }).evaluate('git');
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', /no commands are configured/);
  });
});
