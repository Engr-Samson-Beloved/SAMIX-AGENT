import type { Task, TaskStep } from '@samix/shared';

/**
 * Execution timeline (spec §48).
 *
 * Renders verification status distinctly from success. A step that ran but
 * could not be confirmed shows as "unverified", never as a tick — development
 * rule 25 has to be visible in the interface, not just true in the log.
 */
export function TaskTimeline({ task }: { task: Task }): React.JSX.Element {
  return (
    <section className="timeline">
      <h2 className="timeline__title">Task</h2>
      <ol className="timeline__list">
        {task.steps.map((step) => (
          <li key={step.id} className={`timeline__step timeline__step--${step.status}`}>
            <span className="timeline__marker" aria-hidden="true">
              {markerFor(step.status)}
            </span>
            <span className="timeline__text">
              {step.description}
              {step.status === 'succeeded_unverified' && (
                <em className="timeline__caveat"> — could not confirm</em>
              )}
              {step.error && <em className="timeline__caveat"> — {step.error.message}</em>}
            </span>
            {step.durationMs !== undefined && (
              <span className="timeline__duration">{step.durationMs}ms</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function markerFor(status: TaskStep['status']): string {
  switch (status) {
    case 'succeeded':
      return '✓';
    case 'succeeded_unverified':
      return '?';
    case 'failed':
      return '✕';
    case 'cancelled':
      return '−';
    case 'running':
    case 'verifying':
      return '●';
    case 'awaiting_confirmation':
      return '!';
    default:
      return '·';
  }
}
