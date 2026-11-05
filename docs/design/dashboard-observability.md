# Dashboard Observability

The built-in dashboard is a safe projection of the current ghc-proxy process
and, in named-account routing mode, the local management surface for adding an
account and selecting the explicit default. It is intentionally not a request
history or analytics system.

## Scope

The dashboard is one page at `/dashboard` with five views in two groups.

Monitor:

- Overview: a one-line health summary, the Issues list, process health,
  version, authentication state, quota, active requests, and upstream queue
  activity. Authentication identifies the current request account, the
  configured default account, and the count of active routed accounts.
- Requests: active requests plus the most recent 256 terminal requests, with
  a state filter, a text filter, and a detail pane for the selected request.

Configure:

- Accounts: each routed account's stable hostname, upstream identity and tenant,
  authentication/Copilot state, quota, and default marker. GitHub device auth
  and M365 broker sign-in are separate actions. M365 shows its email and
  Microsoft tenant, with GitHub-only fields marked `not_applicable`. Broker
  discovery (`POST /dashboard/api/m365/probe`) runs automatically at most once
  per page load, on the first Accounts visit, including a page opened directly
  at `#/accounts`, and only when the M365 projection reports onboarding as
  available. It also runs on an explicit probe, but never on a Live poll.
  Accounts can select the default and remove a non-default target. The M365
  projection reads committed routing and target availability, independent of
  the hostname used to open the Dashboard.
- Models: cached upstream model metadata plus ghc-proxy's effective routing
  and compatibility decisions.
- Behavior: current configuration, strategy order, and process-local effect
  counters.

Views are addressed by the URL hash, `#/<view>?<params>` (for example
`#/requests?state=failed` or `#/accounts?section=m365`). The hash never reaches
the server, so every view is served by the single `/dashboard` route. An empty
hash opens Overview, an unknown view is replaced with `#/overview`, and invalid
or default parameter values are dropped. Switching views adds a browser history
entry; filter, sort, selection, and section changes replace the current entry.

It does not use a database, retain token statistics, rename accounts, or expose
request/response content. Account management writes the existing credential
and routing files through the transaction described below. Removal affects
proxy configuration and credentials, not GitHub or Windows account registration.

## Browser State

The page loads every projection once (overview, accounts with M365, models,
behavior, and requests). Live is on by default and kept in memory only. Each
2-second tick fetches the overview plus the active view's projection for
Requests, Behavior, or Accounts. A tick is dropped, not queued, while another
load is running or the tab is hidden.

Connection state is tracked separately from upstream health:

- `connecting` before the first overview success
- `connected` after a successful overview poll
- `reconnecting` after one failed overview poll
- `lost` after two consecutive failures or any network error
- `blocked` when the overview answers `403` or `421`

The rail shows `paused` while Live is off.

Load failures are recorded per scope (overview, accounts, models, behavior,
requests, metadata). A fault clears only when the same scope next succeeds,
and the last-known data stays visible and is marked stale. M365 load and action
errors stay in the M365 panel's own status lines.

One pure `deriveIssues()` function turns faults, connection state, the latest
overview, the sample buffer, and last-known account and M365 data into an
ordered Issues list. Each issue has a `bad`, `warn`, or `info` tone, a
plain-language title, and at most one next action. It exists only while its
condition holds. The same list feeds the Issues button on every view, the
Overview summary sentence, and the Overview Issues panel. `info` issues never
tint the button.

Client-side insights are ephemeral, in-browser derivations, not a history
system. Overview keeps up to 180 overview samples (6 minutes at the Live
interval) for sparklines, throughput, failure rate, and premium use, labelled
`since page open`. Requests insights are computed from the rows currently
shown, and Behavior's `Since open` column subtracts the counters seen at first
load. Nothing is persisted or sent back to the server. A reload or proxy
restart starts them over.

The theme is a three-state `System | Light | Dark` choice. The external classic
script `/dashboard/theme-init.js` runs in `<head>` before the stylesheet and
resolves `data-theme` and `data-theme-pref` before first paint. Light and Dark
store `light` or `dark` under `ghc-proxy-dashboard-theme`. System removes the
key and follows `prefers-color-scheme`. Single-key keyboard shortcuts can be
turned off from the Keyboard shortcuts dialog (stored as
`ghc-proxy-dashboard-shortcuts` = `off`). No shortcut sends a mutation, probe,
or metadata refresh.

Remove and Remove M365 target ask for confirmation in a native modal
`<dialog>`. Cancel has initial focus, Esc cancels, and cancelling sends no
request.

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

The Accounts GET projection processes at most four accounts concurrently, so a
cold or expired cache cannot fan out an unbounded number of quota reads. Its
response preserves the routing snapshot order, and each projection remains in
the selected account's runtime context.

