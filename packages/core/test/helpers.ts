import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Test helpers for the Node built-in runner.
 *
 * The suite uses `node --test` with Node's native TypeScript type stripping
 * rather than Vitest. Two reasons, in order:
 *
 *  1. Vitest's esbuild binary does not execute in this environment — it spawns
 *     and then spins without ever producing output, so no test could run at all.
 *  2. Development rule 20 (no unnecessary dependencies). The built-in runner
 *     needs no transform pipeline, so the test suite gains a dependency-free
 *     path that will keep working.
 *
 * Tests import from `../dist/`, i.e. the compiled artifact that actually ships,
 * because type stripping deliberately does not resolve a `./x.js` specifier to
 * `x.ts`. Run `pnpm build` before `pnpm test`; the `test` script does this.
 */

/** Assert that `actual` contains at least the properties of `expected`. */
export function matchObject(
  actual: unknown,
  expected: Record<string, unknown>,
  pathPrefix = '',
): void {
  assert.ok(
    typeof actual === 'object' && actual !== null,
    `${pathPrefix || 'value'} should be an object, got ${String(actual)}`,
  );
  const source = actual as Record<string, unknown>;
  for (const [key, want] of Object.entries(expected)) {
    const where = pathPrefix ? `${pathPrefix}.${key}` : key;
    const got = source[key];
    if (want instanceof RegExp) {
      assert.ok(
        typeof got === 'string' && want.test(got),
        `${where}: expected ${String(got)} to match ${want}`,
      );
    } else if (typeof want === 'object' && want !== null && !Array.isArray(want)) {
      matchObject(got, want as Record<string, unknown>, where);
    } else {
      assert.deepStrictEqual(got, want, `${where} mismatch`);
    }
  }
}

/** Assert an array includes a value, with a readable failure message. */
export function includes<T>(haystack: readonly T[], needle: T, label = 'array'): void {
  assert.ok(haystack.includes(needle), `${label} should include ${String(needle)}`);
}

export function excludes<T>(haystack: readonly T[], needle: T, label = 'array'): void {
  assert.ok(!haystack.includes(needle), `${label} should NOT include ${String(needle)}`);
}

/** Minimal call spy — Node's `mock.fn()` equivalent, without the import churn. */
export function spy<A extends unknown[] = unknown[]>(): {
  (...args: A): void;
  calls: A[];
  get count(): number;
} {
  const calls: A[] = [];
  const fn = (...args: A): void => {
    calls.push(args);
  };
  return Object.defineProperties(fn, {
    calls: { value: calls },
    count: { get: () => calls.length },
  }) as ReturnType<typeof spy<A>>;
}

/**
 * Wait for a file to appear and become non-empty.
 *
 * The log and audit writers use `fs.createWriteStream`, which opens the file
 * asynchronously — so a synchronous `existsSync` immediately after a write can
 * legitimately return false even though nothing is wrong. Polling here keeps
 * the assertion about *content* rather than about I/O scheduling.
 */
export async function waitForFile(file: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const contents = fs.readFileSync(file, 'utf8');
      if (contents.trim() !== '') return contents;
    } catch {
      // Not created yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${file} to have content`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Parse an NDJSON file into records, waiting for it to be flushed first. */
export async function readNdjson(file: string): Promise<Record<string, unknown>[]> {
  const contents = await waitForFile(file);
  return contents
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Create a throwaway data directory. Spec §69: automated tests never touch real
 * user data, so every test that writes gets its own temp root.
 */
export function tempDir(prefix = 'samix-test-'): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows can hold a brief lock on a just-closed log stream. A leftover
        // temp directory is harmless; failing teardown over it is not.
      }
    },
  };
}
