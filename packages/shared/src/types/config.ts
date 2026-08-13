import { z } from 'zod';
import { AgentModeSchema } from './mode.js';
import { CONFIG_SCHEMA_VERSION, DEFAULT_HOTKEY } from '../constants.js';

/**
 * Give an object field a default built by parsing `{}` through its own schema,
 * so every nested field's default applies.
 *
 * Needed because Zod 4's `.default()` takes the schema's OUTPUT type — passing
 * `{}` no longer means "fill in the defaults", it means "the value IS `{}`",
 * which fails the type check. Wrapping the parse in a thunk restores the
 * intent and keeps each section's defaults defined in exactly one place.
 */
function sectionDefault<T extends z.ZodObject<z.ZodRawShape>>(schema: T): z.ZodDefault<T> {
  // `as never` because Zod's `NoUndefined<output<T>>` cannot be satisfied from
  // inside a generic function. The runtime value is correct by construction:
  // `schema.parse({})` returns exactly `output<T>` with all defaults applied.
  return schema.default(() => schema.parse({}) as never);
}

/**
 * Persisted configuration (spec §44, §84–§87).
 *
 * Every field has a default, so a missing or partially-written config file is
 * always recoverable to a working state rather than being a startup failure.
 * `schemaVersion` drives forward migrations in core/config/migrations.ts.
 *
 * This schema is the ONLY place config shape is defined. The settings UI, the
 * IPC layer and the on-disk file all derive from it.
 */

export const LlmProviderSchema = z.enum(['google', 'anthropic', 'openai', 'local']);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const LlmConfigSchema = z.object({
  /**
   * Google (Gemini) is the chosen engine for this build. The abstraction in
   * `src/ai/` (spec §6) keeps the others reachable — nothing outside that
   * directory may branch on this value.
   */
  provider: LlmProviderSchema.default('google'),
  /**
   * Model IDs are configuration, never constants baked into code — the spec
   * (§44) writes "configured-model" precisely to avoid pinning a model in
   * source. Phase 3 wires these to the provider abstraction.
   */
  plannerModel: z.string().default('gemini-2.5-pro'),
  /** Cheap model for classification/routing (spec §63). */
  fastModel: z.string().default('gemini-2.5-flash'),
  /** Vision-capable model (spec §63, Phase 11). */
  visionModel: z.string().default('gemini-2.5-pro'),
  maxOutputTokens: z.number().int().positive().max(64_000).default(4096),
  /** Cost guard: refuse a task projected to exceed this many input tokens. */
  maxContextTokens: z.number().int().positive().default(120_000),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const VoiceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  sttProvider: z.enum(['whisper', 'faster-whisper', 'windows', 'none']).default('faster-whisper'),
  /** Empty string means "system default input device". */
  inputDeviceId: z.string().default(''),
  /** Push-to-talk is the Phase 2 default; always-listening is opt-in (spec §8). */
  activation: z.enum(['push-to-talk', 'always-listening']).default('push-to-talk'),
  vadEnabled: z.boolean().default(true),
  silenceTimeoutMs: z.number().int().positive().default(1200),
  /** Hard mute overrides everything (spec §83). */
  microphoneDisabled: z.boolean().default(false),
});
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

export const TtsConfigSchema = z.object({
  /** Spec §9: TTS is not mandatory for MVP. */
  enabled: z.boolean().default(false),
  provider: z.enum(['windows', 'edge', 'elevenlabs', 'openai', 'none']).default('windows'),
  voice: z.string().default(''),
  rate: z.number().min(0.5).max(2).default(1),
});
export type TtsConfig = z.infer<typeof TtsConfigSchema>;

export const AutomationConfigSchema = z.object({
  /** Spec §55: default mode is CONTROLLED. */
  mode: AgentModeSchema.default('controlled'),
  /**
   * Permission levels that always require confirmation regardless of mode.
   * Empty in `safe` mode because nothing above `read` runs there at all.
   */
  alwaysConfirm: z
    .array(z.enum(['read', 'write', 'external', 'destructive', 'system']))
    .default(['external', 'destructive', 'system']),
  maxStepsPerTask: z.number().int().positive().max(100).default(25),
  maxStepRetries: z.number().int().nonnegative().max(5).default(2),
  taskTimeoutMs: z.number().int().positive().default(300_000),
});
export type AutomationConfig = z.infer<typeof AutomationConfigSchema>;

export const SecurityConfigSchema = z.object({
  /**
   * Spec §85. The agent operates with fewer prompts inside these paths.
   * Defaults are resolved at first run from the real user profile, so the
   * committed default is empty rather than a guessed path.
   */
  trustedFolders: z.array(z.string()).default([]),
  /** Spec §86. Application IDs from the registry, not raw executable paths. */
  trustedApplications: z.array(z.string()).default([]),
  /**
   * Spec §39. Denied outright; deny always beats trust. Tokens are matched
   * case-insensitively against the normalised absolute path.
   */
  blockedPathPatterns: z
    .array(z.string())
    .default([
      'C:\\Windows',
      'C:\\Program Files\\WindowsApps',
      '**/AppData/Local/Microsoft/Credentials/**',
      '**/AppData/Roaming/Microsoft/Crypto/**',
      '**/.ssh/**',
      '**/.aws/credentials',
      '**/.env',
      '**/*.kdbx',
      '**/Login Data',
      '**/Cookies',
    ]),
  /** Require confirmation before reading a file over this size into context. */
  maxFileReadBytes: z.number().int().positive().default(2_000_000),
});
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

export const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Rotate the NDJSON log once it exceeds this size. */
  maxFileBytes: z.number().int().positive().default(5_000_000),
  maxFiles: z.number().int().positive().max(50).default(5),
  /** The audit trail is separate from diagnostics and is never downsampled. */
  auditEnabled: z.boolean().default(true),
});
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

export const UiConfigSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  /** Spec §87: NOT enabled during development. */
  startWithWindows: z.boolean().default(false),
  startMinimizedToTray: z.boolean().default(true),
  /** Closing the window hides to tray instead of quitting (spec §35). */
  closeToTray: z.boolean().default(true),
});
export type UiConfig = z.infer<typeof UiConfigSchema>;

export const AppConfigSchema = z.object({
  schemaVersion: z.number().int().positive().default(CONFIG_SCHEMA_VERSION),
  llm: sectionDefault(LlmConfigSchema),
  voice: sectionDefault(VoiceConfigSchema),
  tts: sectionDefault(TtsConfigSchema),
  automation: sectionDefault(AutomationConfigSchema),
  security: sectionDefault(SecurityConfigSchema),
  logging: sectionDefault(LoggingConfigSchema),
  ui: sectionDefault(UiConfigSchema),
  hotkey: z.string().default(DEFAULT_HOTKEY),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

/** A config object with every default materialised. */
export function defaultConfig(): AppConfig {
  return AppConfigSchema.parse({});
}

/**
 * Deep-partial input accepted by `ConfigStore.update`. Kept as a distinct type
 * so callers cannot accidentally clear a whole section by omitting fields.
 */
export const AppConfigPatchSchema = z.object({
  llm: LlmConfigSchema.partial().optional(),
  voice: VoiceConfigSchema.partial().optional(),
  tts: TtsConfigSchema.partial().optional(),
  automation: AutomationConfigSchema.partial().optional(),
  security: SecurityConfigSchema.partial().optional(),
  logging: LoggingConfigSchema.partial().optional(),
  ui: UiConfigSchema.partial().optional(),
  hotkey: z.string().optional(),
});
export type AppConfigPatch = z.infer<typeof AppConfigPatchSchema>;
