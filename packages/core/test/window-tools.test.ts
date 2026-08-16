import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AppRegistry,
  createScreenGetActiveWindowTool,
  createWindowCloseTool,
  createWindowFocusTool,
  createWindowListTool,
  isValidHandle,
  type DiscoveredApp,
  type WindowAutomation,
  type WindowInfo,
} from '../dist/index.js';

/**
 * Phase 7 window tools.
 *
 * The Win32 calls are `ui-automation.ts` and are exercised by using the agent.
 * What is tested here is the part that decides **which window the user meant**,
 * against a known desktop — because the failure it prevents ("close this window"
 * closing the agent) is not something you want to discover on a real screen.
 */

const ctx = {
  taskId: 'task_test',
  stepId: 'step_test',
  signal: new AbortController().signal,
  timeoutMs: 5_000,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};

const fakeApps: DiscoveredApp[] = [
  {
    id: 'vscode',
    displayName: 'Visual Studio Code',
    executablePath: 'C:\\Code\\Code.exe',
    imageName: 'Code.exe',
    kind: 'editor',
    aliases: ['vs code', 'code'],
  },
];

const apps = (): AppRegistry => new AppRegistry(() => Promise.resolve(fakeApps));

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

/** A desktop, in z-order: first entry is the window in front. */
function desktop(windows: WindowInfo[], overrides: Partial<WindowAutomation> = {}): {
  uia: WindowAutomation;
  focused: number[];
  closed: number[];
} {
  const focused: number[] = [];
  const closed: number[] = [];

  const uia: WindowAutomation = {
    list: () => Promise.resolve(windows),
    active: () => {
      const front = windows[0];
      if (front && !front.isOwn) return Promise.resolve({ window: front, substituted: false });
      const behind = windows.find((w) => !w.isOwn);
      return Promise.resolve(behind ? { window: behind, substituted: true } : undefined);
    },
    focus: (handle) => {
      focused.push(handle);
      const target = windows.find((w) => w.handle === handle);
      return Promise.resolve({ focused: true, active: target });
    },
    close: (handle) => {
      closed.push(handle);
      return Promise.resolve({ requested: true });
    },
    waitForClose: () => Promise.resolve(true),
    ...overrides,
  };

  return { uia, focused, closed };
}

// ---------------------------------------------------------------------------

describe('handles reaching user32', () => {
  test('rejects anything that is not a plausible window handle', () => {
    assert.equal(isValidHandle(0), false);
    assert.equal(isValidHandle(-1), false);
    assert.equal(isValidHandle(1.5), false);
    assert.equal(isValidHandle(Number.NaN), false);
    assert.equal(isValidHandle(131_234), true);
  });
});

describe('"this window" never means the agent’s own', () => {
  const agentInFront = [
    win({ handle: 1, title: 'SAMIX Agent', processName: 'node', isOwn: true, isActive: true }),
    win({ handle: 2, title: 'Invoices — Excel', processName: 'excel' }),
  ];

  test('closing with nothing named skips the agent and takes the window behind it', async () => {
    const { uia, closed } = desktop(agentInFront);
    const tool = createWindowCloseTool(apps(), () => ({}), uia);

    const result = await tool.execute({}, ctx);

    // The whole point. Without the exclusion this closes the agent, in response
    // to a routine request, and the session is gone.
    assert.equal(result.success, true);
    assert.deepEqual(closed, [2]);
    assert.equal(result.data?.title, 'Invoices — Excel');
    assert.match(result.data?.how ?? '', /agent’s own window/);
  });

  test('window.list never offers the agent’s window as a candidate', async () => {
    const { uia } = desktop(agentInFront);

    const result = await createWindowListTool(apps(), uia).execute({}, ctx);

    assert.deepEqual(
      result.data?.windows.map((w) => w.title),
      ['Invoices — Excel'],
    );
  });

  test('the active window is reported as substituted, not silently swapped', async () => {
    const { uia } = desktop(agentInFront);

    const result = await createScreenGetActiveWindowTool(uia).execute({}, ctx);

    assert.equal(result.data?.title, 'Invoices — Excel');
    // Reporting a different window as "active" without saying so would be a
    // small, confident lie — the kind that is hardest to catch later.
    assert.equal(result.data?.behindAgentWindow, true);
  });

  test('an ordinary foreground window is reported as itself', async () => {
    const { uia } = desktop([win({ handle: 5, title: 'Notes', isActive: true })]);

    const result = await createScreenGetActiveWindowTool(uia).execute({}, ctx);

    assert.equal(result.data?.title, 'Notes');
    assert.equal(result.data?.behindAgentWindow, false);
  });
});

