import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * The single most important element in the console: at a glance, is the agent
 * idle, thinking, acting, or waiting for me? (Spec §36, Principle 7.)
 */
export function StatusOrb({ state, label }) {
    const tone = toneFor(state);
    return (_jsxs("div", { className: "orb", "data-tone": tone, children: [_jsx("div", { className: `orb__dot orb__dot--${tone}`, "aria-hidden": "true" }), _jsx("p", { className: "orb__label", children: label })] }));
}
function toneFor(state) {
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
//# sourceMappingURL=StatusOrb.js.map