import { CREDENTIAL_SERVICE } from '@samix/shared';

/**
 * Secret storage seam (spec §38).
 *
 * ## Status: interface only in Phase 1 — read this before using it
 *
 * Phase 1 has no secrets to store. The first real secret is the LLM API key in
 * Phase 3. What exists here is the *seam*, so that when Phase 3 arrives there is
 * an obvious correct place to put the key and no temptation to reach for
 * `process.env` or a JSON file.
 *
 * The production implementation will be the Windows Credential Manager, reached
 * through the Rust host (which already owns native concerns in our topology —
 * see ADR-0001) via two additional IPC methods. Deliberately NOT done here:
 *
 *  - A Node native module (`keytar` is unmaintained; `@napi-rs/keyring` would be
 *    a new native dependency for a capability nothing yet consumes).
 *  - Shelling out to `powershell.exe` for DPAPI. This codebase's security thesis
 *    is that the agent never invokes an arbitrary shell (spec §40); adding a
 *    shell-out to the *secrets* path, of all places, would undercut that even
 *    with fixed arguments.
 *
 * Until then `EphemeralSecretStore` is the only implementation and it is
 * explicitly non-persistent, so no code can accidentally come to depend on
 * insecure at-rest storage that we would then have to migrate away from.
 */

export type SecretKey =
  | 'google.apiKey'
  | 'anthropic.apiKey'
  | 'openai.apiKey'
  | 'elevenlabs.apiKey';

export interface SecretStore {
  /** Returns undefined when the secret has never been set. */
  get(key: SecretKey): Promise<string | undefined>;
  set(key: SecretKey, value: string): Promise<void>;
  delete(key: SecretKey): Promise<void>;
  /**
   * Which secrets exist, without revealing values. This is what the settings UI
   * binds to — it shows "configured"/"not configured", never the secret itself.
   */
  list(): Promise<SecretKey[]>;
  /** False when the backing store is not usable on this machine. */
  isPersistent(): boolean;
}

/** Credential Manager target name for a key. Shared by every implementation. */
export function credentialTarget(key: SecretKey): string {
  return `${CREDENTIAL_SERVICE}:${key}`;
}

/**
 * In-memory store. Values live for the lifetime of the sidecar process and are
 * never written anywhere.
 *
 * `isPersistent()` returns false, and callers are expected to surface that: the
 * settings UI shows "you will need to re-enter this after a restart" rather than
 * silently losing the key and looking broken.
 */
export class EphemeralSecretStore implements SecretStore {
  private readonly values = new Map<SecretKey, string>();

  get(key: SecretKey): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  set(key: SecretKey, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: SecretKey): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  list(): Promise<SecretKey[]> {
    return Promise.resolve([...this.values.keys()]);
  }

  isPersistent(): boolean {
    return false;
  }
}

/**
 * Development-only fallback that seeds from environment variables.
 *
 * Spec §38 permits `.env` during development and forbids it in production. This
 * class is the boundary of that permission: it refuses to activate unless
 * `NODE_ENV !== 'production'`, so a packaged build cannot pick up a stray
 * environment variable and quietly behave differently from a clean install.
 */
export class DevEnvSecretStore extends EphemeralSecretStore {
  private static readonly ENV_KEYS: Readonly<Record<SecretKey, string>> = {
    'google.apiKey': 'GEMINI_API_KEY',
    'anthropic.apiKey': 'ANTHROPIC_API_KEY',
    'openai.apiKey': 'OPENAI_API_KEY',
    'elevenlabs.apiKey': 'ELEVENLABS_API_KEY',
  };

  constructor() {
    super();
    if (process.env['NODE_ENV'] === 'production') return;
    for (const [key, envName] of Object.entries(DevEnvSecretStore.ENV_KEYS) as [SecretKey, string][]) {
      const value = process.env[envName];
      if (value && value.trim() !== '') void this.set(key, value);
    }
  }
}
