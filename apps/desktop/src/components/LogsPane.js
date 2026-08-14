import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from 'react';
/**
 * Live log view (spec §37, §92).
 *
 * Streamed off the event bus, so it updates during automation rather than on a
 * refresh. Values are already redacted by the logger before they leave the core
 * — the UI never has to be trusted to hide a secret.
 */
export function LogsPane({ entries }) {
    const [minLevel, setMinLevel] = useState('all');
    const visible = useMemo(() => {
        if (minLevel === 'all')
            return entries;
        const rank = { debug: 10, info: 20, warn: 30, error: 40 };
        // `audit` is a category, not a severity: it always passes the filter.
        return entries.filter((e) => e.level === 'audit' || (rank[e.level] ?? 0) >= (rank[minLevel] ?? 0));
    }, [entries, minLevel]);
    return (_jsxs("section", { className: "pane pane--scroll", children: [_jsxs("div", { className: "logs__toolbar", children: [_jsxs("label", { children: [_jsx("span", { className: "visually-hidden", children: "Minimum level" }), _jsxs("select", { value: minLevel, onChange: (event) => setMinLevel(event.target.value), children: [_jsx("option", { value: "all", children: "all" }), _jsx("option", { value: "debug", children: "debug" }), _jsx("option", { value: "info", children: "info" }), _jsx("option", { value: "warn", children: "warn" }), _jsx("option", { value: "error", children: "error" })] })] }), _jsxs("span", { className: "muted", children: [visible.length, " entries"] })] }), _jsx("ol", { className: "logs", children: visible.map((entry, index) => (_jsxs("li", { className: `log log--${entry.level}`, children: [_jsx("span", { className: "log__time", children: entry.timestamp.slice(11, 19) }), _jsx("span", { className: `log__level log__level--${entry.level}`, children: entry.level }), _jsx("span", { className: "log__scope", children: entry.scope }), _jsx("span", { className: "log__message", children: entry.message })] }, `${entry.timestamp}-${index}`))) })] }));
}
//# sourceMappingURL=LogsPane.js.map