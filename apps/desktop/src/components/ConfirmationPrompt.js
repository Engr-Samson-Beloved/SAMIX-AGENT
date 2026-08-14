import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Confirmation prompt (spec §32, §95).
 *
 * Three things are always shown, because approving blind is worse than not
 * being asked: what will happen, *why* this needs approval, and the concrete
 * facts (paths, recipients, counts). "Approve the rest of this task" is scoped
 * to the current task only — a persistent blanket allow belongs in Settings,
 * where the user can see and revoke it.
 */
export function ConfirmationPrompt({ request, onRespond, }) {
    return (_jsxs("section", { className: "confirm", role: "alertdialog", "aria-labelledby": "confirm-effect", children: [_jsx("p", { className: "confirm__permission", children: request.permission.toUpperCase() }), _jsx("p", { className: "confirm__effect", id: "confirm-effect", children: request.effect }), _jsx("p", { className: "confirm__reason", children: request.reason }), request.facts.length > 0 && (_jsx("dl", { className: "confirm__facts", children: request.facts.map((fact) => (_jsxs("div", { className: "confirm__fact", children: [_jsx("dt", { children: fact.label }), _jsx("dd", { children: fact.value })] }, fact.label))) })), _jsxs("div", { className: "confirm__actions", children: [_jsx("button", { className: "button", onClick: () => onRespond(true, false), autoFocus: true, children: "Approve" }), _jsx("button", { className: "button button--ghost", onClick: () => onRespond(true, true), children: "Approve rest of task" }), _jsx("button", { className: "button button--danger", onClick: () => onRespond(false, false), children: "Decline" })] })] }));
}
//# sourceMappingURL=ConfirmationPrompt.js.map