import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Execution timeline (spec §48).
 *
 * Renders verification status distinctly from success. A step that ran but
 * could not be confirmed shows as "unverified", never as a tick — development
 * rule 25 has to be visible in the interface, not just true in the log.
 */
export function TaskTimeline({ task }) {
    return (_jsxs("section", { className: "timeline", children: [_jsx("h2", { className: "timeline__title", children: "Task" }), _jsx("ol", { className: "timeline__list", children: task.steps.map((step) => (_jsxs("li", { className: `timeline__step timeline__step--${step.status}`, children: [_jsx("span", { className: "timeline__marker", "aria-hidden": "true", children: markerFor(step.status) }), _jsxs("span", { className: "timeline__text", children: [step.description, step.status === 'succeeded_unverified' && (_jsx("em", { className: "timeline__caveat", children: " \u2014 could not confirm" })), step.error && _jsxs("em", { className: "timeline__caveat", children: [" \u2014 ", step.error.message] })] }), step.durationMs !== undefined && (_jsxs("span", { className: "timeline__duration", children: [step.durationMs, "ms"] }))] }, step.id))) })] }));
}
function markerFor(status) {
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
//# sourceMappingURL=TaskTimeline.js.map