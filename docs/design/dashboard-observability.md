# Dashboard Observability

The built-in Dashboard projects the current ghc-proxy process and provides local
route-target management. Its typed frontend and time-windowed aggregates are
embedded in the package. It is not persistent request history: all observations
are content-free, process-local, and reset on restart.

## Scope

The sidebar groups six independently addressable pages under `/dashboard`:

| Group | Page | Purpose |
| --- | --- | --- |
| Monitor | Overview | Current health, window KPIs, traffic and completed-request latency trends, per-target health/quota, and recent failures |
| Monitor | Traffic | Terminal-state counts, approximate p50/p95, latency distribution, and request/failure breakdowns by model, target, and endpoint |
| Monitor | Requests | Active requests and the latest 256 terminal requests, URL filters, and structured lifecycle/routing/effect/error detail |
| Configure | Targets | GitHub and M365 identities, hostnames, health, client snippets, and capability-gated management actions |
| Configure | Models | Host-target metadata, routing/compatibility decisions, filtering, grouping, sorting, and multi-select TSV export |
| Configure | Behavior | Host-target configuration and selected-window effects beside process-wide cumulative totals |

The global target filter scopes Monitor pages and is hidden for a single target.
An absent `target` means All; a literal target named `all` remains distinct.
Managerless legacy processes show one implicit target read-only and Monitor shows
all traffic. A manager with routing disabled may offer the bootstrap action.
Models and Behavior describe the host target, not the Monitor filter.

The header carries aggregate health/version, Live, explicit metadata Refresh,
and System/Light/Dark theme selection. Narrow layouts use a keyboard-accessible
navigation menu. M365 prerequisite discovery and sign-in are explicit actions;
opening a page or polling never starts broker discovery.

The Dashboard stores no tokens, request/response content, or persistent analytics.
It does not rename accounts or measure first-token latency. Management writes the
existing credential/routing files through the transaction below; removing a
proxy target never removes a GitHub or Windows account.

## Request Lifecycle Storage

`RequestActivityStore` owns three process-local structures:

1. `Map<requestId, ActiveRequest>` for in-flight requests. Start and update are
   average O(1) for direct field updates. Recording a model trace is linear in
   that request's transform-step count.
2. A fixed 256-slot circular buffer for terminal requests. Completion writes
   one slot and advances one cursor in O(1), after projecting that request's
   per-request metadata arrays.
3. `WindowedMetrics`, a fixed set of lazy time-bucket rings described below.

A process restart clears active requests, retained terminal requests, and metrics.

Active requests are separate from the completed ring so high concurrency does
not overwrite an entry that still needs lifecycle updates.

Active requests use `in_flight` and `streaming`; terminal requests use `completed`,
`failed`, or `aborted`. JSON and pre-stream HTTP failures finalize at the response
hook. A successful streamed response stays active until the delivery wrapper's
finalizer observes stream end, upstream failure, or client cancellation. This
works whether stream end occurs before or after the framework response hook.
Duration therefore includes the full stream, not just its first chunk.

Upstream iterator cleanup precedes the outer delivery wrapper's finalizer.
Listener checks wait for the observed terminal state rather than treating
producer cleanup as the request's completion barrier.

The console access log still reports response start once; it is not the terminal
metrics timestamp. Target-gate refusals finalize with their refusal status and
`OPTIONS` preflights are not observed. Client cancellation records `aborted`
without a synthetic protocol error. A real failure wins a failure/cancellation
race. A late abort may reclassify a retained completed entry once, but not a
failed entry.

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

## Windowed Metrics

The store records terminal events and effects into three independent tiers:

| Window | Bucket width | Slots |
| --- | --- | --- |
| 15 minutes | 10 seconds | 90 |
| 1 hour | 1 minute | 60 |
| 24 hours | 15 minutes | 96 |

Slots carry absolute bucket identities and rotate lazily on writes, without
timers. Read-only queries merge retained slots and never rotate, reclaim, or
revive them. Completion is attributed to its completion interval; effects are
attributed when applied. A small clock regression may write an older retained
slot; a regression larger than a tier's window resets that tier on its next write.

Each target cell stores disjoint completed/failed/aborted counts, a 48-bin
latency histogram with count/sum, bounded model/endpoint counters, and effects.
Only completed requests contribute latency samples. The 47 finite bounds run
from 50 ms through 2,000,000 ms on an R10 ladder, plus overflow. A single sample
has an exact quantile; multiple samples report a histogram upper bound with
`approximate`, `at-most`, or `at-least` quality. Empty distributions return null.

