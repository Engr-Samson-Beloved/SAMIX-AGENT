/**
 * Cross-cutting constants. Anything that two packages must agree on numerically
 * or textually belongs here rather than being duplicated at each call site.
 */

/** Directory name created under %APPDATA% (spec §44). */
export const APP_DIR_NAME = 'SamixAgent';

/** Product name shown in the window title, tray tooltip and log header. */
export const APP_NAME = 'SAMIX Agent';

/** Bumped whenever the persisted config shape changes; drives migrations. */
export const CONFIG_SCHEMA_VERSION = 1;

/** Bumped on any breaking change to the sidecar IPC protocol (ADR-0003). */
export const IPC_PROTOCOL_VERSION = 1;

/**
 * Service name used for the Windows Credential Manager entries
 * (spec §38 — secrets never live in JSON or SQLite).
 */
export const CREDENTIAL_SERVICE = 'SamixAgent';

/**
 * Tauri event channel on which the Rust host republishes sidecar events to the
 * webview. One channel carrying a discriminated union beats many channels: the
 * frontend keeps a single subscription and exhaustively switches on `type`.
 */
export const UI_EVENT_CHANNEL = 'samix://event';

/** Safety rails for the agent loop (spec §30, development rule 16). */
export const AGENT_LIMITS = {
  /** Hard ceiling on planner/executor iterations for one task. */
  maxStepsPerTask: 25,
  /** Retries of a single failed step before the task fails (spec §30: 2–3). */
  maxStepRetries: 2,
  /** Whole-task wall clock budget. */
  taskTimeoutMs: 5 * 60_000,
  /** Default per-tool timeout; individual tools may specify a lower value. */
  defaultToolTimeoutMs: 30_000,
} as const;

/** Bound on the in-memory log ring served to the UI Logs pane. */
export const LOG_RING_CAPACITY = 1000;

/** Default global hotkey (spec §33/§34). Configurable. */
export const DEFAULT_HOTKEY = 'CmdOrControl+Shift+Space';
