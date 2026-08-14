#!/usr/bin/env node
/**
 * Verify the configured Gemini credentials and pick a model.
 *
 * Answers three questions empirically rather than from documentation, because
 * model availability differs by key, tier and region:
 *
 *   1. Does the key authenticate at all?
 *   2. Which models can this key actually call?
 *   3. Do those models support FUNCTION CALLING with our tool schemas?
 *
 * (3) is the one that matters. A model that generates text but cannot call
 * tools is useless to this project — spec §6 requires tool calling, and the
 * whole architecture routes action through tools.
 *
 * Run: pnpm check:gemini
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Minimal .env reader — no dependency for one file with simple KEY=VALUE lines. */
function loadEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv();

const KEY = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
if (!KEY) {
  console.error(`${C.red}No GEMINI_API_KEY found.${C.reset} Add it to .env or the environment.`);
  process.exit(1);
}

/** Never print the key. Show only enough to identify which one is in use. */
const fingerprint = `${KEY.slice(0, 6)}…${KEY.slice(-4)} (${KEY.length} chars)`;

const BASE = 'https://generativelanguage.googleapis.com';

async function call(pathname, init = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { 'x-goog-api-key': KEY, 'content-type': 'application/json', ...init.headers },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: response.status, ok: response.ok, body };
}

console.log(`\n  ${C.bold}Gemini credential check${C.reset}`);
console.log(`  ${C.dim}key: ${fingerprint}${C.reset}\n`);

// --- 1. authentication + model list ----------------------------------------
const list = await call('/v1beta/models?pageSize=200');

if (!list.ok) {
  const message = list.body?.error?.message ?? JSON.stringify(list.body).slice(0, 300);
  const status = list.body?.error?.status ?? list.status;
  console.log(`  ${C.red}✗ authentication failed${C.reset}  ${C.dim}HTTP ${list.status} ${status}${C.reset}`);
  console.log(`\n  ${message}\n`);

  // The most common cause is a token of the wrong kind, so name it explicitly.
  if (!/^AIza/.test(KEY)) {
    console.log(
      `  ${C.yellow}Note:${C.reset} Gemini API keys from AI Studio begin with ${C.bold}AIza${C.reset} and are ~39 characters.\n` +
        `  This credential does not match that shape, so it is probably not an API key —\n` +
        `  ephemeral/OAuth tokens (which start with ${C.bold}AQ.${C.reset}) are short-lived and are not\n` +
        `  accepted by the generateContent endpoints.\n\n` +
        `  Create a real API key at ${C.cyan}https://aistudio.google.com/apikey${C.reset}\n`,
    );
  }
  process.exit(1);
}

const models = (list.body.models ?? []).filter((m) =>
  (m.supportedGenerationMethods ?? []).includes('generateContent'),
);

console.log(`  ${C.green}✓ authenticated${C.reset}  ${C.dim}${models.length} models support generateContent${C.reset}\n`);

// Prefer current, non-preview, non-deprecated models; newest generation first.
const ranked = models
  .map((m) => ({
    id: m.name.replace(/^models\//, ''),
    display: m.displayName ?? '',
    inputTokens: m.inputTokenLimit ?? 0,
    outputTokens: m.outputTokenLimit ?? 0,
  }))
  .filter((m) => !/embedding|aqa|imagen|veo|tts|image-generation|native-audio/.test(m.id))
  .sort((a, b) => b.inputTokens - a.inputTokens || a.id.localeCompare(b.id));

console.log(`  ${C.bold}Candidate models${C.reset}`);
for (const m of ranked.slice(0, 18)) {
  console.log(
    `    ${C.cyan}${m.id.padEnd(42)}${C.reset} ${C.dim}in ${String(m.inputTokens).padStart(9)}  out ${String(m.outputTokens).padStart(6)}${C.reset}`,
  );
}
if (ranked.length > 18) console.log(`    ${C.dim}… and ${ranked.length - 18} more${C.reset}`);

// --- 2. function calling, with a schema shaped like a real SAMIX tool -------
//
// This mirrors what registry.toLlmSchemas() will emit for a filesystem tool:
// nested object, enum, optional fields. If a model cannot handle this, it
// cannot drive the agent.
const toolTest = {
  tools: [
    {
      functionDeclarations: [
        {
          name: 'filesystem_search',
          description: 'Search the filesystem for files matching a query.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What to search for' },
              extension: { type: 'string', description: 'File extension filter, e.g. .pdf' },
              sortBy: { type: 'string', enum: ['modified', 'created', 'name', 'size'] },
              limit: { type: 'integer', description: 'Maximum results' },
            },
            required: ['query'],
          },
        },
      ],
    },
  ],
  contents: [
    { role: 'user', parts: [{ text: 'Find the most recently modified PDF in my Downloads folder.' }] },
  ],
};

/**
 * Rank candidates by generation, newest first, preferring stable over preview.
 *
 * Sorting by context window (as a first attempt did) is useless — every current
 * Gemini model reports the same 1,048,576 — so it degenerated into alphabetical
 * order and tested the oldest models first.
 */
