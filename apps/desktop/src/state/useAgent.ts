import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentEvent,
  AgentStatus,
  AppConfig,
  AppConfigPatch,
  ConfirmationRequest,
  LogEntry,
  Task,
  ToolDescriptor,
} from '@samix/shared';
import { createClient, type AgentClient, type ConnectionStatus } from '../ipc/client.js';

/**
 * Single source of UI state, fed by the agent's event stream (spec §46, §47).
 *
 * The console renders from events, not from polling. Every state change in the
 * core already publishes an event, so the UI stays live during long automation
 * without a request loop — which is what spec §76 means by keeping the
 * interface responsive while the agent works.
 *
 * Requests are only used for the initial snapshot and for user-initiated
 * actions; after that the stream keeps everything current.
 */

export interface AgentView {
  connection: ConnectionStatus;
  connectionDetail: string | undefined;
  status: AgentStatus | undefined;
  config: AppConfig | undefined;
  tools: ToolDescriptor[];
  task: Task | undefined;
  history: Task[];
  confirmation: ConfirmationRequest | undefined;
  logs: LogEntry[];
  transcript: TranscriptEntry[];
  error: string | undefined;
}

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'agent';
  text: string;
  at: string;
}

const MAX_LOGS = 500;

export function useAgent() {
  const clientRef = useRef<AgentClient | undefined>(undefined);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [connectionDetail, setConnectionDetail] = useState<string | undefined>();
  const [status, setStatus] = useState<AgentStatus>();
  const [config, setConfig] = useState<AppConfig>();
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  const [task, setTask] = useState<Task>();
  const [history, setHistory] = useState<Task[]>([]);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest>();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string>();

  const say = useCallback((role: TranscriptEntry['role'], text: string) => {
    setTranscript((prior) => [
      ...prior.slice(-49),
      { id: `${role}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, role, text, at: new Date().toISOString() },
    ]);
  }, []);

  // --- connect ------------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    const disposers: Array<() => void> = [];

    void (async () => {
      try {
        const client = await createClient();
        if (disposed) return;
        clientRef.current = client;

        disposers.push(client.onStatus((next, detail) => {
          setConnection(next);
          setConnectionDetail(detail);
        }));

        disposers.push(client.onEvent((event) => applyEvent(event)));

        const [snapshot, currentConfig, toolList, recent, tail] = await Promise.all([
          client.request('status.get', {}),
          client.request('config.get', {}),
          client.request('tools.list', {}),
          client.request('task.history', { limit: 20 }),
          client.request('logs.tail', { limit: 200 }),
        ]);
        if (disposed) return;

        setStatus(snapshot);
        setConfig(currentConfig);
        setTools(toolList);
        setHistory(recent);
        setLogs(tail);
        setConfirmation(snapshot.pendingConfirmation);
        setTask(snapshot.currentTask);
        setConnection('ready');
      } catch (cause) {
        if (disposed) return;
        setConnection('failed');
        setConnectionDetail(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    function applyEvent(event: AgentEvent): void {
      switch (event.type) {
        case 'agent.started':
          setStatus(event.status);
          break;
        case 'agent.state.changed':
          setStatus((prior) => (prior ? { ...prior, state: event.to } : prior));
          break;
        case 'agent.subsystem.changed':
          setStatus((prior) =>
            prior
              ? {
                  ...prior,
                  subsystems: prior.subsystems.map((s) =>
                    s.name === event.name ? { ...s, status: event.status, detail: event.detail } : s,
                  ),
                }
              : prior,
          );
          break;
        case 'task.created':
          setTask(event.task);
          say('user', event.task.instruction);
          break;
        case 'task.updated':
          setTask(event.task);
          break;
        case 'task.completed':
          say('agent', event.summary);
          setTask(undefined);
          setConfirmation(undefined);
          void refreshHistory();
          break;
        case 'task.failed':
          say('agent', event.summary);
          setTask(undefined);
          setConfirmation(undefined);
          void refreshHistory();
          break;
        case 'task.cancelled':
          say('agent', `Stopped: ${event.reason}`);
          setTask(undefined);
          setConfirmation(undefined);
          void refreshHistory();
          break;
        case 'confirmation.required':
          setConfirmation(event.request);
          break;
        case 'confirmation.resolved':
          setConfirmation(undefined);
          break;
        case 'agent.transcription.completed':
          say('user', event.text);
          break;
        case 'log':
          setLogs((prior) => [...prior.slice(-(MAX_LOGS - 1)), event.entry]);
          break;
        case 'config.changed':
          void refreshConfig();
          break;
        case 'agent.error':
          setError(event.error.message);
          break;
        default:
          break;
      }
    }

    async function refreshHistory(): Promise<void> {
      const client = clientRef.current;
      if (!client) return;
      try {
        setHistory(await client.request('task.history', { limit: 20 }));
      } catch {
        // Non-fatal: the timeline is a convenience, not correctness.
      }
    }

    async function refreshConfig(): Promise<void> {
      const client = clientRef.current;
      if (!client) return;
      try {
        setConfig(await client.request('config.get', {}));
      } catch {
        // Non-fatal.
      }
    }

    return () => {
      disposed = true;
      for (const dispose of disposers) dispose();
    };
  }, [say]);

  // --- actions ------------------------------------------------------------

  const withClient = useCallback(
    async <T,>(action: (client: AgentClient) => Promise<T>): Promise<T | undefined> => {
      const client = clientRef.current;
      if (!client) {
        setError('The agent core is not connected.');
        return undefined;
      }
      try {
        setError(undefined);
        return await action(client);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return undefined;
      }
    },
    [],
  );

  const actions = useMemo(
    () => ({
      submit: (instruction: string) =>
        withClient((client) => client.request('task.submit', { instruction, source: 'text' })),

      cancel: () => withClient((client) => client.request('task.cancel', { reason: 'user requested' })),

      emergencyStop: () => withClient((client) => client.request('agent.emergencyStop', {})),

      respond: (id: string, approved: boolean, approveRemainingInTask = false) =>
        withClient((client) =>
          client.request('confirmation.respond', { id, approved, approveRemainingInTask }),
        ),

      setMode: (mode: AgentStatus['mode']) =>
        withClient(async (client) => {
          const next = await client.request('agent.mode.set', { mode });
          setStatus(next);
          setConfig(await client.request('config.get', {}));
          setTools(await client.request('tools.list', {}));
          return next;
        }),

      updateConfig: (patch: AppConfigPatch) =>
        withClient(async (client) => {
          const next = await client.request('config.update', patch);
          setConfig(next);
          return next;
        }),

      resetConfig: () =>
        withClient(async (client) => {
          const next = await client.request('config.reset', {});
          setConfig(next);
          return next;
        }),
    }),
    [withClient],
  );

  const view: AgentView = {
    connection,
    connectionDetail,
    status,
    config,
    tools,
    task,
    history,
    confirmation,
    logs,
    transcript,
    error,
  };

  return { ...view, actions };
}
