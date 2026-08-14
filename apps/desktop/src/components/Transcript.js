import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef } from 'react';
/** What was asked and what the agent reported back. Deliberately terse. */
export function Transcript({ entries }) {
    const endRef = useRef(null);
    useEffect(() => {
        endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, [entries.length]);
    if (entries.length === 0) {
        return (_jsx("section", { className: "transcript transcript--empty", children: _jsx("p", { className: "muted", children: "Ask about this computer, or about the agent\u2019s status." }) }));
    }
    return (_jsxs("section", { className: "transcript", "aria-live": "polite", children: [entries.map((entry) => (_jsxs("p", { className: `transcript__line transcript__line--${entry.role}`, children: [_jsx("span", { className: "transcript__role", children: entry.role === 'user' ? 'You' : 'Agent' }), entry.text] }, entry.id))), _jsx("div", { ref: endRef })] }));
}
//# sourceMappingURL=Transcript.js.map