import { CONFIG_SCHEMA_VERSION } from '@samix/shared';

/**
 * Forward-only config migrations.
 *
 * Registered as `from → transform`. A user who skips several releases is walked
 * through each step in order. Migrations receive and return plain unknown data,
 * never typed `AppConfig`, because the whole point is that the shape being
 * migrated is an OLD shape that no current type describes.
 *
 * Phase 1 ships schemaVersion 1, so this table is empty. It exists now so that
 * the very first shape change has an obvious home and nobody is tempted to add
 * ad-hoc fixups inside the loader.
 */

export type ConfigMigration = (input: Record<string, unknown>) => Record<string, unknown>;

export const MIGRATIONS: Readonly<Record<number, ConfigMigration>> = {
  // Example of the intended shape, for whoever writes migration 1 → 2:
  //
  // 1: (input) => ({
  //   ...input,
  //   schemaVersion: 2,
  //   voice: { ...(input['voice'] as object), newField: 'default' },
  // }),
};

export interface MigrationOutcome {
  readonly data: Record<string, unknown>;
  readonly applied: number[];
  /** Config is newer than this build understands. */
  readonly fromFuture: boolean;
}

export function migrateConfig(raw: unknown): MigrationOutcome {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { data: {}, applied: [], fromFuture: false };
  }

  let data = { ...(raw as Record<string, unknown>) };
  const applied: number[] = [];

  const declared = data['schemaVersion'];
  let version = typeof declared === 'number' && Number.isInteger(declared) ? declared : 1;

  if (version > CONFIG_SCHEMA_VERSION) {
    // A downgrade. Do not attempt to guess how to strip unknown fields; the
    // caller decides whether to run on defaults or refuse. Losing a user's
    // settings by silently rewriting a newer file would be worse.
    return { data, applied, fromFuture: true };
  }

  while (version < CONFIG_SCHEMA_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) {
      // No path forward: stamp the current version and let schema defaults fill
      // any gaps. Safe because every field in AppConfigSchema has a default.
      data = { ...data, schemaVersion: CONFIG_SCHEMA_VERSION };
      break;
    }
    data = migration(data);
    applied.push(version);
    version += 1;
    data['schemaVersion'] = version;
  }

  return { data, applied, fromFuture: false };
}
