import {
  APP_NAME,
  type AppConfig,
  type LogLevel,
} from '@samix/shared';
import { Agent } from './agent/agent.js';
import { StepExecutor } from './agent/executor.js';
import { HybridPlanner } from './agent/hybrid-planner.js';
import { LlmPlanner } from './agent/llm-planner.js';
import { RuleBasedPlanner, type Planner } from './agent/planner.js';
import { TaskManager } from './agent/task-manager.js';
import { createProvider, ModelRouter, toFunctionDeclarations } from './ai/index.js';
import { ConfigStore } from './config/config-store.js';
import { createAppPaths, type AppPaths } from './config/paths.js';
import { EventBus } from './events/event-bus.js';
import { AuditTrail } from './observability/audit.js';
import { LoggerService, nullLogger, type Logger } from './observability/logger.js';
import { PermissionEngine } from './security/permissions.js';
import { PathPolicy } from './security/path-policy.js';
import { DevEnvSecretStore, type SecretStore } from './security/secrets.js';
import { createToolRegistry } from './tools/index.js';
import type { ToolRegistry } from './tools/registry.js';

/**
 * Composition root.
 *
 * Every dependency is constructed exactly once, here, and injected downwards.
 * Nothing in this package reaches for a module-level singleton, which is what
 * makes the whole runtime constructible inside a test with a temp directory and
 * no global state to reset between cases.
 *
 * Bootstrap order matters and is not arbitrary:
 *
 *   paths → temporary logger → config → real logger → everything else
 *
 * The logger's own settings (level, rotation) live in config, but reading config
 * can itself produce warnings worth recording. So config is loaded against a
 * null logger, then the real logger is constructed from the loaded settings and
 * the config store is re-pointed at it.
 */

export const RUNTIME_VERSION = '0.1.0';

export interface RuntimeOptions {
  /** Override the data directory. Tests and the sandbox use this. */
  readonly dataDir?: string;
  /** Mirror logs to stderr. Never stdout — that is the IPC channel. */
  readonly logToStderr?: boolean;
  /** Substitute planner. Phase 3 injects the Anthropic-backed one here. */
  readonly planner?: (registry: ToolRegistry) => Planner;
}

export interface Runtime {
  readonly agent: Agent;
  readonly bus: EventBus;
  readonly config: ConfigStore;
  readonly registry: ToolRegistry;
  readonly permissions: PermissionEngine;
  readonly pathPolicy: PathPolicy;
  readonly secrets: SecretStore;
  readonly logger: LoggerService;
  readonly log: Logger;
  readonly paths: AppPaths;
  readonly tasks: TaskManager;
  shutdown(): void;
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const paths = createAppPaths(options.dataDir);

  // --- config (loaded before the real logger exists) ------------------------
  const config = ConfigStore.load(paths, nullLogger());
  const initial: AppConfig = config.get();

  // --- observability -------------------------------------------------------
  const logger = new LoggerService({
    logFile: paths.logFile,
    level: initial.logging.level as LogLevel,
    maxFileBytes: initial.logging.maxFileBytes,
    maxFiles: initial.logging.maxFiles,
    stderr: options.logToStderr ?? process.env['SAMIX_LOG_STDERR'] === '1',
  });
  const log = logger.scoped('runtime');
  // Root logger handed to subsystems; each derives its own child scope.
  const rootLog = logger.scoped('samix');
  const audit = new AuditTrail(paths.auditFile, initial.logging.auditEnabled);

  log.info(`${APP_NAME} core starting`, {
    version: RUNTIME_VERSION,
    dataDir: paths.root,
    mode: initial.automation.mode,
    node: process.version,
  });

  // --- event bus -----------------------------------------------------------
  const bus = new EventBus();
  bus.setErrorHandler((error, event) => {
    log.error('event handler threw', { eventType: event.type, error: String(error) });
  });

  // Bridge logs onto the bus so the UI can stream them live. Done here rather
  // than inside the logger to keep the logger free of bus knowledge.
  logger.addSink((entry) => {
    bus.emit({ type: 'log', entry, at: entry.timestamp });
  });

  // --- security ------------------------------------------------------------
  const permissions = new PermissionEngine();
  const pathPolicy = new PathPolicy(initial.security);
  const secrets = new DevEnvSecretStore();

  // --- tools ---------------------------------------------------------------
  // The status tool needs the agent, and the agent needs the registry. Broken
  // with an explicit late-binding holder rather than a mutable field on either
  // object — the indirection is the point, so it should be visible.
  const agentRef: { current: Agent | undefined } = { current: undefined };
  const registry = createToolRegistry({
    pathPolicy,
    statusProvider: () => {
      const current = config.get();
      const mode = current.automation.mode;
      return {
        mode,
        state: agentRef.current?.state ?? 'idle',
        toolCount: registry.size,
        availableTools: registry.availableIn(mode).map((t) => t.name),
        autoApprovedCeiling: permissions.autoApprovedCeiling(mode, current.automation),
        uptimeSeconds: Math.round(process.uptime()),
        subsystems: agentRef.current?.status().subsystems ?? [],
      };
    },
  });

  // --- agent ---------------------------------------------------------------
  const tasks = new TaskManager();

