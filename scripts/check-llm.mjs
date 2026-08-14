#!/usr/bin/env node
/**
 * End-to-end check of the Phase 3 LLM path against the live Gemini API.
 *
 * `check-gemini.mjs` answers "does this key work, and which models can it
 * call". This answers a different and harder question: **does our own code
 * work against the real API** — the schema projection, the request envelope,
 * the response parsing, the planner's validation and the executor, all of it,
 * on the real wire.
 *
 * That distinction matters because every unit test in the suite runs against an
 * injected `fetch`. They prove the code does what we think; only this proves
 * what we think matches what Google actually accepts.
 *
 * Run: pnpm check:llm
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../packages/core/dist/index.js';
import { loadEnv } from './lib/env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const C = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  cyan: '[36m',
};

loadEnv(root);

if (!process.env['GEMINI_API_KEY']) {
  console.error(`${C.red}No GEMINI_API_KEY found.${C.reset} Add it to .env or the environment.`);
  process.exit(1);
}

// Spec §69: never touch real user data. Every run gets its own throwaway root.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samix-llm-check-'));
const runtime = createRuntime({ dataDir });

console.log(`\n  ${C.bold}SAMIX LLM end-to-end check${C.reset}`);
console.log(`  ${C.dim}planner: ${runtime.agent.status().version}  data: ${dataDir}${C.reset}`);

// ---------------------------------------------------------------------------
// 1. Does every registered tool survive projection into Gemini's dialect?
// ---------------------------------------------------------------------------
const { toFunctionDeclarations } = await import('../packages/core/dist/index.js');
const schemas = runtime.registry.toLlmSchemas('developer');
const { declarations, warnings } = toFunctionDeclarations(schemas);

console.log(`\n  ${C.bold}Tool schema projection${C.reset}`);
for (const declaration of declarations) {
  const parameters = declaration.parameters
    ? `${Object.keys(declaration.parameters.properties ?? {}).length} params`
    : 'no params';
  console.log(`    ${C.green}✓${C.reset} ${declaration.name.padEnd(24)} ${C.dim}${parameters}${C.reset}`);
}
for (const warning of warnings) console.log(`    ${C.yellow}!${C.reset} ${C.dim}${warning}${C.reset}`);

// A keyword Gemini rejects poisons the whole request, not just one tool, so
// this is asserted rather than merely displayed.
const serialised = JSON.stringify(declarations);
const forbidden = ['$ref', '$defs', '$schema', 'additionalProperties', 'allOf', 'oneOf', '"const"'];
const leaked = forbidden.filter((keyword) => serialised.includes(keyword));
if (leaked.length > 0) {
  console.log(`\n  ${C.red}✗ unsupported keywords reached the wire: ${leaked.join(', ')}${C.reset}\n`);
  runtime.shutdown();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Drive real instructions through the whole agent loop.
// ---------------------------------------------------------------------------
const CASES = [
  {
    instruction: 'What operating system and CPU is this computer running?',
    expect: 'a tool call to system.getInfo',
    want: (task) => task.steps.some((step) => step.tool === 'system.getInfo'),
  },
  {
    instruction: 'What is your current mode and which tools do you have?',
    expect: 'a tool call to agent.getStatus',
    want: (task) => task.steps.some((step) => step.tool === 'agent.getStatus'),
  },
  {
    instruction: 'Delete the thing I mentioned earlier.',
    expect: 'a clarifying question, not an action',
    // Nothing was mentioned earlier and no delete tool exists. Inventing either
    // is the failure this case is here to catch.
    want: (task) => task.steps.length === 0,
  },
];

console.log(`\n  ${C.bold}Agent loop against the live API${C.reset}`);

let failures = 0;

for (const testCase of CASES) {
  const started = Date.now();
  const outcome = await runOnce(testCase.instruction);
  const ms = Date.now() - started;

  const passed = outcome.task && testCase.want(outcome.task);
  const mark = passed ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  if (!passed) failures++;

  console.log(`\n    ${mark} ${C.cyan}"${testCase.instruction}"${C.reset}`);
  console.log(`       ${C.dim}expected: ${testCase.expect}${C.reset}`);
  console.log(`       ${C.dim}status:   ${outcome.task?.status ?? 'unknown'} in ${ms}ms${C.reset}`);

  for (const step of outcome.task?.steps ?? []) {
    console.log(
      `       ${C.dim}step:     ${step.tool} → ${step.status}` +
        `${step.verification ? ` (${step.verification.status})` : ''}${C.reset}`,
    );
  }
  if (outcome.summary) {
    console.log(`       ${C.dim}said:     ${truncate(outcome.summary, 120)}${C.reset}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Report
// ---------------------------------------------------------------------------
const llm = runtime.agent.status().subsystems.find((s) => s.name === 'llm');
console.log(`\n  ${C.bold}Result${C.reset}`);
console.log(`    llm subsystem: ${llm?.status} ${C.dim}${llm?.detail ?? ''}${C.reset}`);

runtime.shutdown();
try {
  fs.rmSync(dataDir, { recursive: true, force: true });
} catch {
  // A stray temp directory is harmless; failing teardown over it is not.
}

if (failures > 0) {
  console.log(`    ${C.red}${failures} of ${CASES.length} cases failed.${C.reset}\n`);
  process.exit(1);
}
console.log(`    ${C.green}All ${CASES.length} cases behaved as intended.${C.reset}\n`);

/** Submit one instruction and wait for the task to reach a terminal state. */
function runOnce(instruction) {
  return new Promise((resolve) => {
    let summary = '';
    const unsubscribe = runtime.bus.onAny((event) => {
      if (event.type === 'task.completed') summary = event.summary;
      if (event.type === 'task.failed') summary = event.summary;
      if (event.type === 'task.cancelled') summary = event.reason;

      if (
        event.type === 'task.completed' ||
        event.type === 'task.failed' ||
        event.type === 'task.cancelled'
      ) {
        unsubscribe();
        // The task has left `activeTask` by now, so it is read back by id.
        resolve({ task: runtime.tasks.find(event.taskId), summary });
      }
    });

    runtime.agent.submit(instruction, 'text');
  });
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
