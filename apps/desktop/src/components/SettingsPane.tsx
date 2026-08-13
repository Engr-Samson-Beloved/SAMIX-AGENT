import type { AppConfig, AppConfigPatch, LogLevel } from '@samix/shared';

/**
 * Settings (spec §84).
 *
 * Phase 1 exposes the settings that are actually wired to behaviour. Voice, TTS
 * and LLM credentials appear as disabled rows labelled with the phase that
 * activates them: a control that silently does nothing is worse than one that
 * says why it is off.
 */
export function SettingsPane({
  config,
  onUpdate,
  onReset,
  busy,
}: {
  config: AppConfig;
  onUpdate: (patch: AppConfigPatch) => void;
  onReset: () => void;
  busy: boolean;
}): React.JSX.Element {
  return (
    <section className="pane pane--scroll">
      <h2 className="pane__title">Automation</h2>

      <Row label="Mode" hint="SAFE is read-only. CONTROLLED asks before anything outward-facing.">
        <select
          value={config.automation.mode}
          disabled={busy}
          onChange={(event) =>
            onUpdate({ automation: { mode: event.target.value as AppConfig['automation']['mode'] } })
          }
        >
          <option value="safe">SAFE</option>
          <option value="controlled">CONTROLLED</option>
          <option value="autonomous">AUTONOMOUS</option>
          <option value="developer">DEVELOPER</option>
        </select>
      </Row>

      <Row label="Max steps per task" hint="Hard ceiling on plan length.">
        <input
          type="number"
          min={1}
          max={100}
          value={config.automation.maxStepsPerTask}
          onChange={(event) =>
            onUpdate({ automation: { maxStepsPerTask: Number(event.target.value) } })
          }
        />
      </Row>

      <Row label="Retries per step" hint="Recovery attempts before a task fails.">
        <input
          type="number"
          min={0}
          max={5}
          value={config.automation.maxStepRetries}
          onChange={(event) =>
            onUpdate({ automation: { maxStepRetries: Number(event.target.value) } })
          }
        />
      </Row>

      <h2 className="pane__title">Security</h2>

      <Row label="Trusted folders" hint="The agent works more freely inside these (spec §85).">
        <ul className="paths">
          {config.security.trustedFolders.map((folder) => (
            <li key={folder}>
              <code>{folder}</code>
            </li>
          ))}
        </ul>
      </Row>

      <Row label="Blocked paths" hint="Always refused, even inside a trusted folder.">
        <ul className="paths">
          {config.security.blockedPathPatterns.map((pattern) => (
            <li key={pattern}>
              <code>{pattern}</code>
            </li>
          ))}
        </ul>
      </Row>

      <h2 className="pane__title">Interface</h2>

      <Row label="Hotkey" hint="Emergency stop. Restart to apply.">
        <input
          type="text"
          value={config.hotkey}
          onChange={(event) => onUpdate({ hotkey: event.target.value })}
        />
      </Row>

      <Row label="Close to tray" hint="Closing the window keeps the agent running.">
        <input
          type="checkbox"
          checked={config.ui.closeToTray}
          onChange={(event) => onUpdate({ ui: { closeToTray: event.target.checked } })}
        />
      </Row>

      <Row label="Start with Windows" hint="Off during development (spec §87).">
        <input
          type="checkbox"
          checked={config.ui.startWithWindows}
          onChange={(event) => onUpdate({ ui: { startWithWindows: event.target.checked } })}
        />
      </Row>

      <h2 className="pane__title">Logging</h2>

      <Row label="Level" hint="Audit records are always written regardless of this.">
        <select
          value={config.logging.level}
          onChange={(event) =>
            onUpdate({ logging: { level: event.target.value as Exclude<LogLevel, 'audit'> } })
          }
        >
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
      </Row>

      <h2 className="pane__title">Not yet active</h2>
      <ul className="pending">
        <li>
          Voice input &amp; transcription <span className="muted">— Phase 2</span>
        </li>
        <li>
          LLM provider &amp; API key <span className="muted">— Phase 3</span>
        </li>
        <li>
          Text to speech <span className="muted">— Phase 9+</span>
        </li>
      </ul>

      <button className="button button--ghost" onClick={onReset}>
        Reset all settings
      </button>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="setting">
      <div className="setting__label">
        <span>{label}</span>
        {hint && <span className="setting__hint muted">{hint}</span>}
      </div>
      <div className="setting__control">{children}</div>
    </div>
  );
}