  // --- planning ------------------------------------------------------------
  // Every registered tool's schema is projected into the provider's dialect
  // once, here, at startup. A tool whose schema Gemini would reject poisons the
  // entire `tools` array — every request fails, not just the one using it — so
  // this is checked when the process starts rather than the first time a user
  // asks for something.
  const fallbackPlanner = new RuleBasedPlanner(registry);
  const router = new ModelRouter(() => config.get().llm);
  const provider = createProvider(initial.llm.provider, {
    // Resolved per request, so a key pasted into Settings takes effect on the
    // next turn rather than the next restart.
    apiKey: () => secrets.get('google.apiKey'),
  });
  const llmPlanner = new LlmPlanner({
    provider,
    router,
    registry,
    config: () => config.get(),
    logger: rootLog,
  });
  const planner = options.planner
    ? options.planner(registry)
    : new HybridPlanner({
        llm: llmPlanner,
        fallback: fallbackPlanner,
        hasCredentials: async () => (await secrets.get('google.apiKey')) !== undefined,
        logger: rootLog,
      });

  try {
    const { warnings } = toFunctionDeclarations(registry.toLlmSchemas('developer'));
    for (const warning of warnings) log.warn('tool schema degraded for the LLM', { detail: warning });
  } catch (cause) {
    // A tool name that cannot be encoded is a programming error, and one that
    // would break tool calling for every tool. Fail loudly at boot.
    log.error('a registered tool cannot be described to the LLM', { error: String(cause) });
    throw cause;
  }

  // The executor needs the agent's confirmation gate, and the agent needs the
  // executor. Same late-binding technique: the gate is only ever called during
  // a task, long after both objects exist.
  const executor = new StepExecutor({
    registry,
    permissions,
    bus,
    audit,
    logger: rootLog,
    requestConfirmation: (request) => {
      const agent = agentRef.current;
      if (!agent) return Promise.reject(new Error('Agent is not initialised.'));
      return agent.confirmationGate(request);
    },
  });

  const agent = new Agent({
    bus,
    config,
    registry,
    permissions,
    executor,
    planner,
    tasks,
    logger: rootLog,
    version: RUNTIME_VERSION,
  });
  agentRef.current = agent;

  // --- react to configuration changes at runtime ---------------------------
  config.onChange((next) => {
    logger.setLevel(next.logging.level as LogLevel);
    audit.setEnabled(next.logging.auditEnabled);
    pathPolicy.update(next.security);
    bus.emit({ type: 'config.changed', at: new Date().toISOString() });
  });

  // --- declare Phase 1 subsystem readiness honestly ------------------------
  // `not-implemented` is a distinct state from `unavailable` on purpose: the UI
  // shows "arrives in Phase N", not a red error for something never built.
  agent.setSubsystem({ name: 'configuration', status: 'ready', detail: paths.configFile });
  agent.setSubsystem({ name: 'logging', status: 'ready', detail: paths.logFile });
  agent.setSubsystem({ name: 'audit', status: initial.logging.auditEnabled ? 'ready' : 'unavailable' });
  agent.setSubsystem({ name: 'tools', status: 'ready', detail: `${registry.size} registered` });
  agent.setSubsystem({ name: 'permissions', status: 'ready', detail: `mode: ${initial.automation.mode}` });
  agent.setSubsystem({ name: 'planner', status: 'ready', detail: planner.name });
  agent.setSubsystem({
    name: 'secrets',
    status: secrets.isPersistent() ? 'ready' : 'unavailable',
    detail: secrets.isPersistent()
      ? 'OS credential store'
      : 'in-memory, seeded from the environment — the OS credential store is still pending',
  });
  agent.setSubsystem({ name: 'voice', status: 'not-implemented', detail: 'Phase 2' });
  agent.setSubsystem({
    name: 'filesystem',
    status: 'ready',
    detail: `${initial.security.trustedFolders.length} trusted folders; writes are refused elsewhere`,
  });
  agent.setSubsystem({
    name: 'applications',
    status: process.platform === 'win32' ? 'ready' : 'unavailable',
    detail:
      process.platform === 'win32'
        ? 'launch, close and list installed applications'
        : 'process control is implemented for Windows only',
  });
  // "ready" is true of what is built, and the detail carries the limit: opening
  // a page works, reading one back does not. The tools say so themselves in
  // their descriptions, so the planner cannot plan around a capability we lack.
  agent.setSubsystem({
    name: 'browser',
    status: 'ready',
    detail: 'opens pages and searches — cannot read pages back (Playwright is Phase 6)',
  });

  // Whether an API key exists is an async question, and blocking startup on the
  // secret store would make the window slow to appear for a fact the UI can
  // absorb a moment later. Report the honest interim state, then correct it.
  agent.setSubsystem({ name: 'llm', status: 'unavailable', detail: 'checking credentials…' });
  void secrets
    .get('google.apiKey')
    .then((key) => {
      agent.setSubsystem({
        name: 'llm',
        status: key ? 'ready' : 'unavailable',
        detail: key
          ? `${initial.llm.provider}: ${initial.llm.plannerModel} / ${initial.llm.fastModel}`
          : 'no API key configured — planning falls back to deterministic rules',
      });
    })
    .catch((cause: unknown) => {
      agent.setSubsystem({ name: 'llm', status: 'error', detail: String(cause) });
    });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('core shutting down');
    agent.cancel('shutdown');
    bus.removeAll();
    audit.close();
    logger.close();
  };

  return {
    agent,
    bus,
    config,
    registry,
    permissions,
    pathPolicy,
    secrets,
    logger,
    log,
    paths,
    tasks,
    shutdown,
  };
}
