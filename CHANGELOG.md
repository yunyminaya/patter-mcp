# Changelog

All notable changes to patter-mcp are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- **stdio transport (`--stdio`).** Launch with `npx -y getpatter-mcp --stdio`
  (or `MCP_TRANSPORT=stdio`) to run over a stdio subprocess transport that a
  local MCP client (OpenClaw, Hermes, Claude Desktop) spawns directly — no HTTP
  port, no URL. The default (no flag) is unchanged: Streamable HTTP at
  `:3000/mcp`. Both modes serve the SAME 7 tools and resources; the stdio path
  reuses mcp-use's `getServerForSession()` to replay every registration onto a
  native `@modelcontextprotocol/sdk` server connected to a
  `StdioServerTransport`, so nothing is duplicated
  (`src/index.ts` → `startStdio`). In stdio mode `/health`, the `/inspector`
  UI, and Auth0 OAuth are unavailable (HTTP-only); the subprocess boundary is
  the trust boundary.

### Fixed

- **stdout purity in stdio mode.** A stray `console.log` in the mcp-use
  resource-template registration would otherwise corrupt the JSON-RPC stream.
  `src/index.ts` now reroutes `console.log` / `console.info` / `console.debug`
  to stderr when `--stdio` is set, before any registration runs, so stdout
  carries nothing but MCP protocol frames. Inbound lifecycle notifications
  (`incoming_call` / `call_ended`) and the active-calls resource nudge are
  routed to the stdio-connected native server (mcp-use's HTTP session fan-out
  is empty under stdio); graceful shutdown also closes the stdio transport.

## 0.4.0

Adopts the completion-aware outbound primitive from `getpatter@0.6.3`.

### Fixed

- **`call_third_party` now works end-to-end.** The outbound path previously
  correlated the dial to its lifecycle callbacks with a `pending_<ts>`
  provisional id that never matched the real carrier SID (`phone.call()`
  resolved to `void`). The server-wide `onCallStart` / `onCallEnd` handlers
  therefore never matched the outbound branch, so `waitForCallEnd()` polled a
  record stuck in `ringing` until it timed out. `makeCall()` now awaits
  `phone.call({ ..., wait: true })`, which resolves with a real `CallResult`
  when the call hangs up, and maps it straight into a `CallRecord`.
- **Inbound call duration.** The inbound finaliser read a non-existent
  top-level `data.duration` (always `0`); it now reads
  `metrics.duration_seconds`.
- **Concurrent rate-limit no longer leaks in DB mode.** The old provisional
  record was written to SQLite as `ringing` and never promoted, so the
  per-user concurrent counter inflated permanently and blocked users after a
  couple of calls. Concurrent accounting is now an in-memory counter scoped to
  the lifetime of `makeCall()` (the only window a call is actually live under
  the `wait: true` model).

### Added

- **`CallRecord.outcome`** — the carrier-agnostic outcome
  (`answered` / `voicemail` / `no_answer` / `busy` / `failed`) lifted from the
  SDK `CallResult`, persisted to a new `outcome` column (added via an idempotent
  migration for existing databases).
- **Graceful shutdown.** `SIGTERM` / `SIGINT` now call `phone.disconnect()` to
  tear down the cloudflared tunnel, the WebSocket server, and any pending
  completion awaiters. Previously the tunnel and WS server were abandoned on
  exit.

### Changed

- **`make_call` is now completion-aware.** It blocks until the call ends and
  returns the outcome, duration, and full transcript, instead of returning a
  synthetic call id immediately. (Returning a real, useful id was impossible
  under fire-and-forget: `phone.call()` with `wait: false` resolves to `void`.)
- **Per-call duration ceiling is enforced by the SDK.** The MCP-side duration
  timer was removed; `call({ wait: true })` is timeout-bounded and the embedded
  server arms its own max-duration guard. `MAX_CALL_DURATION_SECONDS` is kept as
  informational config.
- Bumped `getpatter` dependency from `^0.6.2` to `^0.6.3`.

### Removed

- The outbound `provisionalId` mechanism, `PatterServer.waitForCallEnd()` (and
  its polling loop), the per-call `durationTimers` map, and the outbound branch
  of the `onCallStart` / `onCallEnd` lifecycle handlers — all obviated by
  `call({ wait: true })`.
