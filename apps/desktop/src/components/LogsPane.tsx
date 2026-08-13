import { useMemo, useState } from 'react';
import type { LogEntry, LogLevel } from '@samix/shared';

/**
 * Live log view (spec §37, §92).
 *
 * Streamed off the event bus, so it updates during automation rather than on a
 * refresh. Values are already redacted by the logger before they leave the core
 * — the UI never has to be trusted to hide a secret.
 */
export function LogsPane({ entries }: { entries: LogEntry[] }): React.JSX.Element {
  const [minLevel, setMinLevel] = useState<LogLevel | 'all'>('all');

  const visible = useMemo(() => {
    if (minLevel === 'all') return entries;
    const rank: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
    // `audit` is a category, not a severity: it always passes the filter.
    return entries.filter((e) => e.level === 'audit' || (rank[e.level] ?? 0) >= (rank[minLevel] ?? 0));
  }, [entries, minLevel]);

  return (
    <section className="pane pane--scroll">
      <div className="logs__toolbar">
        <label>
          <span className="visually-hidden">Minimum level</span>
          <select value={minLevel} onChange={(event) => setMinLevel(event.target.value as LogLevel)}>
            <option value="all">all</option>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </label>
        <span className="muted">{visible.length} entries</span>
      </div>

      <ol className="logs">
        {visible.map((entry, index) => (
          <li key={`${entry.timestamp}-${index}`} className={`log log--${entry.level}`}>
            <span className="log__time">{entry.timestamp.slice(11, 19)}</span>
            <span className={`log__level log__level--${entry.level}`}>{entry.level}</span>
            <span className="log__scope">{entry.scope}</span>
            <span className="log__message">{entry.message}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
