import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { useAgent } from './state/useAgent.js';
import { ConfirmationPrompt } from './components/ConfirmationPrompt.js';
import { LogsPane } from './components/LogsPane.js';
import { SettingsPane } from './components/SettingsPane.js';
import { StatusOrb } from './components/StatusOrb.js';
import { TaskTimeline } from './components/TaskTimeline.js';
import { ToolsPane } from './components/ToolsPane.js';
import { Transcript } from './components/Transcript.js';
export function App() {
    const agent = useAgent();
    const [pane, setPane] = useState('console');
    const [draft, setDraft] = useState('');
    // The tray menu asks the window to jump to a pane.
    useEffect(() => {
        if (!('__TAURI_INTERNALS__' in window))
            return;
        let dispose;
        void import('@tauri-apps/api/event').then(({ listen }) => listen('samix://navigate', ({ payload }) => {
            if (payload === 'settings' || payload === 'logs')
                setPane(payload);
        }).then((unlisten) => {
            dispose = unlisten;
        }));
        return () => dispose?.();
    }, []);
    const busy = agent.task !== undefined;
    function onSubmit(event) {
        event.preventDefault();
        const instruction = draft.trim();
        if (instruction === '' || busy)
            return;
        setDraft('');
        void agent.actions.submit(instruction);
    }
    if (agent.connection === 'connecting') {
        return (_jsx("main", { className: "app app--centred", children: _jsx(StatusOrb, { state: "idle", label: "Connecting to the agent core" }) }));
    }
    if (agent.connection === 'failed' && !agent.status) {
        return (_jsxs("main", { className: "app app--centred", children: [_jsx(StatusOrb, { state: "failed", label: "The agent core is unavailable" }), _jsx("p", { className: "muted detail", children: agent.connectionDetail ?? 'Unknown error.' })] }));
    }
    return (_jsxs("main", { className: "app", children: [_jsxs("header", { className: "titlebar", children: [_jsx("span", { className: "titlebar__name", children: "SAMIX AGENT" }), _jsx(ModeBadge, { mode: agent.status?.mode ?? 'controlled', onChange: agent.actions.setMode, busy: busy })] }), _jsx("nav", { className: "tabs", role: "tablist", children: ['console', 'tools', 'settings', 'logs'].map((id) => (_jsx("button", { role: "tab", "aria-selected": pane === id, className: pane === id ? 'tab tab--active' : 'tab', onClick: () => setPane(id), children: id }, id))) }), agent.error && (_jsx("div", { className: "banner banner--error", role: "alert", children: agent.error })), agent.connection === 'stopped' && (_jsx("div", { className: "banner banner--error", role: "alert", children: "The agent core stopped. Restart the application." })), pane === 'console' && (_jsxs("section", { className: "pane", children: [_jsx(StatusOrb, { state: agent.status?.state ?? 'idle', label: describeState(agent.status?.state ?? 'idle') }), agent.confirmation && (_jsx(ConfirmationPrompt, { request: agent.confirmation, onRespond: (approved, all) => void agent.actions.respond(agent.confirmation.id, approved, all) })), _jsx(Transcript, { entries: agent.transcript }), agent.task && _jsx(TaskTimeline, { task: agent.task }), _jsxs("form", { className: "composer", onSubmit: onSubmit, children: [_jsx("input", { className: "composer__input", value: draft, onChange: (event) => setDraft(event.target.value), placeholder: busy ? 'Working…' : 'Type an instruction (voice arrives in Phase 2)', disabled: busy, "aria-label": "Instruction" }), _jsx("button", { className: "button", type: "submit", disabled: busy || draft.trim() === '', children: "Send" })] }), _jsxs("div", { className: "controls", children: [_jsx("button", { className: "button button--danger", onClick: () => void agent.actions.emergencyStop(), title: "Emergency stop (Ctrl+Shift+Space)", children: "Stop" }), busy && (_jsx("button", { className: "button button--ghost", onClick: () => void agent.actions.cancel(), children: "Cancel task" }))] })] })), pane === 'tools' && _jsx(ToolsPane, { tools: agent.tools, subsystems: agent.status?.subsystems ?? [] }), pane === 'settings' && agent.config && (_jsx(SettingsPane, { config: agent.config, onUpdate: agent.actions.updateConfig, onReset: agent.actions.resetConfig, busy: busy })), pane === 'logs' && _jsx(LogsPane, { entries: agent.logs }), _jsxs("footer", { className: "statusbar", children: [_jsx("span", { children: agent.status?.version ? `v${agent.status.version}` : '' }), _jsx("span", { className: agent.connection === 'ready' ? 'ok' : 'warn', children: agent.connection })] })] }));
}
function ModeBadge({ mode, onChange, busy, }) {
    return (_jsxs("label", { className: "mode", children: [_jsx("span", { className: "visually-hidden", children: "Agent mode" }), _jsxs("select", { className: `mode__select mode__select--${mode}`, value: mode, disabled: busy, onChange: (event) => onChange(event.target.value), 
                // Spec §55: mode changes the permission policy, so it must not change
                // underneath a running task.
                title: busy ? 'Cannot change mode while a task is running' : 'Agent mode', children: [_jsx("option", { value: "safe", children: "SAFE" }), _jsx("option", { value: "controlled", children: "CONTROLLED" }), _jsx("option", { value: "autonomous", children: "AUTONOMOUS" }), _jsx("option", { value: "developer", children: "DEVELOPER" })] })] }));
}
function describeState(state) {
    switch (state) {
        case 'listening':
            return 'Listening';
        case 'transcribing':
            return 'Transcribing';
        case 'understanding':
        case 'planning':
            return 'Thinking';
        case 'executing':
        case 'observing':
            return 'Working';
        case 'verifying':
            return 'Verifying';
        case 'recovering':
            return 'Recovering';
        case 'awaiting_confirmation':
            return 'Waiting for you';
        case 'failed':
            return 'Failed';
        default:
            return 'Ready';
    }
}
//# sourceMappingURL=App.js.map