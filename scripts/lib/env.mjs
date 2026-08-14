import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal `.env` reader for development scripts.
 *
 * Deliberately not `dotenv`: this is a dozen lines for `KEY=VALUE`, and
 * development rule 20 says not to add a dependency for something this small.
 *
 * ## Scope — read before using this anywhere else
 *
 * This is for **scripts only**. Spec §38 permits `.env` during development and
 * forbids it in production, and the boundary of that permission is
 * `DevEnvSecretStore`, which refuses to activate when `NODE_ENV=production`.
 * Nothing in `packages/` may import this: a packaged build must read its
 * credentials from the OS credential store, not from a file next to the
 * executable.
 *
 * Existing environment variables always win, so an explicitly exported value is
 * never silently overridden by a stale file.
 */
export function loadEnv(root) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return false;

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const index = trimmed.indexOf('=');
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed
      .slice(index + 1)
      .trim()
      .replace(/^["']|["']$/g, '');

    if (!process.env[key]) process.env[key] = value;
  }
  return true;
}