Model admission is shared across the entire tier and capped at 16 names, not 16
per bucket or target. Excess values fold into a tagged `other`; the model recap
returns at most eight named rows plus folds. Named `other` and missing dimensions
remain distinct. Endpoint maps are capped at 64 entries per cell. All is a merge
of target cells, including legacy requests with no named target. Reusing a target
name merges its retained aggregate history for up to 24 hours, while quota cache
identity remains tied to the runtime instance.

Late-abort correction changes only the original retained slot/cell: completed
becomes aborted and its latency sample is removed. Expired or reused slots are
not recreated. `/` and `/health` remain in the request ring but are excluded from
windowed metrics; Dashboard traffic enters neither.

The API reports `collectionStartedAt`, covered duration, and `not-collected`,
`partial-start`, `open`, or `full` coverage. Uncollected time is unknown, not zero.
Request rate divides by covered time; error rate is failed / (completed + failed),
excluding aborted. Window effects and since-startup totals are separate values.

## Source Instrumentation

Observability is emitted where behavior is actually selected or applied:

- `server.ts` owns HTTP start, model discovery, error classification, and
  non-stream completion; `deliverResult()` owns stream-end finalization.
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
The account-domain manager exposes active runtime descriptors and routing state.
Dashboard owns the safe account projection, so account management does not
depend on Dashboard handlers or caches.

Quota is loaded when an account runtime's safe cache entry is missing or
expired, with a 60-second process-local cache keyed by runtime identity, not a
reusable account name. Concurrent reads for the same runtime coalesce; deleted
or replaced runtimes cannot supply quota to their successors. A failed load
exposes `unavailable`,
and an expired prior safe value is exposed as `stale`. The projection includes
plan, reset date, and the three quota pools; analytics IDs, organization data,
and quota IDs are discarded before caching. A five-second dashboard-only
timeout aborts a hung quota fetch so later polls can recover; the public
`/usage` route keeps its existing behavior.

`GET /dashboard/api/targets` and the lightweight overview read local health and
queue state only. Each target's `GET /dashboard/api/targets/:name/quota` owns its
quota failure domain, so a cold or failing upstream quota cannot hold up local
KPIs or other target cards. Runtime replacement changes the projection identity
and cannot reuse its predecessor's safe quota.

`POST /dashboard/api/refresh` forces metadata refresh in each active account's
runtime context. GitHub refreshes identity, quota, and models; M365 refreshes
models and broker credentials without requesting GitHub identity or quota.
`not_applicable` fields do not make the aggregate refresh fail. Real failures
retain prior safe values and expose `stale` or `unavailable`; the UI identifies
the affected account and metadata source without raw upstream error bodies.
An authorization-denied M365 catalog remains unavailable until access recovers.
Initial GET projections and Live polls do not force this metadata POST.

The explicit M365 sign-in action opens WAM and returns only account identity.
It does not select or register the target automatically, and it never returns
the acquired access token to the browser.

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
before reading configuration. An owner PID and process-local token prevent a
second process from restoring or deleting a journal while its owner is live;
owner liveness that cannot be verified also fails closed. A malformed journal
fails closed without changing either managed file. Default changes use the same
transaction boundary, so a failed switch leaves the old default active and
persistent.

Removal uses the same journal boundary for credential and hostname changes.
The current default and the sole remaining target are protected; the operator
must choose another default first. Refresh cleanup runs only after a committed
removal, and in-flight requests keep their captured runtime. Deleting the
account that owns the current Dashboard hostname redirects the browser to the
surviving base hostname with the same listener port.

Legacy startup atomically migrates to a one-account routing table only when the
credential store contains exactly one account. A credential created from the
former single-token configuration uses the `default` account name and receives
the dedicated hostname `default-account.localhost`; an existing persisted
account name remains its default rather than being renamed. A multi-account
credential store without routing stays in legacy active-account mode until the
routing configuration is supplied explicitly, rather than enabling a partial
account manager. The base and dedicated hostnames are exact after startup and
unknown hosts return `421`. The Dashboard bootstrap action remains available
for an already-created legacy manager, validates the chosen hostname, and uses
the same journal before installing routing.

## Serving and Security

