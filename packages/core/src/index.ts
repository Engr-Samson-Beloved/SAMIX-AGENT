/**
 * @samix/core — the agent runtime.
 *
 * Exported for tests and for embedding. The sidecar entrypoint is `main.ts`.
 */

export { Agent } from './agent/agent.js';
export type { AgentDeps, SubsystemStatus } from './agent/agent.js';
export { CancellationToken, delay, withTimeout } from './agent/cancellation.js';
export type { CancelReason } from './agent/cancellation.js';
export { classifyResponse } from './agent/affirmative.js';
export type { Response } from './agent/affirmative.js';
export { AgentContext, describeReferents, PROPOSAL_TTL_MS } from './agent/context.js';
export type { PendingProposal, Referents } from './agent/context.js';
export { createActionBudget, StepExecutor } from './agent/executor.js';
export type {
  ActionBudget,
  ConfirmationGate,
  ExecuteStepContext,
  ExecutorDeps,
  StepOutcome,
} from './agent/executor.js';
export { HybridPlanner } from './agent/hybrid-planner.js';
export { LlmPlanner } from './agent/llm-planner.js';
export type { LlmPlannerDeps } from './agent/llm-planner.js';
export { RuleBasedPlanner, toTaskSteps } from './agent/planner.js';
export type {
  PlanRequest,
  PlanResult,
  PlannedStep,
  Planner,
  RecoveryRequest,
  SummaryRequest,
} from './agent/planner.js';

export {
  ASK_USER_DECLARATION,
  ASK_USER_FUNCTION,
  CONTROL_FUNCTIONS,
  PROPOSE_ACTION_DECLARATION,
  PROPOSE_ACTION_FUNCTION,
  GoogleProvider,
  LlmError,
  ModelRouter,
  assertEncodable,
  classifyInstruction,
  createProvider,
  decodeToolName,
  encodeToolName,
  toFunctionDeclarations,
  toGeminiSchema,
} from './ai/index.js';
export type {
  AttemptInfo,
  FinishReason,
  GeminiSchema,
  GoogleProviderOptions,
  InstructionVerdict,
  LlmErrorKind,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmToolCall,
  LlmUsage,
  Route,
  RouteRequest,
  SchemaConversionResult,
  ToolSchema,
  TurnKind,
} from './ai/index.js';
export {
  AgentStateMachine,
  IllegalTransitionError,
  TRANSITION_TABLE,
  assertTransitionTableComplete,
} from './agent/state-machine.js';
export { TaskManager, isTerminalStatus } from './agent/task-manager.js';

export { ConfigStore, mergeConfig } from './config/config-store.js';
export { migrateConfig, MIGRATIONS } from './config/migrations.js';
export type { ConfigMigration, MigrationOutcome } from './config/migrations.js';
export { createAppPaths, defaultTrustedFolders } from './config/paths.js';
export type { AppPaths } from './config/paths.js';

export { EventBus, publish } from './events/event-bus.js';
export type { AnyEventHandler, EventHandler, Unsubscribe } from './events/event-bus.js';

export { AuditTrail } from './observability/audit.js';
export { LoggerService, formatHuman, nullLogger } from './observability/logger.js';
export type { Logger, LoggerOptions, LogSink } from './observability/logger.js';
export { redact, redactFields, redactString, REDACTED } from './observability/redact.js';
export { RingBuffer } from './observability/ring-buffer.js';

export { PathPolicy, matchesPattern, normalisePath } from './security/path-policy.js';
export type { PathDecision, PathTrust } from './security/path-policy.js';
export { CommandPolicy } from './security/command-policy.js';
export type { CommandDecision } from './security/command-policy.js';
export { PermissionEngine } from './security/permissions.js';
export type { Decision, Effect, PermissionQuery } from './security/permissions.js';
export { DevEnvSecretStore, EphemeralSecretStore, credentialTarget } from './security/secrets.js';
export type { SecretKey, SecretStore } from './security/secrets.js';

export { ToolRegistry, ToolRegistrationError, createToolRegistry } from './tools/index.js';
export { systemGetInfoTool, createAgentGetStatusTool } from './tools/index.js';
export type { AgentStatusReport, StatusProvider, SystemInfo, ToolRegistryDeps } from './tools/index.js';

// Phase 4 — filesystem
export {
  createCopyTool,
  createCreateDirectoryTool,
  createDeleteTool,
  createListDirectoryTool,
  createMetadataTool,
  createMoveTool,
  createReadTextFileTool,
  createRenameTool,
  createSearchTool,
} from './tools/filesystem/tools.js';
export { formatBytes, guardPath, shorthandNames, toAbsolutePath } from './tools/filesystem/guard.js';
export type { GuardedPath, PathIntent } from './tools/filesystem/guard.js';

