#!/usr/bin/env node
/**
 * End-to-end smoke test of the PRODUCTION transport.
 *
 * Spawns the compiled core exactly as the Tauri host does — as a child process
 * speaking NDJSON over stdin/stdout — and drives a real task through it. The
 * unit suite covers the runtime in-process; this covers the pipe, which is the
 * one path a unit test cannot reach.
 *
 * Run: node scripts/smoke-core.mjs
 * Exits non-zero on the first failed expectation.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'packages', 'core', 'dist', 'main.js');

if (!fs.existsSync(entry)) {
  console.error(`Core not built. Run "pnpm build:packages" first.\nExpected: ${entry}`);
  process.exit(1);
}

// Never touch the real %APPDATA% profile (spec §69).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samix-smoke-'));

const child = spawn(process.execPath, [entry, '--data-dir', dataDir], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

const pending = new Map();
const events = [];
let nextId = 0;

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  if (line.trim() === '') return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    fail(`core wrote a non-JSON line to stdout, which corrupts the protocol:\n  ${line}`);
    return;
  }
  if (frame.kind === 'event') {
    events.push(frame.event);
  } else if (frame.kind === 'response') {
    const resolve = pending.get(frame.id);
    if (resolve) {
      pending.delete(frame.id);
      resolve(frame);
    }
  }
});

// stderr is diagnostics; surface it only if something goes wrong.
const stderrLines = [];
readline.createInterface({ input: child.stderr }).on('line', (line) => stderrLines.push(line));

function request(method, params = {}) {
  const id = `smoke_${(nextId += 1)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for "${method}"`));
    }, 15_000);
    pending.set(id, (frame) => {
      clearTimeout(timer);
      resolve(frame);
    });
    child.stdin.write(`${JSON.stringify({ kind: 'request', id, method, params })}\n`);
  });
}

const waitFor = (type, timeoutMs = 15_000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const found = events.find((e) => e.type === type);
      if (found) {
        clearInterval(poll);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`timed out waiting for event "${type}"`));
      }
    }, 25);
  });

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  [32m✓[0m ${label}`);
  } else {
    failures += 1;
    console.log(`  [31m✗[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function fail(message) {
  failures += 1;
  console.error(`  [31m✗[0m ${message}`);
}

async function main() {
  console.log('\n  SAMIX core — stdio smoke test\n');

  const handshake = await request('handshake', { protocolVersion: 1 });
  check('handshake succeeds', handshake.ok === true, JSON.stringify(handshake.error ?? {}));
  check('core reports a pid', typeof handshake.result?.pid === 'number');

  const status = await request('status.get', {});
  check('status.get returns the agent state', status.result?.state === 'idle');
  check('starts in CONTROLLED mode (spec §55)', status.result?.mode === 'controlled');

  const tools = await request('tools.list', {});
  check('two Phase 1 tools are registered', tools.result?.length === 2, JSON.stringify(tools.result));

  // --- a real task through the real pipe ---------------------------------
  const submitted = await request('task.submit', {
    instruction: 'what system am I on?',
    source: 'text',
  });
  check('task.submit accepted', submitted.ok === true);

  const completed = await waitFor('task.completed');
  check('task completed', completed.type === 'task.completed');

  const toolEvents = events.filter((e) => e.type.startsWith('tool.'));
  check('tool.started emitted', toolEvents.some((e) => e.type === 'tool.started'));
  check('tool.completed emitted', toolEvents.some((e) => e.type === 'tool.completed'));
  check('tool.verified emitted (spec §29)', toolEvents.some((e) => e.type === 'tool.verified'));

  const task = await request('task.get', { taskId: submitted.result.taskId });
  check('step succeeded and was verified', task.result?.steps?.[0]?.status === 'succeeded');
  check('the tool chosen was system.getInfo', task.result?.steps?.[0]?.tool === 'system.getInfo');

  // --- honest refusal -----------------------------------------------------
  const nonsense = await request('task.submit', {
    instruction: 'reticulate the splines on my quantum flux capacitor',
    source: 'text',
  });
  check('second task accepted after the first finished', nonsense.ok === true);
  const secondDone = await new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const found = events.filter((e) => e.type === 'task.completed')[1];
      if (found) {
        clearInterval(poll);
        resolve(found);
      } else if (Date.now() - started > 15_000) {
        clearInterval(poll);
        reject(new Error('timed out'));
      }
    }, 25);
  });
  check(
    'says honestly that it does not understand (spec §93)',
    /don't yet understand/i.test(secondDone.summary ?? ''),
    secondDone.summary,
  );

  // --- rejected input -----------------------------------------------------
  const bogus = await request('does.not.exist', {});
  check('unknown method rejected, not executed', bogus.ok === false);
  check('rejection is machine-readable', bogus.error?.code === 'TOOL_NOT_FOUND');

  // --- audit trail --------------------------------------------------------
  const auditFile = path.join(dataDir, 'logs', 'audit.log');
  await new Promise((r) => setTimeout(r, 300));
  check('audit trail written (spec §37)', fs.existsSync(auditFile));
  if (fs.existsSync(auditFile)) {
    const first = JSON.parse(fs.readFileSync(auditFile, 'utf8').trim().split('\n')[0]);
    check('audit record names the tool and outcome', first.tool === 'system.getInfo' && first.outcome === 'success');
  }

  await request('agent.shutdown', {});
}

main()
  .catch((error) => {
    fail(error.message);
    if (stderrLines.length > 0) {
      console.error('\n  core stderr:\n' + stderrLines.map((l) => `    ${l}`).join('\n'));
    }
  })
  .finally(() => {
    setTimeout(() => {
      child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
      console.log(
        failures === 0
          ? '\n  [32mAll smoke checks passed.[0m\n'
          : `\n  [31m${failures} smoke check(s) failed.[0m\n`,
      );
      process.exit(failures === 0 ? 0 : 1);
    }, 400);
  });
