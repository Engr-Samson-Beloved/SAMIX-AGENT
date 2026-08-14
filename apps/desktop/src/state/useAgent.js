import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '../ipc/client.js';
const MAX_LOGS = 500;
export function useAgent() {
    const clientRef = useRef(undefined);
    const [connection, setConnection] = useState('connecting');
    const [connectionDetail, setConnectionDetail] = useState();
    const [status, setStatus] = useState();
    const [config, setConfig] = useState();
    const [tools, setTools] = useState([]);
    const [task, setTask] = useState();
    const [history, setHistory] = useState([]);
    const [confirmation, setConfirmation] = useState();
    const [logs, setLogs] = useState([]);
    const [transcript, setTranscript] = useState([]);
    const [error, setError] = useState();
    const say = useCallback((role, text) => {
        setTranscript((prior) => [
            ...prior.slice(-49),
            { id: `${role}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, role, text, at: new Date().toISOString() },
        ]);
    }, []);
    // --- connect ------------------------------------------------------------
    useEffect(() => {
        let disposed = false;
        const disposers = [];
        void (async () => {
            try {
                const client = await createClient();
                if (disposed)
                    return;
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
                if (disposed)
                    return;
                setStatus(snapshot);
                setConfig(currentConfig);
                setTools(toolList);
                setHistory(recent);
                setLogs(tail);
                setConfirmation(snapshot.pendingConfirmation);
                setTask(snapshot.currentTask);
                setConnection('ready');
            }
            catch (cause) {
                if (disposed)
                    return;
                setConnection('failed');
                setConnectionDetail(cause instanceof Error ? cause.message : String(cause));
            }
        })();
        function applyEvent(event) {
            switch (event.type) {
                case 'agent.started':
                    setStatus(event.status);
                    break;
                case 'agent.state.changed':
                    setStatus((prior) => (prior ? { ...prior, state: event.to } : prior));
                    break;
                case 'agent.subsystem.changed':
                    setStatus((prior) => prior
                        ? {
                            ...prior,
                            subsystems: prior.subsystems.map((s) => s.name === event.name ? { ...s, status: event.status, detail: event.detail } : s),
                        }
                        : prior);
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
        async function refreshHistory() {
            const client = clientRef.current;
            if (!client)
                return;
            try {
                setHistory(await client.request('task.history', { limit: 20 }));
            }
            catch {
                // Non-fatal: the timeline is a convenience, not correctness.
            }
        }
        async function refreshConfig() {
            const client = clientRef.current;
            if (!client)
                return;
            try {
                setConfig(await client.request('config.get', {}));
            }
            catch {
                // Non-fatal.
            }
        }
        return () => {
            disposed = true;
            for (const dispose of disposers)
                dispose();
        };
    }, [say]);
    // --- actions ------------------------------------------------------------
    const withClient = useCallback(async (action) => {
        const client = clientRef.current;
        if (!client) {
            setError('The agent core is not connected.');
            return undefined;
        }
        try {
            setError(undefined);
            return await action(client);
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            return undefined;
        }
    }, []);
    const actions = useMemo(() => ({
        submit: (instruction) => withClient((client) => client.request('task.submit', { instruction, source: 'text' })),
        cancel: () => withClient((client) => client.request('task.cancel', { reason: 'user requested' })),
        emergencyStop: () => withClient((client) => client.request('agent.emergencyStop', {})),
        respond: (id, approved, approveRemainingInTask = false) => withClient((client) => client.request('confirmation.respond', { id, approved, approveRemainingInTask })),
        setMode: (mode) => withClient(async (client) => {
            const next = await client.request('agent.mode.set', { mode });
            setStatus(next);
            setConfig(await client.request('config.get', {}));
            setTools(await client.request('tools.list', {}));
            return next;
        }),
        updateConfig: (patch) => withClient(async (client) => {
            const next = await client.request('config.update', patch);
            setConfig(next);
            return next;
        }),
        resetConfig: () => withClient(async (client) => {
            const next = await client.request('config.reset', {});
            setConfig(next);
            return next;
        }),
    }), [withClient]);
    const view = {
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
//# sourceMappingURL=useAgent.js.map