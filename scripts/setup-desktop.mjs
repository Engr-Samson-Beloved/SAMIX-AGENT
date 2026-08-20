#!/usr/bin/env node
/**
 * Build the Python environment the desktop sidecar runs in (Phase 7 §2).
 *
 * Creates `packages/core/python/.venv` and installs the pinned requirements into
 * it. A dedicated virtual environment rather than the user's global Python for
 * two reasons: the pins are ours to control, and an agent that installs packages
 * into someone's system interpreter has reached outside what it was asked to do.
 *
 * Everything here is optional. If it is never run, the agent still starts and
 * window management still works through the existing PowerShell path — slower,
 * and `/status` says so.
 *
 * Run: pnpm setup:desktop
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidecar = path.join(root, 'packages', 'core', 'python');
const venv = path.join(sidecar, '.venv');
const venvPython = path.join(venv, 'Scripts', 'python.exe');
const requirements = path.join(sidecar, 'requirements.txt');

const green = (s) => `[32m${s}[0m`;
const red = (s) => `[31m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;

console.log('\n  SAMIX desktop sidecar — environment setup\n');

if (process.platform !== 'win32') {
  console.log(`  ${red('Desktop control is Windows only.')}\n`);
  process.exit(1);
}

function run(command, args, label) {
  console.log(`  ${dim(`$ ${command} ${args.join(' ')}`)}`);
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: sidecar });
  if (result.error || result.status !== 0) {
    console.log(`\n  ${red('✗')} ${label} failed.\n`);
    process.exit(1);
  }
}

/** The first interpreter that can actually build a venv. */
function findPython() {
  for (const [command, args] of [
    ['py', ['-3']],
    ['python', []],
    ['python3', []],
  ]) {
    const probe = spawnSync(command, [...args, '--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) {
      return { command, args, version: (probe.stdout || probe.stderr).trim() };
    }
  }
  return undefined;
}

const python = findPython();
if (!python) {
  console.log(`  ${red('✗')} No Python 3 found on PATH.`);
  console.log(`    Install it from https://www.python.org/downloads/ or the Microsoft Store,`);
  console.log(`    then run this again. The agent works without it; desktop control does not.\n`);
  process.exit(1);
}
console.log(`  ${green('✓')} Found ${python.version}\n`);

if (!fs.existsSync(venvPython)) {
  run(python.command, [...python.args, '-m', 'venv', venv], 'Creating the virtual environment');
} else {
  console.log(`  ${green('✓')} Virtual environment already exists\n`);
}

run(
  venvPython,
  ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', requirements],
  'Installing dependencies',
);

// Prove it works rather than assuming the install succeeded, and prove it in the
// one way that matters: the module has to import and reach UI Automation.
const probe = spawnSync(
  venvPython,
  ['-c', 'import uiautomation, comtypes; print(uiautomation.__name__, comtypes.__name__)'],
  { encoding: 'utf8', cwd: sidecar },
);
if (probe.status !== 0) {
  console.log(`\n  ${red('✗')} The dependencies installed but will not import.`);
  console.log(`    ${(probe.stderr || '').trim()}\n`);
  process.exit(1);
}

console.log(`\n  ${green('✓')} Desktop sidecar environment ready`);
console.log(`    ${dim(venvPython)}`);
console.log(`\n  Check it against your real desktop with: ${green('pnpm check:desktop')}\n`);
