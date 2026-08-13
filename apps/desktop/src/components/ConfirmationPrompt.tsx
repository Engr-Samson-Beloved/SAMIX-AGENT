import type { ConfirmationRequest } from '@samix/shared';

/**
 * Confirmation prompt (spec §32, §95).
 *
 * Three things are always shown, because approving blind is worse than not
 * being asked: what will happen, *why* this needs approval, and the concrete
 * facts (paths, recipients, counts). "Approve the rest of this task" is scoped
 * to the current task only — a persistent blanket allow belongs in Settings,
 * where the user can see and revoke it.
 */
export function ConfirmationPrompt({
  request,
  onRespond,
}: {
  request: ConfirmationRequest;
  onRespond: (approved: boolean, approveRemainingInTask: boolean) => void;
}): React.JSX.Element {
  return (
    <section className="confirm" role="alertdialog" aria-labelledby="confirm-effect">
      <p className="confirm__permission">{request.permission.toUpperCase()}</p>
      <p className="confirm__effect" id="confirm-effect">
        {request.effect}
      </p>
      <p className="confirm__reason">{request.reason}</p>

      {request.facts.length > 0 && (
        <dl className="confirm__facts">
          {request.facts.map((fact) => (
            <div key={fact.label} className="confirm__fact">
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="confirm__actions">
        <button className="button" onClick={() => onRespond(true, false)} autoFocus>
          Approve
        </button>
        <button className="button button--ghost" onClick={() => onRespond(true, true)}>
          Approve rest of task
        </button>
        <button className="button button--danger" onClick={() => onRespond(false, false)}>
          Decline
        </button>
      </div>
    </section>
  );
}
