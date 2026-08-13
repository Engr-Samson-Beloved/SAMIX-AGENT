import fs from 'node:fs';
import path from 'node:path';
import {
  AppConfigPatchSchema,
  AppConfigSchema,
  CONFIG_SCHEMA_VERSION,
  defaultConfig,
  type AppConfig,
  type AppConfigPatch,
} from '@samix/shared';
import type { Logger } from '../observability/logger.js';
import { nullLogger } from '../observability/logger.js';
import type { AppPaths } from './paths.js';
import { defaultTrustedFolders } from './paths.js';
import { migrateConfig } from './migrations.js';

/**
 * Configuration store (spec §44, §84).
 *
 * Guarantees, in priority order:
 *
 *  1. **Startup never fails because of config.** A missing, truncated,
 *     malformed or hand-edited file degrades to defaults with a warning. An
 *     agent that refuses to launch because one JSON key is wrong is a worse
 *     product than one that launches with defaults and says so.
 *  2. **Writes are atomic.** Written to a temp file in the same directory then
 *     renamed over the target, so a crash or power loss mid-write can never
 *     leave a half-written config. Same-directory matters: rename is only
 *     atomic within a volume.
 *  3. **Corruption is preserved, not discarded.** A file that fails to parse is
 *     moved aside as `config.corrupt-<timestamp>.json` rather than overwritten,
 *     because it may hold settings the user wants back.
 */
export class ConfigStore {
  private config: AppConfig;
  private readonly listeners = new Set<(config: AppConfig) => void>();
  private readonly log: Logger;

  private constructor(
    private readonly paths: AppPaths,
    initial: AppConfig,
    logger: Logger,
  ) {
    this.config = initial;
    this.log = logger;
  }

  /**
   * Load from disk, seeding a default file on first run.
   *
   * Takes a logger rather than creating one because the logger's own settings
   * live in this config — the bootstrap order is: temp logger → config → real
   * logger. See runtime.ts.
   */
  static load(paths: AppPaths, logger: Logger = nullLogger()): ConfigStore {
    const store = new ConfigStore(paths, defaultConfig(), logger);
    store.config = store.readFromDisk();
    return store;
  }

  get(): AppConfig {
    // Structured clone: callers must not be able to mutate stored state in
    // place and bypass validation and change notification.
    return structuredClone(this.config);
  }

  /**
   * Apply a partial update. Validated as a patch first, then the merged result
   * is validated in full — so a patch can never produce an invalid config even
   * if each individual field looked acceptable.
   */
  update(patch: AppConfigPatch): AppConfig {
    const parsedPatch = AppConfigPatchSchema.parse(patch);
    const merged = AppConfigSchema.parse(mergeConfig(this.config, parsedPatch));
    this.config = merged;
    this.persist();
    this.notify();
    this.log.info('configuration updated', { sections: Object.keys(parsedPatch) });
    return this.get();
  }

  reset(): AppConfig {
    this.config = this.seedFirstRunDefaults(defaultConfig());
    this.persist();
    this.notify();
    this.log.warn('configuration reset to defaults');
    return this.get();
  }

