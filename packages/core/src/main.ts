/**
 * Sidecar entrypoint.
 *
 * Launched by the Tauri host as a child process. Speaks NDJSON over stdio
 * (see transport/stdio.ts). With `--dev-bridge` it additionally serves a
 * loopback HTTP bridge so the React console can run in a browser against a live
 * agent without compiling Rust.
 *
 * Usage:
 *   node dist/main.js                 # production: stdio only
 *   node dist/main.js --dev-bridge    # development: stdio + 127.0.0.1 bridge
 */

import { RpcRouter } from './rpc/router.js';
import { createRuntime } from './runtime.js';
import { DevHttpTransport } from './transport/dev-http.js';
import { StdioTransport } from './transport/stdio.js';

interface CliOptions {
  devBridge: boolean;
  port: number;
  dataDir: string | undefined;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { devBridge: false, port: 8787, dataDir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dev-bridge') options.devBridge = true;
    else if (arg === '--port') options.port = Number(argv[++i] ?? options.port);
    else if (arg === '--data-dir') options.dataDir = argv[++i];
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const runtime = createRuntime({
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    // In dev-bridge mode there is no host reading stdout, so mirroring logs to
    // stderr is what makes the process observable in a terminal.
    ...(options.devBridge ? { logToStderr: true } : {}),
  });
  const router = new RpcRouter(runtime);

  let devBridge: DevHttpTransport | undefined;
  let shuttingDown = false;

  // Declared before the transports so `onDisconnect` can reach it. Stopping
  // every transport is the entrypoint's job — a transport that tore the process
  // down on its own would leave the others serving a dead runtime.
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.log.info('shutting down', { reason });
    stdio.close();
    void devBridge?.stop();
    runtime.shutdown();
    // Give pending writes a moment to flush before exiting.
    setTimeout(() => process.exit(0), 100).unref?.();
  };

  const stdio = new StdioTransport({
    runtime,
    router,
    onDisconnect: () => shutdown('host closed the pipe'),
  });
  stdio.start();

  if (options.devBridge) {
    devBridge = new DevHttpTransport({ runtime, router, port: options.port });
    await devBridge.start();
  }

  runtime.agent.start();

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A crash while automation is running is the dangerous case: the agent may be
  // holding synthetic input. Log, stop the agent, then exit non-zero so the host
  // knows to restart rather than assume a clean exit.
  process.on('uncaughtException', (error) => {
    runtime.log.error('uncaught exception', { error: String(error), stack: error.stack });
    try {
      runtime.agent.emergencyStop();
    } catch {
      // Nothing useful left to do; prioritise exiting.
    }
    runtime.shutdown();
    setTimeout(() => process.exit(1), 100).unref?.();
  });

  process.on('unhandledRejection', (reason) => {
    runtime.log.error('unhandled promise rejection', { reason: String(reason) });
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
