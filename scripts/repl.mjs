#!/usr/bin/env node
/**
 * Interactive console for the agent core.
 *
 * Spawns the compiled core exactly as the Tauri host does — a child process
 * speaking NDJSON over stdin/stdout — and gives you a prompt. This is the
 * manual-testing tool while the desktop window is blocked, and it stays useful
 * afterwards for exercising the agent without the UI in the way.
 *
 * Run: pnpm repl
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'packages', 'core', 'dist', 'main.js');

const C = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
  magenta: '[35m',
  cyan: '[36m',
};

if (!fs.existsSync(entry)) {
  console.error(`${C.red}Core not built.${C.reset} Run "pnpm build:packages" first.`);
  process.exit(1);
}

// Real config and real logs — this is a manual driver, not a test. Pass
// --data-dir to point it somewhere disposable instead.
const args = process.argv.slice(2);
const child = spawn(process.execPath, [entry, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });

const pending = new Map();
let nextId = 0;
let pendingConfirmation = null;
let busy = false;

/**
 * Created only after the handshake completes.
 *
 * readline begins consuming stdin the moment it is constructed, so building it
 * up here would emit — and drop — every line of piped input during the two
 * startup round-trips. Interactive use never noticed; `echo ... | pnpm repl`
 * silently did nothing.
 */
let rl;

function request(method, params = {}) {
  const id = `repl_${(nextId += 1)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for "${method}"`));
    }, 30_000);
    pending.set(id, (frame) => {
      clearTimeout(timer);
      if (frame.ok) resolve(frame.result);
      else reject(new Error(`${frame.error.code}: ${frame.error.message}`));
    });
    child.stdin.write(`${JSON.stringify({ kind: 'request', id, method, params })}\n`);
  });
}

// Set once stdin ends. Piped input closes the interface while requests are
// still in flight, and prompting a closed readline throws ERR_USE_AFTER_CLOSE.
let closed = false;

const interactive = process.stdin.isTTY === true;

/** Print above the prompt without mangling what the user is typing. */
function say(line) {
  if (interactive && !closed) {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
  }
  process.stdout.write(`${line}\n`);
  prompt();
}

function prompt() {
  if (rl && !closed && interactive) rl.prompt(true);
}

// --- core stdout: protocol frames -----------------------------------------
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  if (line.trim() === '') return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    say(`${C.red}core wrote a non-JSON line to stdout (protocol corruption):${C.reset} ${line}`);
    return;
  }

  if (frame.kind === 'response') {
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
    return;
  }
  if (frame.kind === 'event') render(frame.event);
});

// stderr holds the core's own logs; shown only with --verbose.
const verbose = args.includes('--verbose');
readline.createInterface({ input: child.stderr }).on('line', (line) => {
  if (verbose) say(`${C.dim}${line}${C.reset}`);
});

child.on('exit', (code) => {
  say(`${C.red}core exited (${code}).${C.reset}`);
  process.exit(code ?? 0);
});

// --- event rendering -------------------------------------------------------
function render(event) {
  switch (event.type) {
    case 'agent.plan.created':
      say(`${C.dim}plan:${C.reset}`);
      for (const step of event.steps) {
        say(`  ${C.dim}${step.index + 1}.${C.reset} ${step.description} ${C.dim}[${step.tool}]${C.reset}`);
      }
      break;

    case 'tool.started':
      say(`  ${C.blue}→${C.reset} ${event.tool}`);
      break;

    case 'tool.completed':
      say(`  ${C.green}✓${C.reset} ${event.tool} ${C.dim}${event.durationMs}ms${C.reset}`);
      break;

    case 'tool.failed':
      say(`  ${C.red}✕${C.reset} ${event.tool} ${C.dim}${event.error.code}:${C.reset} ${event.error.message}`);
      break;

    case 'tool.verified': {
      const v = event.verification;
      const colour =
        v.status === 'verified' ? C.green : v.status === 'failed' ? C.red : C.yellow;
      say(`  ${colour}verify:${C.reset} ${v.status} ${C.dim}${v.detail}${C.reset}`);
      break;
    }

    case 'permission.denied':
      say(`  ${C.red}blocked:${C.reset} ${event.reason}`);
      break;

    case 'confirmation.required': {
      const r = event.request;
      pendingConfirmation = r;
      say('');
      say(`${C.yellow}${C.bold}CONFIRMATION REQUIRED${C.reset} ${C.dim}(${r.permission})${C.reset}`);
      say(`  ${r.effect}`);
      say(`  ${C.dim}${r.reason}${C.reset}`);
      for (const fact of r.facts) say(`  ${C.dim}${fact.label}:${C.reset} ${fact.value}`);
      say(`  ${C.dim}reply${C.reset} y ${C.dim}=approve,${C.reset} a ${C.dim}=approve rest,${C.reset} n ${C.dim}=decline${C.reset}`);
      break;
    }

    case 'task.completed':
      busy = false;
      say(`${C.green}agent:${C.reset} ${event.summary}\n`);
      break;

    case 'task.failed':
      busy = false;
      say(`${C.red}agent:${C.reset} ${event.summary} ${C.dim}(${event.error.code})${C.reset}\n`);
      break;

    case 'task.cancelled':
      busy = false;
      say(`${C.yellow}agent:${C.reset} stopped — ${event.reason}\n`);
      break;

    case 'agent.error':
      say(`${C.red}error:${C.reset} ${event.error.message}`);
      break;

    default:
      break;
  }
}

