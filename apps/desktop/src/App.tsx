import { useEffect, useState, type FormEvent } from 'react';
import type { AgentMode } from '@samix/shared';
import { useAgent } from './state/useAgent.js';
import { ConfirmationPrompt } from './components/ConfirmationPrompt.js';
import { LogsPane } from './components/LogsPane.js';
import { SettingsPane } from './components/SettingsPane.js';
import { StatusOrb } from './components/StatusOrb.js';
import { TaskTimeline } from './components/TaskTimeline.js';
import { ToolsPane } from './components/ToolsPane.js';
import { Transcript } from './components/Transcript.js';

/**
 * The agent console (spec §36).
 *
 * Explicitly not a chat application. The layout is: what the agent IS doing
 * (status), what it was ASKED (transcript), and what it is ACTUALLY DOING
 * (timeline of verified steps). Chat UIs bury the second two, and those are the
 * parts that make an operator trustworthy.
 */

type Pane = 'console' | 'tools' | 'settings' | 'logs';

export function App(): React.JSX.Element {
  const agent = useAgent();
  const [pane, setPane] = useState<Pane>('console');
  const [draft, setDraft] = useState('');

  // The tray menu asks the window to jump to a pane.
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let dispose: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<string>('samix://navigate', ({ payload }) => {
        if (payload === 'settings' || payload === 'logs') setPane(payload);
      }).then((unlisten) => {
        dispose = unlisten;
      }),
    );
    return () => dispose?.();
  }, []);

  const busy = agent.task !== undefined;

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    const instruction = draft.trim();
    if (instruction === '' || busy) return;
    setDraft('');
    void agent.actions.submit(instruction);
  }

  if (agent.connection === 'connecting') {
    return (
      <main className="app app--centred">
        <StatusOrb state="idle" label="Connecting to the agent core" />
      </main>
    );
  }

  if (agent.connection === 'failed' && !agent.status) {
    return (
      <main className="app app--centred">
        <StatusOrb state="failed" label="The agent core is unavailable" />
        <p className="muted detail">{agent.connectionDetail ?? 'Unknown error.'}</p>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="titlebar">
        <span className="titlebar__name">SAMIX AGENT</span>
        <ModeBadge mode={agent.status?.mode ?? 'controlled'} onChange={agent.actions.setMode} busy={busy} />
      </header>

      <nav className="tabs" role="tablist">
        {(['console', 'tools', 'settings', 'logs'] as const).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={pane === id}
            className={pane === id ? 'tab tab--active' : 'tab'}
            onClick={() => setPane(id)}
          >
            {id}
          </button>
        ))}
      </nav>

      {agent.error && (
        <div className="banner banner--error" role="alert">
          {agent.error}
        </div>
      )}

      {agent.connection === 'stopped' && (
        <div className="banner banner--error" role="alert">
          The agent core stopped. Restart the application.
        </div>
      )}

      {pane === 'console' && (
        <section className="pane">
          <StatusOrb
            state={agent.status?.state ?? 'idle'}
            label={describeState(agent.status?.state ?? 'idle')}
          />

          {agent.confirmation && (
            <ConfirmationPrompt
              request={agent.confirmation}
              onRespond={(approved, all) =>
                void agent.actions.respond(agent.confirmation!.id, approved, all)
              }
            />
          )}

          <Transcript entries={agent.transcript} />

          {agent.task && <TaskTimeline task={agent.task} />}

          <form className="composer" onSubmit={onSubmit}>
            <input
              className="composer__input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={busy ? 'Working…' : 'Type an instruction (voice arrives in Phase 2)'}
              disabled={busy}
              aria-label="Instruction"
            />
            <button className="button" type="submit" disabled={busy || draft.trim() === ''}>
              Send
            </button>
          </form>

          <div className="controls">
            <button
              className="button button--danger"
              onClick={() => void agent.actions.emergencyStop()}
              title="Emergency stop (Ctrl+Shift+Space)"
            >
              Stop
            </button>
            {busy && (
              <button className="button button--ghost" onClick={() => void agent.actions.cancel()}>
                Cancel task
              </button>
            )}
          </div>
        </section>
      )}

      {pane === 'tools' && <ToolsPane tools={agent.tools} subsystems={agent.status?.subsystems ?? []} />}

      {pane === 'settings' && agent.config && (
        <SettingsPane
          config={agent.config}
          onUpdate={agent.actions.updateConfig}
          onReset={agent.actions.resetConfig}
          busy={busy}
        />
      )}

      {pane === 'logs' && <LogsPane entries={agent.logs} />}

      <footer className="statusbar">
        <span>{agent.status?.version ? `v${agent.status.version}` : ''}</span>
        <span className={agent.connection === 'ready' ? 'ok' : 'warn'}>{agent.connection}</span>
      </footer>
    </main>
  );
}

function ModeBadge({
  mode,
  onChange,
  busy,
}: {
  mode: AgentMode;
  onChange: (mode: AgentMode) => void;
  busy: boolean;
}): React.JSX.Element {
  return (
    <label className="mode">
      <span className="visually-hidden">Agent mode</span>
      <select
        className={`mode__select mode__select--${mode}`}
        value={mode}
        disabled={busy}
        onChange={(event) => onChange(event.target.value as AgentMode)}
        // Spec §55: mode changes the permission policy, so it must not change
        // underneath a running task.
        title={busy ? 'Cannot change mode while a task is running' : 'Agent mode'}
      >
        <option value="safe">SAFE</option>
        <option value="controlled">CONTROLLED</option>
        <option value="autonomous">AUTONOMOUS</option>
        <option value="developer">DEVELOPER</option>
      </select>
    </label>
  );
}

function describeState(state: string): string {
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