`ui/` is a React/Vite project using Tailwind, Recharts, TanStack Query, and wouter.
`scripts/build-ui.ts` builds the fixed shell/scripts/stylesheet, scans for CSP
violations, checks gzip budgets, and emits a gitignored TypeScript asset module.
The server lazily imports its string constants through the bundled `dist/*.mjs`
graph. Consumers need only their selected runtime, with no asset file reads or
separate frontend installation/build. An unbuilt source checkout returns a small,
script-free 503 page instead of pretending the UI exists.

Exact shell routes cover `/dashboard` and `/dashboard/{overview,traffic,requests,
targets,models,behavior}`, including trailing slashes. Assets are
`/dashboard/assets/app.js`, `/dashboard/assets/app.css`, and
`/dashboard/theme-init.js`. Unknown page/API/asset paths remain JSON 404; no
wildcard swallows API errors. `src/types/dashboard.ts` is the zero-import shared
contract; response envelopes carry schema/version and process identity.

Responses keep `no-store`, `nosniff`, `no-referrer`, same-origin resource policy,
and frame denial. The unchanged strict self-only CSP is applied to the HTML shell,
not asset/API responses. There are no external fonts/resources, inline script or
style tags, or eval. The theme initializer is an external classic script; chart
styles use React's CSSOM path, not injected markup.

Every registered Dashboard surface requires an actual loopback socket peer on a
live server and a loopback URL hostname. A supplied `Origin` must match that URL's
origin. The hostname guard accepts `localhost`, `*.localhost`, `0.0.0.0`, and
explicit loopback IPv4/IPv6 addresses; hostname routing still applies its own
target admission. A remote peer cannot bypass access by spoofing Host. Runtime
values are escaped React text; lint rejects unsafe HTML insertion.

For hot reload, Vite proxies `/dashboard/api` to the proxy with object-form
`server.proxy` and no `changeOrigin`. Host and Origin are preserved, so named
hostnames still select the target and the production guard is not loosened.
A direct cross-origin dev-server request to the production API still gets 403.
Model TSV/client endpoints advertise the backend port rather than the Vite port.

The same guard covers all account-management methods. Ordinary legacy startup
completes its one-account routing migration before the Dashboard is available.
A process using a global GitHub-token or GHE-tenant override does not expose
account management and returns `409` rather than persisting ambiguous state.

`/dashboard` requests are excluded from both the request ring and access log so
polling does not displace proxy traffic or create console noise.

## Frontend State and Accessibility

The URL owns page, target, window, request selection, and request filters. Page
navigation and opening a request push history; filters/window/normalization replace
it. Missing retained requests keep their URL and show an explicit state without
selecting another request. A changed process or collection identity clears
selection/cached charts and announces a session change; schema mismatch requires
reload. Removed targets fall back to All with a notice.

TanStack Query owns fetching, cancellation, visibility, and timers. Header/local
activity poll at about 3 s, metric windows at 10/30/60 s, and quota at 30 s. Models
and M365 configuration load on mount, explicit Refresh, or mutation; broker
discovery never runs as a read. Live pauses hidden page reads and resumes stale
sources on return. Device-auth task observers remain above routes and continue
hidden or during navigation. Transport/5xx failures back off; 403/421 stop
automatic reads. Mutations suspend/cancel affected reads and refetch afterward;
host-changing navigation stops all reads first.

Each failure domain derives loading, ready, refreshing, empty, stale, unavailable,
or error state from its query, preserving last good data. Stale starts after two
failures, and only that source's success clears its error. Partial metadata
refresh names the target and failed source; a later metadata success does not
erase another region's error. Empty traffic is distinct from zero failures.

The shell owns route focus/title, a native mobile menu, persisted theme choice,
and one transition-only status region. Native dialogs return focus. Charts have
fixed time boundaries/coverage, generated summaries, numeric tables, and stable
timestamp/interval/dimension keyboard selection with Arrow/Home/End/Escape.
Recharts' accessibility layer and data animations are disabled; polled content
is not an assertive live region. Token contrast is checked in both themes.


## Performance Boundary

The proxy path performs bounded Map/record updates and counter increments, with
work proportional to the small per-request transform/effect arrays. Each metric
event touches three tiers and fixed-size histogram/admission structures. It does
not serialize request bodies, scan history, or sort on the write path.

Dashboard snapshots sort active requests in O(a log a) and copy at most 256
terminal entries. Window queries walk only retained tier slots/cells and merge
their bounded dimensions. Model projection, quota loading, aggregation, sorting,
and React/chart rendering run only for Dashboard reads, not inference requests.
