import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import {
  DesktopSidecar,
  SIDECAR_PROTOCOL_VERSION,
  type SidecarError,
  parseFrame,
  pythonCandidates,
  sidecarArgs,
  type DesktopSidecarOptions,
} from '../dist/index.js';
import { defaultConfig } from '@samix/shared';

/**
 * The desktop sidecar client.
 *
 * The Python half is exercised live by `pnpm check:desktop`, which needs a real
 * desktop with real windows on it. What is tested here is everything that can go
 * wrong *between* the two processes — framing, queueing, cancellation, timeouts,
 * crash recovery and degradation — because those are the paths that only happen
 * when something is already broken, and are therefore the ones a live run is
 * least likely to reach.
 *
 * No Python is spawned. `spawnFn` is injected, so the suite runs identically on
 * a machine that has never had an interpreter installed.
 */

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function desktopConfig(patch: Record<string, unknown> = {}) {
  return { ...defaultConfig().automation.desktop, ...patch };
}

/** A child process that never existed, wired the way `spawn` would wire one. */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly frames: Array<Record<string, any>> = [];
  killed = false;
  // Declared explicitly rather than as a parameter property: `node --test` runs
  // these files in strip-only mode, which cannot rewrite that syntax.
  readonly onFrame: ((frame: any, child: FakeChild) => void) | undefined;

  constructor(onFrame?: (frame: any, child: FakeChild) => void) {
    super();
    this.onFrame = onFrame;
    let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() !== '') {
          const frame = JSON.parse(line);
          this.frames.push(frame);
          this.onFrame?.(frame, this);
        }
        index = buffer.indexOf('\n');
      }
    });
  }

  /** Frames written by the client, excluding the handshake. */
  get requests(): Array<Record<string, any>> {
    return this.frames.filter((f) => f.op !== 'ping');
  }

  reply(id: string | number, data: unknown, ms = 1): void {
    this.stdout.write(`${JSON.stringify({ id: String(id), ok: true, data, ms })}\n`);
  }

  fail(id: string | number, code: string, message: string, recoverable = true): void {
    this.stdout.write(
      `${JSON.stringify({ id: String(id), ok: false, error: { code, message, recoverable } })}\n`,
    );
  }

  raw(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  die(code = 1): void {
    this.killed = true;
    this.emit('exit', code, null);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const handshake = (patch: Record<string, unknown> = {}) => ({
  protocolVersion: SIDECAR_PROTOCOL_VERSION,
  pid: 4242,
  python: '3.12.10',
  architecture: 'AMD64',
  dpiAwareness: 'per-monitor-v2',
  com: 'sta',
  uia: true,
  uiaDetail: '#32769',
  ...patch,
});

/**
 * Build a client over a fake child.
 *
 * `respond` decides what the sidecar "does". By default it answers the
 * handshake and nothing else, so a test that wants to control timing simply does
 * not answer.
 */
function harness(
  respond: (frame: any, child: FakeChild) => void = () => {},
  options: Partial<DesktopSidecarOptions> & { config?: () => any } = {},
) {
  const children: FakeChild[] = [];
  const child = () => children[children.length - 1]!;

  const sidecar = new DesktopSidecar({
    config: options.config ?? (() => desktopConfig()),
    logger,
    ownPids: options.ownPids ?? (() => [111, 222]),
    maxRespawns: options.maxRespawns ?? 3,
    spawnFn: ((): any => {
      const created = new FakeChild((frame, self) => {
        if (frame.op === 'ping') {
          queueMicrotask(() => self.reply(frame.id, handshake()));
          return;
        }
        if (frame.op === 'shutdown') {
          // The real sidecar exits on `shutdown`. Modelling that matters: the
          // client waits up to two seconds for the exit before killing, so a
          // fake that never exits makes every test in this file pay it.
          queueMicrotask(() => self.die(0));
          return;
        }
        respond(frame, self);
      });
      children.push(created);
      return created;
    }) as any,
  });

  return { sidecar, children, child };
}

// ---------------------------------------------------------------------------

describe('sidecar framing', () => {
  test('parseFrame accepts a well-formed success frame', () => {
    const frame = parseFrame('{"id":"3","ok":true,"data":{"a":1},"ms":12}');
    assert.equal(frame?.ok, true);
    assert.deepEqual(frame && frame.ok ? frame.data : undefined, { a: 1 });
  });

  test('parseFrame rejects noise rather than throwing', () => {
    // A sidecar that prints a warning to stdout must not take the agent down.
    assert.equal(parseFrame('not json at all'), undefined);
    assert.equal(parseFrame(''), undefined);
    assert.equal(parseFrame('{"id":"1"}'), undefined);
    assert.equal(parseFrame('{"id":"1","ok":false,"error":{"code":"NOPE","message":"x"}}'), undefined);
  });

  test('a request is one line carrying id, op and params', async () => {
    const { sidecar, child } = harness((frame, self) => self.reply(frame.id, { ok: 1 }));
    await sidecar.call('snapshot', { handle: 5 });

    const request = child().requests[0]!;
    assert.equal(request.op, 'snapshot');
    assert.equal(typeof request.id, 'string');
    assert.equal(request.params.handle, 5);
    await sidecar.dispose();
  });

  test('an unreadable frame is discarded and the next one still resolves', async () => {
    const { sidecar } = harness((frame, self) => {
      self.raw('Traceback (most recent call last):');
      self.raw('{"broken":');
      self.reply(frame.id, { recovered: true });
    });
    assert.deepEqual(await sidecar.call('snapshot'), { recovered: true });
    await sidecar.dispose();
  });
});

describe('handshake', () => {
  test('reports what the sidecar said about itself', async () => {
    const { sidecar } = harness((frame, self) => self.reply(frame.id, {}));
    await sidecar.call('snapshot');

    const status = sidecar.status();
    assert.equal(status.state, 'ready');
    assert.equal(status.handshake?.dpiAwareness, 'per-monitor-v2');
    assert.match(status.detail, /3\.12\.10/);
    await sidecar.dispose();
  });

  test('an interpreter without uiautomation is skipped, not fatal', async () => {
    // Whether `uiautomation` imports is a property of the interpreter, so the
    // next candidate is worth trying. One unsuitable Python on PATH must not
    // disable a sidecar the bundled virtual environment would have run.
    let attempt = 0;
    const children: FakeChild[] = [];
    const sidecar = new DesktopSidecar({
      config: () => desktopConfig(),
      logger,
      spawnFn: ((): any => {
        const usable = (attempt += 1) > 1;
        const created = new FakeChild((frame, self) => {
          if (frame.op === 'ping') {
            queueMicrotask(() =>
              self.reply(
                frame.id,
                usable ? handshake() : handshake({ uia: false, uiaDetail: "No module named 'uiautomation'" }),
              ),
            );
          } else if (frame.op === 'shutdown') queueMicrotask(() => self.die(0));
          else self.reply(frame.id, { ok: 1 });
        });
        children.push(created);
        return created;
      }) as any,
    });

    assert.deepEqual(await sidecar.call('snapshot'), { ok: 1 });
    assert.equal(children.length, 2, 'the second candidate was tried');
    assert.equal(sidecar.status().state, 'ready');
    await sidecar.dispose();
  });

  test('degrades when NO interpreter can reach UI Automation', async () => {
    const children: FakeChild[] = [];
    const sidecar = new DesktopSidecar({
      config: () => desktopConfig(),
      logger,
      spawnFn: ((): any => {
        const created = new FakeChild((frame, self) => {
          if (frame.op === 'ping') {
            queueMicrotask(() =>
              self.reply(frame.id, handshake({ uia: false, uiaDetail: 'COM refused' })),
            );
          }
        });
        children.push(created);
        return created;
      }) as any,
    });

    await assert.rejects(sidecar.call('snapshot'), (error: SidecarError) => {
      assert.equal(error.code, 'UNSUPPORTED_PLATFORM');
      assert.equal(error.recoverable, false);
      return true;
    });
    assert.equal(sidecar.status().state, 'degraded');
    assert.match(sidecar.status().detail, /COM refused/);
    // Every candidate was tried and every one was unsuitable. Only then is this
    // a fact about the machine rather than about one interpreter.
    assert.ok(children.length >= 2, 'each candidate interpreter gets a turn');
    assert.equal(sidecar.isUsable(), false);
  });

  test('degrades on a protocol version it does not speak', async () => {
    const sidecar = new DesktopSidecar({
      config: () => desktopConfig(),
      logger,
      spawnFn: ((): any =>
        new FakeChild((frame, self) => {
          if (frame.op === 'ping') {
            queueMicrotask(() =>
              self.reply(frame.id, handshake({ protocolVersion: SIDECAR_PROTOCOL_VERSION + 7 })),
            );
          }
        })) as any,
    });

    await assert.rejects(sidecar.call('snapshot'), /protocol/);
    assert.equal(sidecar.status().state, 'degraded');
  });
});

describe('bounds come from config, not from code', () => {
  test('every snapshot carries the configured limits and the excluded pids', async () => {
    const { sidecar, child } = harness((frame, self) => self.reply(frame.id, {}), {
      config: () =>
        desktopConfig({ maxDepth: 4, maxNodes: 25, snapshotTimeoutMs: 900, includeOffscreen: true }),
    });
    await sidecar.call('snapshot');

    const params = child().requests[0]!.params;
    assert.equal(params.maxDepth, 4);
    assert.equal(params.maxNodes, 25);
    assert.equal(params.timeoutMs, 900);
    assert.equal(params.includeOffscreen, true);
    // §5: the agent's own windows are never a target. The sidecar is seeded with
    // the ids it should walk up from rather than left to guess.
    assert.deepEqual(params.seedPids, [111, 222]);
    await sidecar.dispose();
  });

  test('window ops are seeded too, without the snapshot bounds', async () => {
    const { sidecar, child } = harness((frame, self) => self.reply(frame.id, {}));
    await sidecar.call('window.list');

    const params = child().requests[0]!.params;
    assert.deepEqual(params.seedPids, [111, 222]);
    assert.equal(params.maxNodes, undefined, 'a window list has no tree to bound');
    await sidecar.dispose();
  });

  test('an explicit argument overrides the configured default', async () => {
    const { sidecar, child } = harness((frame, self) => self.reply(frame.id, {}), {
      config: () => desktopConfig({ maxNodes: 400 }),
    });
    await sidecar.call('snapshot', { maxNodes: 10, handle: 9 });

    assert.equal(child().requests[0]!.params.maxNodes, 10);
    await sidecar.dispose();
  });

  test('non-snapshot ops keep their own arguments untouched', async () => {
    const { sidecar, child } = harness((frame, self) => self.reply(frame.id, {}));
    await sidecar.call('findElement', { query: 'Send' });

    assert.equal(child().requests[0]!.params.query, 'Send');
    await sidecar.dispose();
  });
});

describe('one request in flight', () => {
  test('a second call is not written until the first is answered', async () => {
    const held: any[] = [];
    const { sidecar, child } = harness((frame) => held.push(frame));

    const first = sidecar.call('snapshot', { n: 1 });
    const second = sidecar.call('snapshot', { n: 2 });

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(child().requests.length, 1, 'the sidecar is single-threaded; so is the client');

    child().reply(held[0].id, { first: true });
    assert.deepEqual(await first, { first: true });

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(child().requests.length, 2);
    child().reply(held[1].id, { second: true });
    assert.deepEqual(await second, { second: true });
    await sidecar.dispose();
  });

  test('a failed call does not poison the queue behind it', async () => {
    const { sidecar } = harness((frame, self) => {
      if (frame.params?.bad) self.fail(frame.id, 'WINDOW_NOT_FOUND', 'gone');
      else self.reply(frame.id, { fine: true });
    });

    await assert.rejects(sidecar.call('snapshot', { bad: true }));
    assert.deepEqual(await sidecar.call('snapshot', {}), { fine: true });
    await sidecar.dispose();
  });

  test('a sidecar error keeps its code and recoverability', async () => {
    const { sidecar } = harness((frame, self) =>
      self.fail(frame.id, 'STALE_REF', 'the tree moved', true),
    );
    await assert.rejects(sidecar.call('invoke'), (error: SidecarError) => {
      assert.equal(error.code, 'STALE_REF');
      assert.equal(error.recoverable, true);
      assert.equal(error.message, 'the tree moved');
      return true;
    });
    await sidecar.dispose();
  });
});

describe('cancellation', () => {
  test('a timeout cancels the sidecar rather than abandoning it mid-walk', async () => {
    const { sidecar, child } = harness(() => {
      /* never answer */
    });

    await assert.rejects(sidecar.call('snapshot', {}, 60), (error: SidecarError) => {
      assert.equal(error.code, 'TIMEOUT');
      return true;
    });

    const ops = child().frames.map((f) => f.op);
    assert.ok(ops.includes('cancel'), 'a timed-out walk must be told to stop');
    await sidecar.dispose();
  });

  test('emergency stop drains the queue instead of flagging it', async () => {
    const { sidecar, child } = harness(() => {
      /* never answer */
    });

    const first = sidecar.call('snapshot', { n: 1 }, 5_000);
    const queued = sidecar.call('snapshot', { n: 2 }, 5_000);
    await new Promise((r) => setTimeout(r, 20));

    sidecar.emergencyStop();

    await assert.rejects(first, (error: SidecarError) => error.code === 'USER_CANCELLED');
    await assert.rejects(queued, (error: SidecarError) => error.code === 'USER_CANCELLED');

    // The flag half is not enough on its own: whatever the sidecar has already
    // accepted has to be discarded too, or it keeps working after the stop.
    assert.ok(child().frames.some((f) => f.op === 'stop'));
    // And the queued call must never have been sent at all.
    assert.equal(child().requests.filter((f) => f.params?.n === 2).length, 0);
    await sidecar.dispose();
  });

  test('cancel interrupts the current call without clearing the queue', async () => {
    const { sidecar, child } = harness((frame, self) => {
      if (frame.params?.n === 2) self.reply(frame.id, { ran: true });
    });

    const first = sidecar.call('snapshot', { n: 1 }, 80);
    await new Promise((r) => setTimeout(r, 10));
    sidecar.cancel();

    await assert.rejects(first);
    assert.ok(child().frames.some((f) => f.op === 'cancel'));
    // The next call still runs: "stop this step" is not "stop everything".
    assert.deepEqual(await sidecar.call('snapshot', { n: 2 }), { ran: true });
    await sidecar.dispose();
  });
});

describe('crash and respawn', () => {
  test('an exit mid-call fails that call as recoverable', async () => {
    const { sidecar, child } = harness(() => {
      /* never answer */
    });
    const call = sidecar.call('snapshot', {}, 5_000);
    await new Promise((r) => setTimeout(r, 20));
    child().die(3221225477);

    await assert.rejects(call, (error: SidecarError) => {
      assert.equal(error.code, 'INTERNAL_ERROR');
      assert.equal(error.recoverable, true, 'a respawn may well fix it');
      assert.match(error.message, /exited with code/);
      return true;
    });
    await sidecar.dispose();
  });

  test('it respawns, and the next call succeeds against the new process', async () => {
    const { sidecar, child, children } = harness((frame, self) => self.reply(frame.id, { n: 1 }));
    await sidecar.call('snapshot');
    child().die();

    assert.deepEqual(await sidecar.call('snapshot'), { n: 1 });
    assert.equal(children.length, 2, 'a second process was started');
    assert.equal(sidecar.status().state, 'ready');
    assert.equal(sidecar.status().respawns, 1);
    await sidecar.dispose();
  });

  test('after the ceiling it degrades and stops trying', async () => {
    const { sidecar, children } = harness((frame, self) => self.reply(frame.id, {}), {
      maxRespawns: 3,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sidecar.call('snapshot');
      children[children.length - 1]!.die();
    }

    assert.equal(sidecar.status().state, 'degraded');
    assert.equal(sidecar.isUsable(), false);

    const spawnedSoFar = children.length;
    await assert.rejects(sidecar.call('snapshot'), (error: SidecarError) => {
      // Non-recoverable: the planner must fall back, not retry.
      assert.equal(error.recoverable, false);
      assert.equal(error.code, 'UNSUPPORTED_PLATFORM');
      return true;
    });
    assert.equal(children.length, spawnedSoFar, 'a degraded sidecar spawns nothing more');
    assert.match(sidecar.status().detail, /PowerShell/);
  });
});

describe('idle shutdown', () => {
  test('an idle sidecar is asked to exit, and restarts on the next call', async () => {
    const { sidecar, children, child } = harness((frame, self) => self.reply(frame.id, { n: 1 }), {
      config: () => desktopConfig({ idleShutdownMs: 30 }),
    });

    await sidecar.call('snapshot');
    const first = child();
    await new Promise((r) => setTimeout(r, 120));

    assert.ok(
      first.frames.some((f) => f.op === 'shutdown'),
      'a process that can drive the mouse should not outlive the reason it started',
    );
    assert.equal(sidecar.status().state, 'stopped');

    // Stopping is not degrading: the next call starts a fresh process.
    assert.deepEqual(await sidecar.call('snapshot'), { n: 1 });
    assert.equal(children.length, 2);
    assert.equal(sidecar.status().respawns, 0, 'a planned shutdown is not a crash');
    await sidecar.dispose();
  });

  test('the idle clock restarts with every call', async () => {
    const { sidecar, child } = harness((frame, self) => self.reply(frame.id, {}), {
      config: () => desktopConfig({ idleShutdownMs: 80 }),
    });

    for (let i = 0; i < 4; i += 1) {
      await sidecar.call('snapshot');
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(!child().frames.some((f) => f.op === 'shutdown'), 'still in use');
    await sidecar.dispose();
  });
});

describe('disabled and disposed', () => {
  test('config can switch the sidecar off entirely', async () => {
    const { sidecar, children } = harness(() => {}, {
      config: () => desktopConfig({ enabled: false }),
    });
    await assert.rejects(sidecar.call('snapshot'), /switched off/);
    assert.equal(children.length, 0);
  });

  test('a disposed client refuses further work', async () => {
    const { sidecar } = harness((frame, self) => self.reply(frame.id, {}));
    await sidecar.call('snapshot');
    await sidecar.dispose();
    await assert.rejects(sidecar.call('snapshot'), /shut down/);
  });
});

describe('finding an interpreter', () => {
  test('config beats the environment, which beats everything discovered', () => {
    const candidates = pythonCandidates('C:\\Py\\python.exe', {
      SAMIX_DESKTOP_PYTHON: 'C:\\Other\\python.exe',
    } as NodeJS.ProcessEnv);

    assert.equal(candidates[0]?.command, 'C:\\Py\\python.exe');
    assert.equal(candidates[0]?.source, 'config');
    assert.equal(candidates[1]?.command, 'C:\\Other\\python.exe');
    assert.equal(candidates[1]?.source, 'env');
  });

  test('the launcher and bare python are always available as a last resort', () => {
    const sources = pythonCandidates('', {} as NodeJS.ProcessEnv).map((c) => c.source);
    assert.ok(sources.includes('launcher'));
    assert.ok(sources.includes('path'));
    assert.ok(
      sources.indexOf('launcher') < sources.indexOf('path'),
      'py -3 is more specific than whatever "python" happens to be',
    );
  });

  test('the same interpreter is never tried twice', () => {
    const candidates = pythonCandidates('python', { SAMIX_DESKTOP_PYTHON: 'python' } as NodeJS.ProcessEnv);
    assert.equal(candidates.filter((c) => c.command === 'python').length, 1);
  });

  test('the sidecar is run unbuffered as a module', () => {
    // Without -u, Python block-buffers a piped stdout and every reply sits in
    // the buffer until the process exits.
    assert.deepEqual(sidecarArgs(), ['-u', '-m', 'samix_desktop']);
  });
});
