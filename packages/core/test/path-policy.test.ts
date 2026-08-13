import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PathPolicy, matchesPattern, normalisePath } from '../dist/index.js';

/** Spec §39: sensitive paths must be unreachable regardless of trust. */

describe('matchesPattern', () => {
  it('treats a wildcard-free pattern as a directory prefix', () => {
    assert.equal(matchesPattern(normalisePath('C:/Windows/System32/cmd.exe'), 'C:\\Windows'), true);
    assert.equal(matchesPattern(normalisePath('C:/Windows'), 'C:\\Windows'), true);
  });

  /**
   * A prefix rule must respect segment boundaries, or `C:\Windows` would also
   * block `C:\WindowsApps` — and a rule for `C:\Users\sam` would block
   * `C:\Users\sammy`. This is a real class of policy bug.
   */
  it('does not let a prefix rule bleed across a path segment boundary', () => {
    assert.equal(matchesPattern(normalisePath('C:/WindowsApps/thing.exe'), 'C:\\Windows'), false);
  });

  it('matches ** at any depth including zero', () => {
    assert.equal(matchesPattern(normalisePath('C:/Users/sam/.ssh/id_rsa'), '**/.ssh/**'), true);
    assert.equal(matchesPattern(normalisePath('C:/.ssh/id_rsa'), '**/.ssh/**'), true);
  });

  it('matches extension globs', () => {
    assert.equal(matchesPattern(normalisePath('C:/Users/sam/vault.kdbx'), '**/*.kdbx'), true);
    assert.equal(matchesPattern(normalisePath('C:/Users/sam/notes.txt'), '**/*.kdbx'), false);
  });

  it('is case-insensitive, as Windows paths are', () => {
    assert.equal(matchesPattern(normalisePath('c:/users/sam/.ENV'), '**/.env'), true);
  });
});

describe('normalisePath', () => {
  it('collapses traversal segments so they cannot escape a trusted root', () => {
    assert.equal(
      normalisePath('C:/Users/sam/Documents/../../../Windows/System32'),
      'c:/windows/system32',
    );
  });

  it('normalises separators and trailing slashes', () => {
    assert.equal(normalisePath('C:\\Users\\sam\\'), normalisePath('C:/Users/sam'));
  });
});

describe('PathPolicy', () => {
  const home = 'C:/Users/sam';
  const policy = new PathPolicy({
    trustedFolders: [path.join(home, 'Documents'), path.join(home, 'Desktop')],
    blockedPathPatterns: ['C:\\Windows', '**/.ssh/**', '**/.env', '**/*.kdbx'],
  });

  it('trusts configured folders and their descendants', () => {
    assert.equal(policy.evaluate(`${home}/Documents/report.docx`).trust, 'trusted');
    assert.equal(policy.evaluate(`${home}/Documents/nested/deep/file.txt`).trust, 'trusted');
  });

  it('marks everything else untrusted rather than blocked', () => {
    assert.equal(policy.evaluate('D:/random/file.txt').trust, 'untrusted');
  });

  /** The ordering property: deny beats trust, unconditionally. */
  it('blocks a sensitive file even inside a trusted folder', () => {
    const decision = policy.evaluate(`${home}/Documents/.env`);
    assert.equal(decision.trust, 'blocked');
    assert.equal(decision.matchedPattern, '**/.env');
  });

  it('blocks a traversal that lands in a system directory', () => {
    assert.equal(
      policy.evaluate(`${home}/Documents/../../../Windows/System32/config`).trust,
      'blocked',
    );
  });

  it('blocks SSH keys and password databases wherever they live', () => {
    assert.equal(policy.evaluate(`${home}/.ssh/id_rsa`).trust, 'blocked');
    assert.equal(policy.evaluate(`${home}/Desktop/passwords.kdbx`).trust, 'blocked');
  });

  it('picks up policy changes without being recreated', () => {
    const p = new PathPolicy({ trustedFolders: [], blockedPathPatterns: [] });
    assert.equal(p.evaluate('C:/Windows/System32').trust, 'untrusted');
    p.update({ trustedFolders: [], blockedPathPatterns: ['C:\\Windows'] });
    assert.equal(p.evaluate('C:/Windows/System32').trust, 'blocked');
  });
});
