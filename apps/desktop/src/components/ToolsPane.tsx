import type { AgentStatus, ToolDescriptor } from '@samix/shared';

/**
 * What the agent can actually do right now, and which subsystems are live.
 *
 * Subsystems that are not yet built report `not-implemented` with the phase
 * they arrive in, rather than showing as errors. An honest roadmap in the
 * product beats a red light that means nothing.
 */
export function ToolsPane({
  tools,
  subsystems,
}: {
  tools: ToolDescriptor[];
  subsystems: AgentStatus['subsystems'];
}): React.JSX.Element {
  return (
    <section className="pane pane--scroll">
      <h2 className="pane__title">Tools available in this mode</h2>
      {tools.length === 0 ? (
        <p className="muted">No tools are available in the current mode.</p>
      ) : (
        <ul className="tools">
          {tools.map((tool) => (
            <li key={tool.name} className="tool">
              <div className="tool__head">
                <code className="tool__name">{tool.name}</code>
                <span className={`chip chip--${tool.permission}`}>{tool.permission}</span>
              </div>
              <p className="tool__description">{tool.description}</p>
              <p className="tool__meta">
                {tool.reversibility} · verification: {tool.verification}
              </p>
            </li>
          ))}
        </ul>
      )}

      <h2 className="pane__title">Subsystems</h2>
      <ul className="subsystems">
        {subsystems.map((subsystem) => (
          <li key={subsystem.name} className="subsystem">
            <span className={`dot dot--${subsystem.status}`} aria-hidden="true" />
            <span className="subsystem__name">{subsystem.name}</span>
            <span className="subsystem__detail muted">{subsystem.detail ?? subsystem.status}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
