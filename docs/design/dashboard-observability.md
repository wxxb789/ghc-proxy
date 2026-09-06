# Dashboard Observability

The built-in dashboard is a safe projection of the current ghc-proxy process
and, in named-account routing mode, the local management surface for adding an
account and selecting the explicit default. It is intentionally not a request
history or analytics system.

## Scope

The dashboard exposes five views under `/dashboard`:

- Overview: process health, version, authentication state, quota, active
  requests, and upstream queue activity.
- Accounts: each routed account's stable hostname, GitHub identity and tenant,
  authentication/Copilot state, quota, and default marker; it also starts new
  device authentication and changes the default account.
- Models: cached upstream model metadata plus ghc-proxy's effective routing
  and compatibility decisions.
- Behavior: current configuration, strategy order, and process-local effect
  counters.
- Requests: active requests plus the most recent 256 terminal requests.

It does not use a database, retain token statistics, delete or rename accounts,
or expose request/response content. Account management writes only the existing
credential and routing configuration files through the transaction described
below.

## Request Lifecycle Storage

`RequestActivityStore` uses two structures:

1. `Map<requestId, ActiveRequest>` for in-flight requests. Start and update are
   average O(1) for direct field updates. Recording a model trace is linear in
   that request's transform-step count.
2. A fixed 256-slot circular buffer for terminal requests. Completion writes
   one slot and advances one cursor in O(1), after projecting that request's
   per-request metadata arrays. A process restart clears both structures.

Active requests are separate from the completed ring so high concurrency does
not overwrite an entry that still needs lifecycle updates.

Active requests use `in_flight` and `streaming` states. Terminal requests use
`completed`, `failed`, or `aborted`. Client cancellation is recorded as
`aborted` without synthesizing a protocol error. A real failure remains
authoritative if failure and cancellation race, so a late abort never
reclassifies a failed request. The store can reclassify a just-completed entry
as aborted when framework callback ordering reports the client disconnect
after HTTP completion.

Each request stores only allowlisted metadata:

- Internal request ID
- Canonical endpoint name and HTTP method
- State, status, start time, and duration
- Sanitized requested/effective model IDs and the existing model transform
  trace
- Selected strategy and stable proxy effect IDs
- An allowlisted, fixed-shape error summary

Raw URLs, query strings, caller request IDs, headers, tokens, request/response
bodies, tool payloads, reasoning content, and SSE data never enter the store.
Unknown paths are recorded as `unmatched`; dynamic response IDs are replaced by
`:responseId`.

Error storage accepts only fixed summary strings or an HTTP status plus a
bounded category. Categories extracted from error payloads must match the
explicit allowlist in `request-store.ts`; unknown text collapses to `Unhandled
proxy error` rather than entering the ring.

## Source Instrumentation

Observability is emitted where behavior is actually selected or applied:

- `server.ts` owns HTTP start, model discovery, error classification, and
  completion.
- `runPipeline()` records the shared model trace and the actual selected
  `StrategyEntry.name`.
- Hostname-routed requests record the selected operator-defined account name;
  legacy single-account requests omit the field. Tokens and credential-derived
  identifiers are never stored.
- Transform functions return small change indicators (boolean, count, or
  removed keys). Callers increment stable effect IDs only when the real
  transform changed the request.
- The shared upstream signal reports client-originated cancellation as
  `aborted` for pipeline execution and upstream-backed handlers that bypass the
  pipeline. `runStrategy()` still reports non-client stream failures before
  protocol translation consumes them.
- The Responses terminal parser marks `response.failed` as a failed lifecycle
  even when the HTTP status is 200.
- Both the public Responses path and Messages-via-Responses mark a clean stream
  EOF without a terminal response as `response_stream_eof` (unless the client
  aborted).
- The upstream queue exposes a read-only snapshot and emits recovery effects
  from its existing structured recovery events. The current queue
  implementation records those effects directly into the global
  `runtimeStore.requests`, including for separately constructed queue
  instances; an injected logger does not replace that side effect.

The dashboard never parses console output and never infers effects by diffing
or serializing request bodies.

## Runtime Introspection

The dashboard reuses the same runtime sources as request execution:

