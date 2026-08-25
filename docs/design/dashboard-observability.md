# Dashboard Observability

The built-in dashboard is a read-only projection of the current ghc-proxy
process. It is intentionally not a request history, analytics, or admin
system.

## Scope

The dashboard exposes four views under `/dashboard`:

- Overview: process health, version, authentication state, quota, active
  requests, and upstream queue activity.
- Models: cached upstream model metadata plus ghc-proxy's effective routing
  and compatibility decisions.
- Behavior: current configuration, strategy order, and process-local effect
  counters.
- Requests: active requests plus the most recent 256 completed requests.

It does not write files, use a database, retain token statistics, accept
configuration changes, or expose request/response content.

## Request Lifecycle Storage

`RequestActivityStore` uses two structures:

1. `Map<requestId, ActiveRequest>` for in-flight requests. Start and update are
   O(1), and completion removes the entry in O(1).
2. A fixed 256-slot circular buffer for completed requests. Completion writes
   one slot and advances one cursor in O(1). A process restart clears both
   structures.

Active requests are separate from the completed ring so high concurrency does
not overwrite an entry that still needs lifecycle updates.

Each request stores only allowlisted metadata:

- Internal request ID
- Canonical endpoint name and HTTP method
- State, status, start time, and duration
- Sanitized requested/effective model IDs and the existing model transform
  trace
- Selected strategy and stable proxy effect IDs
- A fixed-category error summary

Raw URLs, query strings, caller request IDs, headers, tokens, request/response
bodies, tool payloads, reasoning content, and SSE data never enter the store.
Unknown paths are recorded as `unmatched`; dynamic response IDs are replaced by
`:responseId`.

## Source Instrumentation

Observability is emitted where behavior is actually selected or applied:

- `server.ts` owns HTTP start, model discovery, error classification, and
  completion.
- `runPipeline()` records the shared model trace and the actual selected
  `StrategyEntry.name`.
- Transform functions return small change indicators (boolean, count, or
  removed keys). Callers increment stable effect IDs only when the real
  transform changed the request.
- `runStrategy()` reports stream failures before protocol translation consumes
  them.
- The Responses terminal parser marks `response.failed` as a failed lifecycle
  even when the HTTP status is 200.
- The upstream queue exposes a read-only snapshot and emits recovery effects
  from its existing structured recovery events.

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
safe projection for 60 seconds and coalesces concurrent refreshes. The
projection includes plan, reset date, and the three quota pools; analytics IDs,
organization data, and quota IDs are discarded before caching. A five-second
dashboard-only timeout aborts a hung quota fetch so later polls can recover;
the public `/usage` route keeps its existing behavior.

## Serving and Security

HTML, CSS, and browser JavaScript are TypeScript string constants bundled into
the existing `dist/main.mjs` graph. The package performs no runtime asset file
reads and adds no frontend dependency or build step.

Dashboard responses use `Cache-Control: no-store`, a strict self-only Content
Security Policy, `nosniff`, `no-referrer`, same-origin resource policy, and
frame denial. On a live server, dashboard routes require the actual peer socket
address to be loopback; they also accept only loopback Host values, and browser
requests with a cross-origin `Origin` header receive 403. The peer check means a
remote client cannot bypass the boundary by spoofing `Host: localhost`. Runtime
values are inserted with DOM `textContent`, not HTML parsing.

`/dashboard` requests are excluded from both the request ring and access log so
polling does not displace proxy traffic or create console noise.

## Performance Boundary

The proxy request path performs only bounded `Map`/record updates and tiny
counter increments. Snapshot sorting, model projection, quota fetches, and DOM
rendering occur only on dashboard requests. No request body is cloned or
serialized for observability.