function generationOf(id) {
  const match = /^gemini-(\d+(?:\.\d+)?)/.exec(id);
  return match ? Number.parseFloat(match[1]) : 0;
}

const shortlist = ranked
  .filter((m) => /^gemini-/.test(m.id))
  .filter((m) => !/customtools|thinking|exp-/.test(m.id))
  .sort((a, b) => {
    // `-latest` aliases first: they track whatever Google considers current.
    const aliasA = a.id.endsWith('-latest') ? 1 : 0;
    const aliasB = b.id.endsWith('-latest') ? 1 : 0;
    if (aliasA !== aliasB) return aliasB - aliasA;

    const genDiff = generationOf(b.id) - generationOf(a.id);
    if (genDiff !== 0) return genDiff;

    const previewA = /preview/.test(a.id) ? 1 : 0;
    const previewB = /preview/.test(b.id) ? 1 : 0;
    if (previewA !== previewB) return previewA - previewB;

    // Pro before Flash before Flash-Lite, strongest first.
    const tier = (id) => (/pro/.test(id) ? 0 : /lite/.test(id) ? 2 : 1);
    return tier(a.id) - tier(b.id);
  })
  .slice(0, 12)
  .map((m) => m.id);

console.log(`\n  ${C.bold}Function-calling probe${C.reset} ${C.dim}(the capability this project needs)${C.reset}`);

const results = [];
for (const id of shortlist) {
  const start = Date.now();
  const response = await call(`/v1beta/models/${id}:generateContent`, {
    method: 'POST',
    body: JSON.stringify(toolTest),
  });
  const ms = Date.now() - start;

  if (!response.ok) {
    const status = response.body?.error?.status;
    const message = response.body?.error?.message ?? `HTTP ${response.status}`;

    // A quota refusal is categorically different from an unavailable model:
    // the model exists and would work, the key just is not entitled to it (or
    // is rate limited). Conflating the two would hide a usable model.
    if (status === 'RESOURCE_EXHAUSTED' || response.status === 429) {
      console.log(
        `    ${C.yellow}$${C.reset} ${id.padEnd(42)} ${C.dim}quota/billing — model exists, key not entitled${C.reset}`,
      );
      results.push({ id, ok: false, ms, quota: true });
    } else {
      console.log(`    ${C.red}✗${C.reset} ${id.padEnd(42)} ${C.dim}${message.slice(0, 60)}${C.reset}`);
      results.push({ id, ok: false, ms, unavailable: true });
    }
    continue;
  }

  const parts = response.body?.candidates?.[0]?.content?.parts ?? [];
  const fnCall = parts.find((p) => p.functionCall)?.functionCall;

  if (fnCall?.name === 'filesystem_search') {
    console.log(
      `    ${C.green}✓${C.reset} ${id.padEnd(42)} ${C.dim}${String(ms).padStart(5)}ms  called ${fnCall.name}(${Object.keys(fnCall.args ?? {}).join(', ')})${C.reset}`,
    );
    results.push({ id, ok: true, ms, args: fnCall.args });
  } else {
    console.log(
      `    ${C.yellow}~${C.reset} ${id.padEnd(42)} ${C.dim}${String(ms).padStart(5)}ms  replied with text, did not call the tool${C.reset}`,
    );
    results.push({ id, ok: false, ms, textOnly: true });
  }
}

// --- 3. recommendation ------------------------------------------------------
const working = results.filter((r) => r.ok);
const quotaBlocked = results.filter((r) => r.quota);

console.log(`\n  ${C.bold}Result${C.reset}`);
if (working.length === 0) {
  console.log(`    ${C.red}No model completed a tool call.${C.reset} Phase 3 cannot proceed on this key.\n`);
  process.exit(1);
}

// `shortlist` is already ordered strongest-first, so `working` preserves that.
const strongest = working[0];
const fastest = [...working].sort((a, b) => a.ms - b.ms)[0];
const lite = working.find((r) => /lite/.test(r.id)) ?? fastest;

console.log(`    planner   ${C.cyan}${strongest.id}${C.reset} ${C.dim}${strongest.ms}ms — verified tool calling${C.reset}`);
console.log(`    fast      ${C.cyan}${lite.id}${C.reset} ${C.dim}${lite.ms}ms — classification and routing${C.reset}`);
console.log(`    vision    ${C.cyan}${strongest.id}${C.reset} ${C.dim}(Phase 11)${C.reset}`);

if (quotaBlocked.length > 0) {
  console.log(
    `\n  ${C.yellow}Quota-blocked but otherwise usable:${C.reset} ${quotaBlocked.map((r) => r.id).join(', ')}` +
      `\n  ${C.dim}These would likely be stronger planners. Enabling billing makes them available.${C.reset}`,
  );
}

console.log(
  `\n  ${C.dim}Apply with:${C.reset}\n` +
    `    ${C.dim}"llm": { "plannerModel": "${strongest.id}", "fastModel": "${lite.id}", "visionModel": "${strongest.id}" }${C.reset}\n` +
    `  ${C.dim}in %APPDATA%\\SamixAgent\\config.json, or via the Settings pane.${C.reset}\n`,
);