describe('ambiguity is resolved differently by risk', () => {
  const twoChromes = [
    win({ handle: 10, title: 'Inbox — Chrome' }),
    win({ handle: 11, title: 'Docs — Chrome' }),
  ];

  test('focus takes the frontmost match, because focusing is reversible', async () => {
    const { uia, focused } = desktop(twoChromes);

    const result = await createWindowFocusTool(apps(), () => ({}), uia).execute(
      { title: 'Chrome' },
      ctx,
    );

    assert.equal(result.success, true);
    assert.deepEqual(focused, [10]);
    assert.match(result.data?.how ?? '', /frontmost of 2/);
  });

  test('close refuses to guess, and returns the candidates to ask about', async () => {
    const { uia, closed } = desktop(twoChromes);

    const result = await createWindowCloseTool(apps(), () => ({}), uia).execute(
      { title: 'Chrome' },
      ctx,
    );

    // Closing cannot be undone, so a coin toss between two windows is not an
    // acceptable resolution (spec §21, §94).
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'WINDOW_NOT_FOUND');
    assert.deepEqual(closed, []);
    assert.equal((result.error?.details?.['matched'] as string[]).length, 2);
  });
});

describe('falling back to what the agent last touched', () => {
  test('uses the last application acted on when nothing is in focus', async () => {
    const windows = [win({ handle: 20, title: 'agent.ts — Code', processName: 'Code' })];
    const { uia, focused } = desktop(windows, { active: () => Promise.resolve(undefined) });

    const result = await createWindowFocusTool(apps(), () => ({ app: 'VS Code' }), uia).execute(
      {},
      ctx,
    );

    // "VS Code" is what a person says; `Code.exe` is what Windows reports. The
    // application registry is what bridges them.
    assert.equal(result.success, true);
    assert.deepEqual(focused, [20]);
    assert.match(result.data?.how ?? '', /last working with/);
  });

  test('says so plainly when there is nothing to act on', async () => {
    const { uia } = desktop([], { active: () => Promise.resolve(undefined) });

    const result = await createWindowFocusTool(apps(), () => ({}), uia).execute({}, ctx);

    assert.equal(result.success, false);
    assert.match(result.error?.message ?? '', /no ordinary windows open/i);
  });
});

describe('closing a window', () => {
  test('is destructive and irreversible, and says why in the prompt', () => {
    const tool = createWindowCloseTool(apps(), () => ({}));

    assert.equal(tool.permission, 'destructive');
    assert.equal(tool.reversibility, 'irreversible');
    assert.match(tool.describeEffect!({ title: 'Invoices' }), /unsaved work/i);
    // With no target named the prompt must still say what will happen, because
    // that sentence is the user's last chance to notice we mean the wrong thing.
    assert.match(tool.describeEffect!({}), /currently looking at/i);
  });

  test('reports honestly when the window refuses to go away', async () => {
    const { uia } = desktop([win({ handle: 30, title: 'Unsaved — Notepad' })], {
      waitForClose: () => Promise.resolve(false),
    });
    const tool = createWindowCloseTool(apps(), () => ({}), uia);
    const input = { handle: 30 };

    const verified = await tool.verify!(input, await tool.execute(input, ctx), ctx);

    assert.equal(verified.status, 'failed');
    assert.match(verified.detail, /still open/);
  });
});