- `modelCache` predicates for endpoint and effective capability checks
- `resolveMessagesStrategyName()` for Messages strategy selection
- `resolveStrippedResponsesParams()` for parameter filtering
- `getModelFallbackConfig()` for environment/config/default precedence
- `configStore` getters for rewrites, compact routing, overload fallbacks,
  context management, and tool compatibility
- `UpstreamRequestQueue.snapshot()` for active and pending work

Upstream model records remain unchanged. The dashboard creates a separate
effective projection so upstream capability provenance is not lost.

## Quota and Authentication

Authentication projection is allowlist-only. It contains presence/status,
login, expiry, and refresh/validation timestamps, never tokens or raw errors.

Quota is fetched only from the dashboard path. A process-local cache keeps one
safe projection per selected account for 60 seconds and coalesces concurrent
refreshes within that account. The projection includes plan, reset date, and the
three quota pools; analytics IDs, organization data, and quota IDs are discarded
before caching. A five-second dashboard-only timeout aborts a hung quota fetch
so later polls can recover; the public `/usage` route keeps its existing
behavior.

Dashboard device authentication exposes only the user code, verification URL,
expiry, polling interval, and a random local session ID. The GitHub device code,
GitHub token, Copilot token, and raw upstream error bodies never enter a
Dashboard response or log. A new runtime is installed only after GitHub
identity, Copilot token, and model discovery all succeed.

## Account Mutation Transaction

Every routed account has exactly one dedicated hostname. `baseHostname` is an
additional alias for `defaultAccount`; changing the default updates only that
alias and the fixed `127.0.0.1` loopback alias while leaving the dedicated
hostname map unchanged.

Account mutations are serialized. Adding an account validates the complete next
routing table before persistence, then journals the exact previous
`credentials.json` and `config.json`, atomically writes the credential first,
atomically writes routing second, installs the prevalidated runtime, and removes
the journal last. A returned failure rolls both files and the runtime map back.
If the process stops during the operation, startup restores the journaled state
before reading configuration. A malformed journal fails closed without changing
either managed file. Default changes use the same transaction boundary, so a
failed switch leaves the old default active and persistent.

Legacy single-account startup prepares, but does not commit, a one-account
routing table. The active legacy credential remains the default and receives the
editable suggestion `defaultaccount.localhost`. The Dashboard bootstrap action
validates the chosen hostname, writes `accountRouting` through the same journal,
and installs the already-authenticated legacy runtime only after the write is
ready to commit. Before confirmation, arbitrary legacy Host values continue to
work. After success, the base and dedicated hostnames are exact and unknown
hosts return `421`. A failed bootstrap restores routing-disabled legacy state.

## Serving and Security

HTML, CSS, and browser JavaScript are TypeScript string constants bundled into
the existing `dist/main.mjs` graph. The package performs no runtime asset file
reads and adds no frontend dependency or build step.

Dashboard responses use `Cache-Control: no-store`, a strict self-only Content
Security Policy, `nosniff`, `no-referrer`, same-origin resource policy, and
frame denial. On a live server, dashboard routes require the actual peer socket
address to be loopback. The URL hostname must be `localhost`, any
`*.localhost` name, `0.0.0.0`, or an explicit loopback IPv4/IPv6 address;
browser requests with a cross-origin `Origin` header receive 403. The peer
check means a remote client cannot bypass the boundary by spoofing one of those
Host values. Runtime values are inserted with DOM `textContent`, not HTML
parsing.

The same guard covers all account-management methods. In ordinary legacy mode,
account inspection and the explicit bootstrap action are available, while add
and default-switch operations return `409` until routing is enabled. A process
using a global GitHub-token or GHE-tenant override does not expose bootstrap and
returns `409` for account management rather than persisting ambiguous state.

`/dashboard` requests are excluded from both the request ring and access log so
polling does not displace proxy traffic or create console noise.

## Performance Boundary

The proxy request path performs direct `Map`/record updates, counter increments,
and work proportional to the small model-transform/effect arrays attached to
that request. It does not clone or serialize request bodies for observability.

Dashboard snapshots sort the active set in O(a log a), where `a` is the number
of active observed requests, and copy at most 256 terminal entries. Model
projection, quota fetches, snapshot sorting, and DOM rendering occur only on
dashboard requests.
