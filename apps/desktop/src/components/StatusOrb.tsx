/**
 * The single most important element in the console: at a glance, is the agent
 * idle, thinking, acting, or waiting for me? (Spec §36, Principle 7.)
 */
export function StatusOrb({ state, label }: { state: string; label: string }): React.JSX.Element {
  const tone = toneFor(state);
  return (
    <div className="orb" data-tone={tone}>
      <div className={`orb__dot orb__dot--${tone}`} aria-hidden="true" />
      <p className="orb__label">{label}</p>
    </div>
  );
}

function toneFor(state: string): string {
  switch (state) {
    case 'listening':
      return 'listening';
    case 'transcribing':
    case 'understanding':
    case 'planning':
      return 'thinking';
    case 'executing':
    case 'observing':
    case 'verifying':
    case 'recovering':
      return 'working';
    case 'awaiting_confirmation':
      return 'attention';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}
