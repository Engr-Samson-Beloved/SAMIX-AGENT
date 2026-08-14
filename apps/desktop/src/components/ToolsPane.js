import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * What the agent can actually do right now, and which subsystems are live.
 *
 * Subsystems that are not yet built report `not-implemented` with the phase
 * they arrive in, rather than showing as errors. An honest roadmap in the
 * product beats a red light that means nothing.
 */
export function ToolsPane({ tools, subsystems, }) {
    return (_jsxs("section", { className: "pane pane--scroll", children: [_jsx("h2", { className: "pane__title", children: "Tools available in this mode" }), tools.length === 0 ? (_jsx("p", { className: "muted", children: "No tools are available in the current mode." })) : (_jsx("ul", { className: "tools", children: tools.map((tool) => (_jsxs("li", { className: "tool", children: [_jsxs("div", { className: "tool__head", children: [_jsx("code", { className: "tool__name", children: tool.name }), _jsx("span", { className: `chip chip--${tool.permission}`, children: tool.permission })] }), _jsx("p", { className: "tool__description", children: tool.description }), _jsxs("p", { className: "tool__meta", children: [tool.reversibility, " \u00B7 verification: ", tool.verification] })] }, tool.name))) })), _jsx("h2", { className: "pane__title", children: "Subsystems" }), _jsx("ul", { className: "subsystems", children: subsystems.map((subsystem) => (_jsxs("li", { className: "subsystem", children: [_jsx("span", { className: `dot dot--${subsystem.status}`, "aria-hidden": "true" }), _jsx("span", { className: "subsystem__name", children: subsystem.name }), _jsx("span", { className: "subsystem__detail muted", children: subsystem.detail ?? subsystem.status })] }, subsystem.name))) })] }));
}
//# sourceMappingURL=ToolsPane.js.map