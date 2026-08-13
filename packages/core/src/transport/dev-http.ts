import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import {
  IpcRequestFrameSchema,
  parseRequest,
  type AgentEvent,
} from '@samix/shared';
import type { RpcRouter } from '../rpc/router.js';
import type { Runtime } from '../runtime.js';

/**
 * DEVELOPMENT-ONLY transport: loopback HTTP with Server-Sent Events.
 *
 * ## Why this exists
 *
 * Compiling the Rust shell takes minutes. Frontend work needs a running agent
 * in a plain browser tab against Vite's dev server, with hot reload. This
 * provides that without duplicating any agent logic — it wraps the same
 * `RpcRouter` the production stdio transport uses.
 *
 * ## Why it is safe enough, and how it is constrained
 *
 * Spec §41 says avoid an unnecessary local HTTP server and bind 127.0.0.1
 * rather than 0.0.0.0. Both are honoured, plus:
 *
 *  - **Opt-in only.** Requires the explicit `--dev-bridge` flag; never starts
 *    in a packaged build.
 *  - **Refuses to run in production.** Hard exit if NODE_ENV is production.
 *  - **Bearer token**, generated per process, printed to stderr, compared with a
 *    timing-safe comparison. Loopback is not an authorisation boundary: any
 *    local process, including a browser tab on a malicious page, can reach
 *    127.0.0.1. The token is what stops drive-by requests.
 *  - **Strict CORS.** Only the configured Vite origin, credentials off.
 *  - **No wildcard route.** Exactly three endpoints.
 *
 * ## Zero dependencies
 *
 * `node:http` plus SSE. Node has no built-in WebSocket *server*, and SSE is the
 * better fit anyway: events flow one way (core → UI) and requests ride ordinary
 * POSTs.
 */

export interface DevHttpTransportOptions {
  readonly runtime: Runtime;
  readonly router: RpcRouter;
  readonly port?: number;
  /** Allowed browser origin. Defaults to the Vite dev server. */
  readonly origin?: string;
}

export class DevHttpTransport {
  private readonly runtime: Runtime;
  private readonly router: RpcRouter;
  private readonly port: number;
  private readonly origin: string;
  private readonly token = randomBytes(24).toString('hex');
  private readonly clients = new Set<http.ServerResponse>();
  private server: http.Server | undefined;
  private unsubscribe: (() => void) | undefined;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(options: DevHttpTransportOptions) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('The development HTTP bridge must never run in a production build.');
    }
    this.runtime = options.runtime;
    this.router = options.router;
    this.port = options.port ?? 8787;
    this.origin = options.origin ?? 'http://localhost:5173';
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => void this.route(req, res));
      this.server.on('error', reject);

      // 127.0.0.1, never 0.0.0.0 — spec §41.
      this.server.listen(this.port, '127.0.0.1', () => {
        this.unsubscribe = this.runtime.bus.onAny((event) => this.broadcast(event));

        // SSE connections die silently behind proxies and sleeping laptops.
        // A periodic comment keeps them alive and detectable.
        this.heartbeat = setInterval(() => {
          for (const client of this.clients) client.write(': ping\n\n');
        }, 25_000);
        this.heartbeat.unref?.();

        // stderr, not the log file: this is a development affordance the
        // operator needs to see immediately, and it is a credential.
        process.stderr.write(
          `\n  SAMIX dev bridge  http://127.0.0.1:${this.port}\n  token: ${this.token}\n\n`,
        );
        this.runtime.log.warn('development HTTP bridge started', { port: this.port });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unsubscribe?.();
    for (const client of this.clients) client.end();
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  /** Exposed so the dev launcher can print a ready-to-paste URL. */
  get bearerToken(): string {
    return this.token;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', this.origin);
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);

    // `/health` is unauthenticated on purpose: the dev launcher polls it to know
    // when the core is up, and it reveals nothing beyond liveness.
    if (url.pathname === '/health' && req.method === 'GET') {
      this.json(res, 200, { ok: true, version: this.runtime.agent.status().version });
      return;
    }

    if (!this.authorised(req, url)) {
      this.json(res, 401, { error: 'unauthorised' });
      return;
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      this.openEventStream(req, res);
      return;
    }

    if (url.pathname === '/rpc' && req.method === 'POST') {
      await this.handleRpc(req, res);
      return;
    }

    this.json(res, 404, { error: 'not found' });
  }

  /**
   * Bearer token via header, or `?token=` for EventSource — which cannot set
   * headers. Compared in constant time.
   */
  private authorised(req: http.IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization;
    const presented = header?.startsWith('Bearer ')
      ? header.slice(7)
      : (url.searchParams.get('token') ?? '');
    if (presented.length !== this.token.length) return false;
    return timingSafeEqual(Buffer.from(presented), Buffer.from(this.token));
  }

  private openEventStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  private async handleRpc(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: string;
    try {
      body = await readBody(req);
    } catch (error) {
      this.json(res, 413, { error: String(error) });
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      this.json(res, 400, { error: 'invalid JSON' });
      return;
    }

    const frame = IpcRequestFrameSchema.safeParse(raw);
    if (!frame.success) {
      this.json(res, 400, { error: 'malformed request frame' });
      return;
    }

    const parsed = parseRequest(frame.data);
    if (!parsed.ok) {
      this.json(res, 200, { kind: 'response', id: frame.data.id, ok: false, error: parsed.error });
      return;
    }

    const outcome = await this.router.handle(parsed.request);
    this.json(
      res,
      200,
      outcome.ok
        ? { kind: 'response', id: frame.data.id, ok: true, result: outcome.result }
        : { kind: 'response', id: frame.data.id, ok: false, error: outcome.error },
    );
  }

  private broadcast(event: AgentEvent): void {
    const payload = `data: ${JSON.stringify({ kind: 'event', event })}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}

/** Read a request body with a hard size cap, so a bad client cannot exhaust memory. */
function readBody(req: http.IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
