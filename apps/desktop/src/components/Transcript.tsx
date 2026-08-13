import { useEffect, useRef } from 'react';
import type { TranscriptEntry } from '../state/useAgent.js';

/** What was asked and what the agent reported back. Deliberately terse. */
export function Transcript({ entries }: { entries: TranscriptEntry[] }): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <section className="transcript transcript--empty">
        <p className="muted">Ask about this computer, or about the agent&rsquo;s status.</p>
      </section>
    );
  }

  return (
    <section className="transcript" aria-live="polite">
      {entries.map((entry) => (
        <p key={entry.id} className={`transcript__line transcript__line--${entry.role}`}>
          <span className="transcript__role">{entry.role === 'user' ? 'You' : 'Agent'}</span>
          {entry.text}
        </p>
      ))}
      <div ref={endRef} />
    </section>
  );
}