`POST /dashboard/api/refresh` forces metadata refresh in each active account's
runtime context. GitHub refreshes identity, quota, and models; M365 refreshes
models and broker credentials without requesting GitHub identity or quota.
`not_applicable` fields do not make the aggregate refresh fail. Real failures
retain prior safe values and expose `stale` or `unavailable`; the UI identifies
the affected account and metadata source without raw upstream error bodies.
An authorization-denied M365 catalog remains unavailable until access recovers.
Only the explicit **Refresh metadata** action sends this POST. The initial load,
view changes, Live polls, tab visibility changes, and keyboard shortcuts never
force it. The one POST the Dashboard sends without a click is the
once-per-page M365 broker probe described under Scope. The refresh action is
shown as unavailable, with a visible reason, once accounts are known to be in
legacy mode or unavailable.

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
account that owns the current Dashboard hostname redirects the browser to
`/dashboard#/accounts` on the surviving base hostname, keeping the protocol and
listener port. A successful legacy bootstrap redirects the same way. The page
stops Live polling and any device-auth poll before leaving. It redirects only
to `localhost`, a `*.localhost` name, a `127.x.x.x` address, or `::1`. Any
other base hostname leaves the page in place with an Accounts fault asking the
operator to open that hostname manually.

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

The browser UI is a Svelte 5 (runes) single-page app in `ui/`, built with Vite
at package build time. `bun run build:ui` (`scripts/build-ui.ts`, the first
step of `bun run build`) builds it into `ui/dist/` and embeds the four outputs
as string constants in the generated module
`src/routes/dashboard/embedded-ui.generated.ts`:

- the `index.html` shell, served at `/dashboard`
- `/dashboard/assets/app.js`
- `/dashboard/assets/app.css`
- `/dashboard/theme-init.js`

`embedded-ui.ts` imports that module lazily on the first Dashboard page or
asset request, so tsdown emits it as its own `dist/` chunk and the proxy start
path never parses it. The package still performs no runtime asset file reads.
Svelte, Vite, and the UI test tooling are build-only devDependencies; the
published package has no frontend runtime dependency. The UI imports the API
response types from `src/routes/dashboard/contract.ts` with `import type`
only, and `tests/dashboard-contract.test.ts` checks those types against the
server's own types.

In a source checkout where the UI has not been built, the generated module is
missing. `GET /dashboard` then returns a `503` "Dashboard not built" page that
names `bun run build:ui`, and the asset routes return a `503` JSON error. Any
other load failure is a real error. The `/dashboard/api/` routes do not depend
on the bundle.

`scripts/build-ui.ts` fails the build rather than emit output the CSP would
block. It rejects inline scripts, `<style>` elements, and inline style
attributes in the HTML shell. In the compiled JavaScript it rejects `eval`,
`new Function`, template style attributes, and runtime `<style>` elements. It
also enforces gzip size budgets for JavaScript and CSS: exceeding a hard budget
fails the build, and exceeding a soft budget prints a warning.

Dashboard responses use `Cache-Control: no-store`, a strict self-only Content
Security Policy, `nosniff`, `no-referrer`, same-origin resource policy, and
frame denial. On a live server, dashboard routes require the actual peer socket
address to be loopback. The URL hostname must be `localhost`, any
`*.localhost` name, `0.0.0.0`, or an explicit loopback IPv4/IPv6 address;
browser requests with a cross-origin `Origin` header receive 403. The peer
check means a remote client cannot cross the boundary by claiming one of those
Host values.

The CSP is the same strict policy with no `unsafe-inline`, which is why the
theme bootstrap is the external `theme-init.js` script. The UI inserts runtime
values only through Svelte text and attribute interpolation, which never parses
HTML. ESLint enforces this: `svelte/no-at-html-tags` bans `{@html}`,
`svelte/no-inline-styles` bans `style` attributes and `style:` directives, and
`no-restricted-imports` bans `svelte/transition`, `svelte/animate`, and
`svelte/motion` under `ui/`. Meters and sparklines draw their dynamic geometry
as SVG attributes.

The same guard covers all account-management methods. Ordinary legacy startup
completes its one-account routing migration before the Dashboard is available.
A process using a global GitHub-token or GHE-tenant override does not expose
account management and returns `409` rather than persisting ambiguous state.

`/dashboard` requests are excluded from both the request ring and access log so
polling does not displace proxy traffic or create console noise.

## Performance Boundary

The proxy request path performs direct `Map`/record updates, counter increments,
and work proportional to the small model-transform/effect arrays attached to
that request. It does not clone or serialize request bodies for observability.

Dashboard snapshots sort the active set in O(a log a), where `a` is the number
of active observed requests, and copy at most 256 terminal entries. Model
projection, quota fetches, and snapshot sorting occur only on dashboard
requests. Rendering and insight derivation run in the browser, only while a
Dashboard page is open.
