import {
  IPC_PROTOCOL_VERSION,
  type IpcError,
  type IpcMethod,
  type IpcRequest,
  type ResultOf,
} from '@samix/shared';
import type { Runtime } from '../runtime.js';

/**
 * Maps validated IPC requests onto runtime operations.
 *
 * Kept separate from the transports so that stdio (production) and loopback
 * HTTP (development) share one implementation and cannot drift — a bug fixed in
 * one would otherwise survive in the other.
 *
 * Every handler is total: it returns a result or a structured `IpcError`, and
 * never throws past this boundary. A transport that can be killed by a
 * malformed request is a denial-of-service on the user's own agent.
 */

export type RouterResult<M extends IpcMethod> =
  | { ok: true; result: ResultOf<M> }
  | { ok: false; error: IpcError };

export class RpcRouter {
  constructor(private readonly runtime: Runtime) {}

  async handle(request: IpcRequest): Promise<RouterResult<IpcMethod>> {
    try {
      const result = await this.dispatch(request);
      return { ok: true, result: result as ResultOf<IpcMethod> };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.runtime.log.warn('rpc handler failed', { method: request.method, error: message });
      return { ok: false, error: { code: 'INTERNAL_ERROR', message } };
    }
  }

  private async dispatch(request: IpcRequest): Promise<unknown> {
    const { agent, config, registry, logger, tasks } = this.runtime;

    switch (request.method) {
      case 'handshake': {
        if (request.params.protocolVersion !== IPC_PROTOCOL_VERSION) {
          // Version mismatch is fatal by design: silently proceeding with a
          // host that speaks a different protocol produces confusing partial
          // failures rather than one clear error.
          throw new Error(
            `Protocol mismatch: host speaks v${request.params.protocolVersion}, core speaks v${IPC_PROTOCOL_VERSION}.`,
          );
        }
        return { protocolVersion: IPC_PROTOCOL_VERSION, version: agent.status().version, pid: process.pid };
      }

      case 'status.get':
        return agent.status();

      case 'config.get':
        return config.get();

      case 'config.update':
        return config.update(request.params);

      case 'config.reset':
        return config.reset();

      case 'tools.list':
        return registry.describe(config.get().automation.mode);

      case 'task.submit':
        return agent.submit(request.params.instruction, request.params.source);

      case 'task.cancel':
        return agent.cancel(request.params.reason);

      case 'task.get':
        return tasks.find(request.params.taskId) ?? null;

      case 'task.history':
        return tasks.recent(request.params.limit);

      case 'confirmation.respond':
        return agent.respondToConfirmation(request.params);

      case 'logs.tail':
        return logger.tail(request.params.limit, request.params.minLevel);

      case 'agent.mode.set':
        return agent.setMode(request.params.mode);

      case 'agent.emergencyStop':
        return agent.emergencyStop();

      case 'agent.shutdown': {
        // Acknowledge first, tear down after the reply is on the wire —
        // otherwise the caller sees a closed pipe instead of confirmation.
        setTimeout(() => this.runtime.shutdown(), 50).unref?.();
        return { acknowledged: true };
      }

      default: {
        // Exhaustiveness: adding an IPC method without a handler fails the build.
        const unreachable: never = request;
        throw new Error(`Unhandled IPC method: ${JSON.stringify(unreachable)}`);
      }
    }
  }
}