// --- commands --------------------------------------------------------------
const HELP = `
${C.bold}Commands${C.reset}
  ${C.cyan}/status${C.reset}          agent state, mode, subsystem readiness
  ${C.cyan}/tools${C.reset}           tools available in the current mode
  ${C.cyan}/mode <name>${C.reset}     safe | controlled | autonomous | developer
  ${C.cyan}/config${C.reset}          current configuration
  ${C.cyan}/history${C.reset}         recent tasks
  ${C.cyan}/logs [n]${C.reset}        last n log entries (default 20)
  ${C.cyan}/stop${C.reset}            emergency stop
  ${C.cyan}/cancel${C.reset}          cancel the running task
  ${C.cyan}/help${C.reset}            this list
  ${C.cyan}/quit${C.reset}            shut down and exit

Anything else is sent to the agent as an instruction.
`;

async function handle(input) {
  const line = input.trim();
  if (line === '') return;

  // A pending confirmation swallows the next input.
  if (pendingConfirmation) {
    const answer = line.toLowerCase();
    const approved = answer === 'y' || answer === 'yes' || answer === 'a';
    const all = answer === 'a';
    const id = pendingConfirmation.id;
    pendingConfirmation = null;
    await request('confirmation.respond', { id, approved, approveRemainingInTask: all });
    return;
  }

  if (!line.startsWith('/')) {
    if (busy) {
      say(`${C.yellow}a task is already running — /cancel it first${C.reset}`);
      return;
    }
    busy = true;
    say(`${C.dim}you: ${line}${C.reset}`);
    await request('task.submit', { instruction: line, source: 'text' });
    return;
  }

  const [command, ...rest] = line.slice(1).split(/\s+/);
  switch (command) {
    case 'help':
      say(HELP);
      break;

    case 'status': {
      const s = await request('status.get', {});
      say(`state ${C.bold}${s.state}${C.reset}   mode ${C.bold}${s.mode}${C.reset}   v${s.version}`);
      for (const sub of s.subsystems) {
        const colour =
          sub.status === 'ready' ? C.green : sub.status === 'not-implemented' ? C.dim : C.yellow;
        say(`  ${colour}${sub.status.padEnd(16)}${C.reset} ${sub.name.padEnd(14)} ${C.dim}${sub.detail ?? ''}${C.reset}`);
      }
      break;
    }

    case 'tools': {
      const tools = await request('tools.list', {});
      if (tools.length === 0) say(`${C.dim}no tools available in this mode${C.reset}`);
      for (const t of tools) {
        say(`  ${C.cyan}${t.name}${C.reset} ${C.dim}[${t.permission}, ${t.reversibility}, verify:${t.verification}]${C.reset}`);
        say(`    ${C.dim}${t.description.slice(0, 100)}…${C.reset}`);
      }
      break;
    }

    case 'mode': {
      const mode = rest[0];
      if (!mode) {
        say(`${C.yellow}usage: /mode safe|controlled|autonomous|developer${C.reset}`);
        break;
      }
      const s = await request('agent.mode.set', { mode });
      say(`mode is now ${C.bold}${s.mode}${C.reset}`);
      break;
    }

    case 'config': {
      const c = await request('config.get', {});
      say(JSON.stringify(c, null, 2));
      break;
    }

    case 'history': {
      const tasks = await request('task.history', { limit: 10 });
      if (tasks.length === 0) say(`${C.dim}no tasks yet${C.reset}`);
      for (const t of tasks) {
        say(`  ${C.dim}${t.id}${C.reset} ${t.status.padEnd(10)} ${t.instruction}`);
      }
      break;
    }

    case 'logs': {
      const limit = Number(rest[0] ?? 20);
      const entries = await request('logs.tail', { limit });
      for (const e of entries) {
        say(`  ${C.dim}${e.timestamp.slice(11, 19)}${C.reset} ${e.level.padEnd(5)} ${C.dim}${e.scope}${C.reset} ${e.message}`);
      }
      break;
    }

    case 'stop': {
      const r = await request('agent.emergencyStop', {});
      busy = false;
      say(`${C.yellow}emergency stop${C.reset} ${r.cancelledTaskId ? `— cancelled ${r.cancelledTaskId}` : ''}`);
      break;
    }

    case 'cancel': {
      const r = await request('task.cancel', { reason: 'user requested' });
      say(r.cancelled ? `${C.yellow}cancelling…${C.reset}` : `${C.dim}nothing running${C.reset}`);
      break;
    }

    case 'quit':
    case 'exit':
      await request('agent.shutdown', {});
      setTimeout(() => process.exit(0), 200);
      break;

    default:
      say(`${C.yellow}unknown command "/${command}" — try /help${C.reset}`);
  }
}

// --- start -----------------------------------------------------------------
(async () => {
  try {
    const hello = await request('handshake', { protocolVersion: 1 });
    const status = await request('status.get', {});
    console.log(
      `\n${C.bold}SAMIX Agent${C.reset} ${C.dim}core v${hello.version}, pid ${hello.pid}${C.reset}`,
    );
    console.log(`${C.dim}mode ${status.mode} · ${status.subsystems.filter((s) => s.status === 'ready').length} subsystems ready · /help for commands${C.reset}\n`);
  } catch (error) {
    console.error(`${C.red}could not reach the core:${C.reset} ${error.message}`);
    process.exit(1);
  }

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.cyan}samix>${C.reset} `,
  });
  rl.on('close', () => {
    closed = true;
  });

  prompt();

  // Serialise input: each line must finish before the next is handled, or a
  // piped script races its own confirmation replies.
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    queue = queue
      .then(() => handle(line))
      .catch((error) => say(`${C.red}${error.message}${C.reset}`))
      .finally(() => prompt());
  });

  rl.on('close', () => {
    // Let in-flight work settle, then shut the core down cleanly rather than
    // orphaning it.
    void queue.finally(() => {
      setTimeout(() => {
        child.kill();
        process.exit(0);
      }, 1500);
    });
  });
})();
