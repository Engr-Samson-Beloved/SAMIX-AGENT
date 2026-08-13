import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig } from '@samix/shared';
import { ConfigStore, createAppPaths, mergeConfig } from '../dist/index.js';
import { tempDir } from './helpers.ts';

/**
 * Config must never be the reason the agent fails to launch (spec §44).
 * Every test runs against a throwaway directory — spec §69 forbids tests
 * touching real user data.
 */

let dir: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir, cleanup } = tempDir('samix-config-'));
});

afterEach(() => cleanup());

const load = () => ConfigStore.load(createAppPaths(dir));

describe('first run', () => {
  it('writes a complete default config file', () => {
    const store = load();
    assert.ok(fs.existsSync(path.join(dir, 'config.json')));

    const config = store.get();
    assert.equal(config.automation.mode, 'controlled');
    assert.equal(config.schemaVersion, 1);
    assert.equal(config.hotkey, 'CmdOrControl+Shift+Space');
  });

  it('seeds trusted folders from the real user profile rather than literals', () => {
    const folders = load().get().security.trustedFolders;
    assert.ok(folders.length > 0);
    for (const folder of folders) assert.ok(path.isAbsolute(folder), `${folder} should be absolute`);
  });

  it('does not enable start-with-Windows during development', () => {
    assert.equal(load().get().ui.startWithWindows, false);
  });
});

describe('resilience', () => {
  it('recovers from unparseable JSON and preserves the bad file', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json');
    const store = load();

    assert.equal(store.get().automation.mode, 'controlled');
    const quarantined = fs.readdirSync(dir).filter((f) => f.startsWith('config.corrupt-'));
    assert.equal(quarantined.length, 1, 'the corrupt file must be kept, not discarded');
  });

  it('repairs individual invalid fields without discarding valid neighbours', () => {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        schemaVersion: 1,
        automation: { mode: 'not-a-real-mode', maxStepsPerTask: 42 },
        hotkey: 'CmdOrControl+Alt+K',
      }),
    );
    const config = load().get();

    assert.equal(config.automation.mode, 'controlled', 'invalid field repaired');
    assert.equal(config.automation.maxStepsPerTask, 42, 'valid sibling kept');
    assert.equal(config.hotkey, 'CmdOrControl+Alt+K', 'valid section kept');
  });

  it('refuses to overwrite a config written by a newer version', () => {
    const future = { schemaVersion: 999, hotkey: 'CmdOrControl+Alt+Z' };
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(future));

    const store = load();
    assert.equal(store.get().hotkey, 'CmdOrControl+Shift+Space', 'runs on defaults');
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(file, 'utf8')),
      future,
      'the newer file must survive so a re-upgrade restores the settings',
    );
  });
});

describe('updates', () => {
  it('persists a patch and leaves untouched sections intact', () => {
    const store = load();
    const before = store.get();

    store.update({ automation: { mode: 'safe' } });

    const after = ConfigStore.load(createAppPaths(dir)).get();
    assert.equal(after.automation.mode, 'safe');
    assert.equal(after.automation.maxStepsPerTask, before.automation.maxStepsPerTask);
    assert.equal(after.hotkey, before.hotkey);
  });

  it('notifies listeners', () => {
    const store = load();
    let seen: string | undefined;
    store.onChange((config) => {
      seen = config.automation.mode;
    });
    store.update({ automation: { mode: 'developer' } });
    assert.equal(seen, 'developer');
  });

  it('returns a copy so callers cannot mutate stored state', () => {
    const store = load();
    const config = store.get();
    config.automation.mode = 'autonomous';
    assert.equal(store.get().automation.mode, 'controlled');
  });

  it('resets to defaults', () => {
    const store = load();
    store.update({ automation: { mode: 'autonomous' }, hotkey: 'CmdOrControl+J' });
    const reset = store.reset();
    assert.equal(reset.automation.mode, 'controlled');
    assert.equal(reset.hotkey, 'CmdOrControl+Shift+Space');
  });
});

describe('mergeConfig', () => {
  const base = defaultConfig();

  it('replaces arrays rather than concatenating them', () => {
    const merged = mergeConfig(base, { security: { trustedFolders: ['C:\\Only'] } });
    assert.deepStrictEqual(merged.security.trustedFolders, ['C:\\Only']);
  });

  it('ignores explicitly undefined keys instead of blanking the field', () => {
    const merged = mergeConfig(base, { ui: { theme: undefined, closeToTray: false } });
    assert.equal(merged.ui.theme, base.ui.theme);
    assert.equal(merged.ui.closeToTray, false);
  });

  it('does not mutate the input', () => {
    const before = structuredClone(base);
    mergeConfig(base, { automation: { mode: 'safe' } });
    assert.deepStrictEqual(base, before);
  });
});
