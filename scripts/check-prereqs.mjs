#!/usr/bin/env node
/**
 * Environment check (spec §100: inspect the environment before building).
 *
 * Reports what is present, what is missing, and what each missing piece blocks
 * — so a new contributor learns whether they can work on the agent core (needs
 * only Node) or the desktop shell (needs the full Rust and MSVC toolchain).
 *
 * Exits non-zero only when something required for the CORE is missing. A missing
 * Rust toolchain is reported but not fatal, because most work does not need it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

/** Run a command and return trimmed stdout, or undefined if it fails. */
function probe(command, args = ['--version']) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      shell: process.platform === 'win32',
    })
      .split('\n')[0]
      .trim();
  } catch {
    return undefined;
  }
}

const checks = [
  {
    name: 'Node.js',
    required: true,
    needed: 'the agent core',
    detect: () => process.version,
    validate: (v) => Number(v.slice(1).split('.')[0]) >= 20,
    fix: 'Install Node 20.11 or newer: winget install OpenJS.NodeJS.LTS',
  },
  {
    name: 'pnpm',
    required: true,
    needed: 'the workspace',
    detect: () => probe('pnpm'),
    fix: 'npm install -g pnpm',
  },
  {
    name: 'Git',
    required: false,
    needed: 'version control',
    detect: () => probe('git'),
    fix: 'winget install Git.Git',
  },
  {
    name: 'Rust (cargo)',
    required: false,
    needed: 'the desktop shell',
    // A freshly installed rustup is not on PATH until the shell restarts, so
    // fall back to its default location before reporting it missing.
    detect: () => {
      const onPath = probe('cargo');
      if (onPath) return onPath;
      const fallback = path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe');
      return existsSync(fallback) ? `${probe(fallback) ?? 'installed'} (restart your shell)` : undefined;
    },
    fix: 'winget install Rustlang.Rustup',
  },
  {
    name: 'MSVC linker',
    required: false,
    needed: 'the desktop shell',
    detect: () => {
      const vswhere = path.join(
        process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
        'Microsoft Visual Studio',
        'Installer',
        'vswhere.exe',
      );
      if (!existsSync(vswhere)) return undefined;
      return probe(vswhere, ['-products', '*', '-latest', '-property', 'displayName']);
    },
    fix: 'winget install Microsoft.VisualStudio.2022.BuildTools, then add the "Desktop development with C++" workload',
  },
  {
    name: 'Python',
    required: false,
    needed: 'speech recognition (Phase 2)',
    detect: () => probe('python') ?? probe('py'),
    fix: 'winget install Python.Python.3.12',
  },
];

console.log(`\n  SAMIX Agent — environment check`);
console.log(`  ${DIM}${os.type()} ${os.release()} (${os.arch()})${RESET}\n`);

let fatal = 0;
let warnings = 0;

for (const check of checks) {
  const value = check.detect();
  const ok = value !== undefined && (check.validate?.(value) ?? true);

  if (ok) {
    console.log(`  ${GREEN}✓${RESET} ${check.name.padEnd(16)} ${DIM}${value}${RESET}`);
    continue;
  }

  if (check.required) {
    fatal += 1;
    console.log(`  ${RED}✗${RESET} ${check.name.padEnd(16)} missing — blocks ${check.needed}`);
    console.log(`    ${DIM}${check.fix}${RESET}`);
  } else {
    warnings += 1;
    console.log(`  ${YELLOW}!${RESET} ${check.name.padEnd(16)} missing — needed for ${check.needed}`);
    console.log(`    ${DIM}${check.fix}${RESET}`);
  }
}

console.log();

if (fatal > 0) {
  console.log(`  ${RED}${fatal} required tool(s) missing.${RESET} The agent core cannot be built.\n`);
  process.exit(1);
}

if (warnings > 0) {
  console.log(
    `  ${YELLOW}${warnings} optional tool(s) missing.${RESET} You can build and test the agent core;\n` +
      `  the desktop shell and later phases need the items above.\n`,
  );
} else {
  console.log(`  ${GREEN}Everything needed is present.${RESET}\n`);
}