  onChange(listener: (config: AppConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Disk
  // -------------------------------------------------------------------------

  private readFromDisk(): AppConfig {
    const { configFile } = this.paths;

    if (!fs.existsSync(configFile)) {
      const seeded = this.seedFirstRunDefaults(defaultConfig());
      this.config = seeded;
      this.persist();
      this.log.info('created default configuration', { path: configFile });
      return seeded;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (error) {
      this.quarantine(configFile, `unparseable JSON: ${String(error)}`);
      const seeded = this.seedFirstRunDefaults(defaultConfig());
      this.config = seeded;
      this.persist();
      return seeded;
    }

    const migration = migrateConfig(raw);
    if (migration.fromFuture) {
      this.log.error('configuration was written by a newer version; running on defaults', {
        fileVersion: (raw as Record<string, unknown>)['schemaVersion'],
        supportedVersion: CONFIG_SCHEMA_VERSION,
      });
      // Do NOT persist over it. The user may downgrade-and-upgrade again and
      // expect their settings intact.
      return this.seedFirstRunDefaults(defaultConfig());
    }
    if (migration.applied.length > 0) {
      this.log.info('migrated configuration', { steps: migration.applied });
    }

    const parsed = AppConfigSchema.safeParse(migration.data);
    if (!parsed.success) {
      // Field-level recovery: keep whatever validated, default the rest. Better
      // than discarding an entire config over one bad key.
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      this.log.warn('configuration had invalid fields; defaults applied to those fields', { issues });
      const recovered = AppConfigSchema.parse(stripInvalidPaths(migration.data, parsed.error.issues));
      this.config = recovered;
      this.persist();
      return recovered;
    }

    // Rewrite if migration changed anything, so the file on disk is current.
    if (migration.applied.length > 0) {
      this.config = parsed.data;
      this.persist();
    }
    return parsed.data;
  }

  /**
   * First-run values that must be computed from the live machine rather than
   * committed as literals — spec §85 trusted folders depend on the real user
   * profile path.
   */
  private seedFirstRunDefaults(config: AppConfig): AppConfig {
    if (config.security.trustedFolders.length > 0) return config;
    return {
      ...config,
      security: { ...config.security, trustedFolders: defaultTrustedFolders() },
    };
  }

  private persist(): void {
    const { configFile } = this.paths;
    // Same-directory temp file: rename is only atomic within one volume.
    const tmp = path.join(path.dirname(configFile), `.config.${process.pid}.tmp`);
    try {
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(this.config, null, 2)}\n`, { encoding: 'utf8' });
      fs.renameSync(tmp, configFile);
    } catch (error) {
      this.log.error('failed to persist configuration', { path: configFile, error: String(error) });
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Best-effort cleanup; the original failure is already reported.
      }
    }
  }

  private quarantine(file: string, reason: string): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(path.dirname(file), `config.corrupt-${stamp}.json`);
    try {
      fs.renameSync(file, target);
      this.log.error('configuration file was unreadable and has been set aside', {
        reason,
        movedTo: target,
      });
    } catch (error) {
      this.log.error('configuration file was unreadable and could not be set aside', {
        reason,
        error: String(error),
      });
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.get());
      } catch (error) {
        this.log.error('config change listener threw', { error: String(error) });
      }
    }
  }
}

/**
 * A patch over `T`: every key optional AND explicitly allowed to be undefined.
 *
 * `Partial<T>` is not equivalent under `exactOptionalPropertyTypes` — it means
 * "may be absent" but NOT "may be present holding undefined", which is exactly
 * what Zod's `.partial()` output produces.
 */
type PatchOf<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * Section-wise merge. Config is exactly two levels deep by design, so a general
 * recursive deep-merge would be more machinery than the shape needs — and would
 * introduce ambiguity about array handling that we do not want.
 *
 * Arrays are REPLACED, not concatenated: "set my trusted folders to X" must not
 * silently append to a list the user thought they were replacing.
 */
export function mergeConfig(base: AppConfig, patch: AppConfigPatch): AppConfig {
  const out: AppConfig = structuredClone(base);
  if (patch.hotkey !== undefined) out.hotkey = patch.hotkey;
  out.llm = applyDefined(out.llm, patch.llm);
  out.voice = applyDefined(out.voice, patch.voice);
  out.tts = applyDefined(out.tts, patch.tts);
  out.automation = applyDefined(out.automation, patch.automation);
  out.security = applyDefined(out.security, patch.security);
  out.logging = applyDefined(out.logging, patch.logging);
  out.ui = applyDefined(out.ui, patch.ui);
  return out;
}

/**
 * Copy only the keys the patch actually sets.
 *
 * A plain spread would write `undefined` over a good value for every key the
 * patch omits — `{...base, ...{theme: undefined}}` yields `theme: undefined`.
 * With `exactOptionalPropertyTypes` that is also a type error, which is the
 * compiler catching a real bug: "update just the hotkey" must not blank out
 * every other field in the section.
 */
function applyDefined<T extends object>(base: T, patch: PatchOf<T> | undefined): T {
  if (!patch) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * Delete the specific paths Zod rejected, so re-parsing fills them from
 * defaults. Only touches the reported paths, leaving valid neighbours intact.
 */
function stripInvalidPaths(
  data: Record<string, unknown>,
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number | symbol> }>,
): Record<string, unknown> {
  const out = structuredClone(data);
  for (const issue of issues) {
    if (issue.path.length === 0) continue;
    let cursor: Record<string, unknown> = out;
    for (let i = 0; i < issue.path.length - 1; i += 1) {
      const key = String(issue.path[i]);
      const next = cursor[key];
      if (typeof next !== 'object' || next === null) {
        cursor = {};
        break;
      }
      cursor = next as Record<string, unknown>;
    }
    delete cursor[String(issue.path[issue.path.length - 1])];
  }
  return out;
}
