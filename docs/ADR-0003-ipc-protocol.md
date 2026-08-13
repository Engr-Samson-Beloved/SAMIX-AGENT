# ADR-0003: IPC protocol — a closed method set over NDJSON

- **Status:** Accepted
- **Date:** 2026-08-12
- **Phase:** 1

## Context

Three processes must talk: the WebView (UI), the Rust host (native), and the
Node core (agent). Spec §75 is unambiguous about what must *not* exist:

> Bad: `runCommand(command: string)`
> Better: `launchApplication(appId)`, `copyFile(source, destination)`
> Every IPC capability should be explicit.

## Decision

**Transport:** newline-delimited JSON over the core's stdin/stdout.

**Shape:** three frame kinds — `request`, `response`, `event` — with request/
response correlated by `id`, and events pushed unsolicited.

**Surface:** a closed set of methods defined as a Zod discriminated union in
`@samix/shared/ipc.ts`. Both ends validate before acting.

## The rule that matters

**Tool invocation is not an IPC method.**

There is no `invokeTool(name, args)`. The UI submits an *instruction*; only the
planner inside the core decides which tools run. This keeps the permission
engine on the single unavoidable path to execution — a UI bug, a compromised
renderer or a malicious page in the WebView cannot reach a tool directly,
because no such door exists.

The Rust host exposes exactly one command, `samix_request(method, params)`,
which forwards a *named* method. It is not a shell: `method` is matched against
the closed union in the core and rejected otherwise.

## Why stdio rather than a socket

The core is a child of the host, so the pipe gives lifecycle coupling for free:
if the host dies, the pipe closes and the core exits. A crashed UI can never
leave automation running headless on the user's machine. A TCP socket would need
its own liveness protocol and would be reachable by any other local process.

## The stdout rule

**stdout carries protocol frames and nothing else.** One stray line corrupts the
stream and the host sees a hung or lying agent. Two mechanisms enforce this
rather than relying on discipline:

1. `LoggerService` physically cannot target stdout — it writes to a file and,
   optionally, stderr.
2. `StdioTransport.start()` rebinds `console.log`/`info`/`debug` to stderr, so a
   third-party package that prints cannot break the channel.

## Development bridge

Compiling Rust takes minutes; frontend work should not pay that on every change.
`--dev-bridge` additionally serves a loopback HTTP + Server-Sent Events bridge
wrapping the *same* `RpcRouter`, so the two transports cannot drift.

It is constrained deliberately:

- opt-in by flag, and throws if `NODE_ENV=production`;
- binds `127.0.0.1`, never `0.0.0.0` (spec §41);
- requires a per-process bearer token, compared with `timingSafeEqual` —
  loopback is *not* an authorisation boundary, since any local process,
  including a browser tab on a hostile page, can reach it;
- strict CORS to the Vite origin, and exactly three routes.

Zero dependencies: `node:http` plus SSE. Node has no built-in WebSocket server,
and SSE fits better anyway — events flow one way, requests ride ordinary POSTs.

## Versioning

`IPC_PROTOCOL_VERSION` is exchanged in a `handshake` frame. A mismatch is fatal
by design: proceeding with a host that speaks a different protocol produces
confusing partial failures instead of one clear error.
