/**
 * @samix/shared — the contract layer.
 *
 * This package holds NO behaviour beyond validation and small pure helpers. It
 * is imported by the Node sidecar, the React frontend and (via generated JSON)
 * the Rust host, so anything with a runtime dependency on Node APIs belongs in
 * @samix/core instead.
 */

export * from './constants.js';
export * from './events.js';
export * from './ipc.js';
export * from './result.js';
export * from './types/agent.js';
export * from './types/config.js';
export * from './types/log.js';
export * from './types/mode.js';
export * from './types/tool.js';
