import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  AppRegistry,
  createAppCloseTool,
  createAppLaunchTool,
  isLaunchable,
  isValidImageName,
  type DiscoveredApp,
} from '../dist/index.js';

/**
 * Phase 5 application tools.
 *
 * Nothing here launches a real program. These tests are about the boundaries —
 * which executables may be launched at all, and whether a failed resolve
 * produces something the planner can re-plan against. Actually starting Chrome
 * is what `pnpm check:apps` does, against the real machine, where it belongs.
 *
 * The browser tools moved to `browser-tools.test.ts` when they stopped being a
 * `spawn` of `chrome.exe` and became a real Playwright session.
 */

const fakeApps: DiscoveredApp[] = [
  {
    id: 'chrome',
    displayName: 'Google Chrome',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    imageName: 'chrome.exe',
    kind: 'browser',
    aliases: ['google chrome', 'google'],
  },
  {
    id: 'vscode',
    displayName: 'Visual Studio Code',
    executablePath: 'C:\\Users\\test\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    imageName: 'Code.exe',
    kind: 'editor',
    aliases: ['vs code', 'code'],
  },
];

function registry(): AppRegistry {
  return new AppRegistry(() => Promise.resolve(fakeApps));
}

const ctx = {
  taskId: 'task_test',
  stepId: 'step_test',
  signal: new AbortController().signal,
  timeoutMs: 5_000,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};

// ---------------------------------------------------------------------------

describe('the launch allow-list', () => {
  test('refuses shells and interpreters wherever they are found', () => {
    // If any of these were launchable, "no unrestricted shell" (spec §40) would
    // be decorative — app.launch would be the escape hatch.
    for (const shell of [
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\wscript.exe',
      'C:\\Windows\\System32\\mshta.exe',
    ]) {
      assert.equal(isLaunchable(shell), false, `${shell} must never be launchable`);
    }
  });

  test('refuses the living-off-the-land binaries used to fetch and run payloads', () => {
    for (const binary of ['certutil.exe', 'bitsadmin.exe', 'regsvr32.exe', 'rundll32.exe']) {
      assert.equal(isLaunchable(`C:\\Windows\\System32\\${binary}`), false, binary);
    }
  });

  test('allows ordinary applications', () => {
    assert.equal(isLaunchable('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), true);
    assert.equal(isLaunchable('C:\\Program Files\\Notepad++\\notepad++.exe'), true);
  });
});

describe('resolving what the user said', () => {
  test('matches an id, a display name and an alias', async () => {
    const apps = registry();

    assert.equal((await apps.resolve('chrome'))?.id, 'chrome');
    assert.equal((await apps.resolve('Google Chrome'))?.id, 'chrome');
    assert.equal((await apps.resolve('vs code'))?.id, 'vscode');
    assert.equal((await apps.resolve('CODE'))?.id, 'vscode');
  });

  test('an unknown name resolves to nothing rather than the closest guess', async () => {
    const apps = registry();

    assert.equal(await apps.resolve('photoshop'), undefined);
  });

  test('launching an unknown application returns the installed list to re-plan against', async () => {
    const tool = createAppLaunchTool(registry());

    const result = await tool.execute({ name: 'photoshop' }, ctx);

    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'APP_NOT_FOUND');
    // Without this the planner can only guess again; with it, it can ask.
    assert.deepEqual(result.error?.details?.['installed'], [
      'Google Chrome',
      'Visual Studio Code',
    ]);
  });
});

describe('closing applications', () => {
  test('is destructive and irreversible, and says why in the prompt', () => {
    const tool = createAppCloseTool(registry());

    assert.equal(tool.permission, 'destructive');
    assert.equal(tool.reversibility, 'irreversible');
    assert.match(tool.describeEffect!({ name: 'Notepad' }), /unsaved work/i);
  });
});

describe('image names reaching taskkill', () => {
  test('accepts ordinary executable names', () => {
    assert.equal(isValidImageName('chrome.exe'), true);
    assert.equal(isValidImageName('Microsoft.Photos.exe'), true);
  });

  test('rejects anything that could be read as an extra command-line switch', () => {
    assert.equal(isValidImageName('/F'), false);
    assert.equal(isValidImageName('-f chrome.exe'), false);
    assert.equal(isValidImageName('/IM chrome.exe /F'), false);
  });

  test('rejects names that are not executables at all', () => {
    assert.equal(isValidImageName('chrome'), false);
    assert.equal(isValidImageName('..\\..\\evil.exe'), false);
    assert.equal(isValidImageName(''), false);
  });
});
