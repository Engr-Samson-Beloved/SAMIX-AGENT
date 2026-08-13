import type {
  AgentEvent,
  IpcMethod,
  ParamsOf,
  ResultOf,
} from '@samix/shared';

/**
 * Typed client for the agent core.
 *
 * Two transports behind one interface:
 *
 *  - **Tauri** (production): `invoke('samix_request', …)` hops through the Rust
 *    host to the sidecar over stdio. Events arrive on a Tauri event channel.
 *  - **Dev HTTP** (development): a loopback bridge so the console runs in a
 *    plain browser tab against a live agent without compiling Rust. Enabled by
 *    `VITE_SAMIX_DEV_BRIDGE`; see core/transport/dev-http.ts.
 *
 * The transport is chosen once at startup by feature-detecting the Tauri global,
 * so no component ever needs to know which one is active.
 */

export type ConnectionStatus = 'connecting' | 'ready' | 'failed' | 'stopped';

export interface AgentClient {
  readonly transport: 'tauri' | 'dev-http';
  request<M extends IpcMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
  onEvent(handler: (event: AgentEvent) => void): () => void;
  onStatus(handler: (status: ConnectionStatus, detail?: string) => void): () => void;
}

class RequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

// ---------------------------------------------------------------------------
// Tauri transport
// ---------------------------------------------------------------------------

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function createTauriClient(): Promise<AgentClient> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');

  const eventHandlers = new Set<(event: AgentEvent) => void>();
  const statusHandlers = new Set<(status: ConnectionStatus, detail?: string) => void>();

  void listen<AgentEvent>('samix://event', ({ payload }) => {
    for (const handler of eventHandlers) handler(payload);
  });

  void listen<{ status: string; detail?: string }>('samix://core-status', ({ payload }) => {
    const status: ConnectionStatus =
      payload.status === 'running' ? 'ready' : payload.status === 'failed' ? 'failed' : 'stopped';
    for (const handler of statusHandlers) handler(status, payload.detail);
  });

  return {
    transport: 'tauri',
    async request(method, params) {
      const response = (await invoke('samix_request', { method, params })) as
        | { ok: true; result: unknown }
        | { ok: false; error: { code: string; message: string } };
      if (!response.ok) throw new RequestError(response.error.message, response.error.code);
      return response.result as never;
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

function createDevHttpClient(baseUrl: string, token: string): AgentClient {
  const eventHandlers = new Set<(event: AgentEvent) => void>();
  const statusHandlers = new Set<(status: ConnectionStatus, detail?: string) => void>();
  let counter = 0;

  const source = new EventSource(`${baseUrl}/events?token=${encodeURIComponent(token)}`);
  source.onopen = () => {
    for (const handler of statusHandlers) handler('ready');
  };
  source.onerror = () => {
    // EventSource reconnects on its own; report the gap without tearing down.
    for (const handler of statusHandlers) handler('failed', 'Lost the connection to the agent core.');
  };
  source.onmessage = (message) => {
    try {
      const frame = JSON.parse(message.data as string) as { kind: string; event: AgentEvent };
      if (frame.kind === 'event') {
        for (const handler of eventHandlers) handler(frame.event);
      }
    } catch {
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
      const frame = (await response.json()) as
        | { ok: true; result: unknown }
        | { ok: false; error: { code: string; message: string } };
      if (!frame.ok) throw new RequestError(frame.error.message, frame.error.code);
      return frame.result as never;
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

export async function createClient(): Promise<AgentClient> {
  if (isTauri()) return createTauriClient();

  const bridge = import.meta.env['VITE_SAMIX_DEV_BRIDGE'] as string | undefined;
  const token = import.meta.env['VITE_SAMIX_DEV_TOKEN'] as string | undefined;
  if (bridge && token) return createDevHttpClient(bridge.replace(/\/$/, ''), token);

  throw new Error(
    'No agent transport available. Run inside Tauri, or set VITE_SAMIX_DEV_BRIDGE and VITE_SAMIX_DEV_TOKEN to use the development bridge.',
  );
}
