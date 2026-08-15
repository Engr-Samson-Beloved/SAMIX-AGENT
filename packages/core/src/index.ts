/**
 * @samix/core — the agent runtime.
 *
 * Exported for tests and for embedding. The sidecar entrypoint is `main.ts`.
 */

export { Agent } from './agent/agent.js';
export type { AgentDeps, SubsystemStatus } from './agent/agent.js';
export { CancellationToken, delay, withTimeout } from './agent/cancellation.js';
export type { CancelReason } from './agent/cancellation.js';
export { StepExecutor } from './agent/executor.js';
export type { ConfirmationGate, ExecuteStepContext, ExecutorDeps, StepOutcome } from './agent/executor.js';
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
export { AppRegistry, discoverApps, isLaunchable } from './tools/apps/app-registry.js';
export type { AppKind, DiscoveredApp } from './tools/apps/app-registry.js';
export {
  createAppCloseTool,
  createAppLaunchTool,
  createAppListTool,
  processListTool,
} from './tools/apps/tools.js';
export { createBrowserOpenUrlTool, createBrowserSearchTool } from './tools/apps/browser.js';
export {
  closeProcess,
  isProcessRunning,
  isValidImageName,
  listProcesses,
} from './tools/windows/processes.js';
export type { RunningProcess } from './tools/windows/processes.js';

export { RpcRouter } from './rpc/router.js';
export type { RouterResult } from './rpc/router.js';
export { StdioTransport } from './transport/stdio.js';
export { DevHttpTransport } from './transport/dev-http.js';

export { createRuntime, RUNTIME_VERSION } from './runtime.js';
export type { Runtime, RuntimeOptions } from './runtime.js';
