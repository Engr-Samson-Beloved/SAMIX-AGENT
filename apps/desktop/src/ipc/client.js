class RequestError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'RequestError';
    }
}
// ---------------------------------------------------------------------------
// Tauri transport
// ---------------------------------------------------------------------------
function isTauri() {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
async function createTauriClient() {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    const eventHandlers = new Set();
    const statusHandlers = new Set();
    void listen('samix://event', ({ payload }) => {
        for (const handler of eventHandlers)
            handler(payload);
    });
    void listen('samix://core-status', ({ payload }) => {
        const status = payload.status === 'running' ? 'ready' : payload.status === 'failed' ? 'failed' : 'stopped';
        for (const handler of statusHandlers)
            handler(status, payload.detail);
    });
    return {
        transport: 'tauri',
        async request(method, params) {
            const response = (await invoke('samix_request', { method, params }));
            if (!response.ok)
                throw new RequestError(response.error.message, response.error.code);
            return response.result;
        },
        onEvent(handler) {
            eventHandlers.add(handler);
            return () => eventHandlers.delete(handler);
        },
        onStatus(handler) {
            statusHandlers.add(handler);
            return () => statusHandlers.delete(handler);
        },
    };
}
// ---------------------------------------------------------------------------
// Development HTTP transport
// ---------------------------------------------------------------------------
function createDevHttpClient(baseUrl, token) {
    const eventHandlers = new Set();
    const statusHandlers = new Set();
    let counter = 0;
    const source = new EventSource(`${baseUrl}/events?token=${encodeURIComponent(token)}`);
    source.onopen = () => {
        for (const handler of statusHandlers)
            handler('ready');
    };
    source.onerror = () => {
        // EventSource reconnects on its own; report the gap without tearing down.
        for (const handler of statusHandlers)
            handler('failed', 'Lost the connection to the agent core.');
    };
    source.onmessage = (message) => {
        try {
            const frame = JSON.parse(message.data);
            if (frame.kind === 'event') {
                for (const handler of eventHandlers)
                    handler(frame.event);
            }
        }
        catch {
            // A malformed frame must not take down the console.
        }
    };
    return {
        transport: 'dev-http',
        async request(method, params) {
            const id = `req_${(counter += 1)}`;
            const response = await fetch(`${baseUrl}/rpc`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ kind: 'request', id, method, params }),
            });
            if (!response.ok) {
                throw new RequestError(`Bridge returned HTTP ${response.status}`, 'NETWORK_ERROR');
            }
            const frame = (await response.json());
            if (!frame.ok)
                throw new RequestError(frame.error.message, frame.error.code);
            return frame.result;
        },
        onEvent(handler) {
            eventHandlers.add(handler);
            return () => eventHandlers.delete(handler);
        },
        onStatus(handler) {
            statusHandlers.add(handler);
            return () => statusHandlers.delete(handler);
        },
    };
}
// ---------------------------------------------------------------------------
export async function createClient() {
    if (isTauri())
        return createTauriClient();
    const bridge = import.meta.env['VITE_SAMIX_DEV_BRIDGE'];
    const token = import.meta.env['VITE_SAMIX_DEV_TOKEN'];
    if (bridge && token)
        return createDevHttpClient(bridge.replace(/\/$/, ''), token);
    throw new Error('No agent transport available. Run inside Tauri, or set VITE_SAMIX_DEV_BRIDGE and VITE_SAMIX_DEV_TOKEN to use the development bridge.');
}
//# sourceMappingURL=client.js.map