// Phase 5 — applications and processes
export { AppRegistry, discoverApps, isLaunchable, NEVER_LAUNCHABLE } from './tools/apps/app-registry.js';
export type { AppKind, DiscoveredApp } from './tools/apps/app-registry.js';
export {
  createAppCloseTool,
  createAppLaunchTool,
  createAppListTool,
  processListTool,
} from './tools/apps/tools.js';
export {
  closeProcess,
  isProcessRunning,
  isValidImageName,
  listProcesses,
  waitForProcessToExit,
} from './tools/windows/processes.js';
export type { RunningProcess } from './tools/windows/processes.js';

// Phase 6 — browser automation over the DevTools protocol
export { BrowserSession, BrowserSessionError, DEFAULT_DEBUG_PORT } from './tools/browser/session.js';
export type { ProfileKind, SessionStatus } from './tools/browser/session.js';
export {
  createBrowserClickTool,
  createBrowserCloseTool,
  createBrowserExtractTextTool,
  createBrowserGotoTool,
  createBrowserScreenshotTool,
  createBrowserScrollTool,
  createBrowserSearchTool,
  parseWebUrl,
} from './tools/browser/tools.js';

// Phase 7 (partial) — windows on the user's desktop
export {
  getActiveWindow,
  isValidHandle,
  listWindows,
  WindowQueryError,
} from './tools/windows/ui-automation.js';
export type { WindowInfo } from './tools/windows/ui-automation.js';
export {
  createScreenGetActiveWindowTool,
  createWindowCloseTool,
  createWindowFocusTool,
  createWindowListTool,
  windowsAutomation,
} from './tools/windows/tools.js';
export type { ReferentSource, WindowAutomation, WindowReferents } from './tools/windows/tools.js';

// Phase 7 — desktop control sidecar (Windows UI Automation over NDJSON)
export { DesktopSidecar } from './tools/desktop/sidecar.js';
export type {
  DesktopSidecarOptions,
  SidecarState,
  SidecarStatus,
} from './tools/desktop/sidecar.js';
export {
  SIDECAR_PROTOCOL_VERSION,
  SidecarError,
  HandshakeSchema,
  SnapshotSchema,
  parseFrame,
} from './tools/desktop/protocol.js';
export type { Handshake, Snapshot, SnapshotElement } from './tools/desktop/protocol.js';
export {
  createResilientWindowAutomation,
  createSidecarWindowAutomation,
  resolveActive,
} from './tools/desktop/window-automation.js';
export type {
  ResilientWindowAutomation,
  WindowAutomationStatus,
  WindowPath,
} from './tools/desktop/window-automation.js';
export { pythonCandidates, sidecarArgs, sidecarRoot, venvPython } from './tools/desktop/python.js';
export { DesktopContext, CONTEXT_TTL_MS } from './tools/desktop/context.js';
export type { RememberedElement, RememberedWindow } from './tools/desktop/context.js';
export {
  createDesktopClickTool,
  createDesktopFindElementTool,
  createDesktopInvokeTool,
  createDesktopPressKeyTool,
  createDesktopSetValueTool,
  createDesktopSnapshotTool,
  createDesktopTypeTool,
} from './tools/desktop/tools.js';
export type { ClickResult, TypeResult } from './tools/desktop/tools.js';
export { dangerousWordIn } from './security/permissions.js';
export type { PythonCandidate, PythonSource } from './tools/desktop/python.js';

// Phase 10 — developer tools (DEVELOPER mode only)
export { createTerminalExecuteTool } from './tools/terminal/tools.js';
export type { TerminalExecuteResult } from './tools/terminal/tools.js';
export { run } from './tools/terminal/run.js';
export type { RunOptions, RunOutcome } from './tools/terminal/run.js';
export {
  createGitBranchTool,
  createGitDiffTool,
  createGitLogTool,
  createGitStatusTool,
} from './tools/git/tools.js';
export type { GitCommandResult } from './tools/git/tools.js';

export { RpcRouter } from './rpc/router.js';
export type { RouterResult } from './rpc/router.js';
export { StdioTransport } from './transport/stdio.js';
export { DevHttpTransport } from './transport/dev-http.js';

export { createRuntime, RUNTIME_VERSION } from './runtime.js';
export type { Runtime, RuntimeOptions } from './runtime.js';
