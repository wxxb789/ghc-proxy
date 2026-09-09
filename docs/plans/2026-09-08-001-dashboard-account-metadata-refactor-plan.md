---
title: Dashboard Account Metadata Refactor - Plan
type: refactor
date: 2026-09-08
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Dashboard Account Metadata Refactor - Plan

## Goal Capsule

- **Objective:** Operators can inspect every routed account, manually refresh the remote metadata displayed by Dashboard, and understand which account is current and default without misleading cross-account data or runtime errors.
- **Means:** Separate account-domain snapshots from Dashboard projections, add an explicit protected metadata refresh operation, and preserve request-hostname account context. (KTD1-KTD4)
- **Authority:** The Dashboard compatibility and security contract in `AGENTS.md` and `docs/design/dashboard-observability.md` governs this plan. The user approved the architecture after an independent Astra review.
- **Execution profile:** Use local fixtures and mocked upstream clients. Do not call `bun run matrix:live` or perform quota-burning Copilot probes.
- **Stop condition:** Stop if a proposed change would require credentials persistence, account routing mutation, cross-account model aggregation, or a public API compatibility break not covered by this plan.
- **Tail ownership:** This plan authorizes local implementation and verification only. It does not authorize a commit, push, PR, release, or live Copilot validation.

## Product Contract

### Summary

Refactor Dashboard account data ownership so account enumeration cannot call a Dashboard projector through an `Array.map` callback. Add a manual, protected remote metadata refresh for all active routed accounts. Extend Overview Authentication with the active account, default account, and routed-account count.

### Problem Frame

`AccountManager.listAccounts()` currently passes a two-argument Dashboard projection function directly to `Array.map`. The array index is treated as `DashboardQuotaCache`, so Dashboard Accounts returns HTTP 500 when quota data is requested. Current Refresh only rereads local cache state, so it cannot update remote account identity, quota, or model metadata.

### Requirements

#### Account Boundaries

- R1. Accounts inspection must return a safe projection for every active routed account without passing an array index or other callback metadata as a dependency.
- R2. Account-domain code must not import Dashboard route or handler modules to enumerate its account state.
- R3. Every Dashboard read and refresh operation must preserve per-request hostname account isolation; it must not merge or relabel another account's state as the current account.
- R4. The routed account count must include only active runtimes, not stored but inactive credentials.

#### Manual Metadata Refresh

- R5. A manual Dashboard Refresh must update remote identity, quota, and model metadata for every active routed account, with each operation executed in that account's runtime context.
- R6. Initial page load, tab changes, and Live refresh must remain read-only local snapshot operations and must not trigger remote metadata fetches.
- R7. A failed refresh for one account or metadata source must not cancel successful refreshes for other accounts, erase previous safe values, leak raw upstream errors, or expose credentials.
- R8. Manual Dashboard Refresh must not write credentials, change named-account routing, re-run device authentication, or create/replace token-refresh schedules.

#### Dashboard Contract

- R9. Overview Authentication must show the current account context, total active routed accounts, and the configured default account while preserving the existing GitHub and Copilot status rows.
- R10. Models must continue to show the model catalog for the request-selected account, even though manual Refresh updates all active accounts.
- R11. Existing Dashboard GET route payload fields and protected loopback/origin access behavior must remain compatible. New fields and the new protected POST endpoint are additive.

### Acceptance Examples

- AE1. A two-account process can load `/dashboard/api/accounts` with quota-enabled account fixtures and returns both safe account rows rather than `quotaCache.get is not a function`. Covers R1-R3.
- AE2. A manual Refresh updates one account's GitHub identity, quota, and model cache while another account's model fetch fails; the response reports partial completion and preserves that account's existing safe catalog. Covers R5-R8.
- AE3. Loading `/dashboard` and enabling Live refresh issue only GET requests. Clicking Refresh issues one protected POST before rereading the views. Covers R5-R6.
- AE4. On `work.localhost`, Overview identifies `work` as current, separately names `personal` as default, reports the active routed count, and Models remains work's catalog. Covers R3-R4 and R9-R10.

### Scope Boundaries

This work does not redesign Dashboard visuals, add a database, add account deletion, alter credential formats, add automatic full-account polling, or change normal proxy request behavior. It does not promise that upstream token status can be forcibly refreshed without using the established token lifecycle.

## Planning Contract

### Key Technical Decisions

- KTD1. Move the internal routed-account descriptor to `src/accounts/` and have `AccountManager` return a domain snapshot rather than Dashboard-projected rows. Dashboard owns the safe projection and binds its dependencies through explicit closures. (session-settled: user-approved — chosen over a one-line callback wrapper: removes the reverse dependency that created the bug.) Governs R1-R2.
- KTD2. Add a Dashboard-owned metadata coordinator that consumes the manager snapshot, runs each remote operation inside `runWithAccountRuntime`, and returns a safe per-account result. Do not add a generic event bus, repository, or shared global refresh framework. (session-settled: user-approved — chosen over direct UI GET reloads: Refresh must obtain fresh remote metadata.) Governs R3 and R5-R8.
- KTD3. Extend `DashboardQuotaCache` with a force-refresh operation that bypasses TTL while retaining a last safe projection on errors. Do not clear cache before fetching because that discards usable stale information. (session-settled: user-approved — chosen over `reset()`: failed refresh must preserve operator visibility.) Governs R5 and R7.
- KTD4. Split browser local-view loads from manual upstream refresh. The button invokes POST then rereads views; startup and Live retain GET-only behavior. (session-settled: user-approved — chosen over adding POST to `refreshAll()`: opening Dashboard must not refresh every account.) Governs R5-R6.
- KTD5. Carry `currentAccount`, `defaultAccount`, and `totalAccounts` as a Dashboard account summary. `currentAccount` is request-context data; it must not be inferred from the configured default. Governs R3-R4 and R9-R10.

### High-Level Technical Design

```text
Browser initial/live GET --> Dashboard read routes --> current request runtime only

Browser Refresh POST --> Dashboard metadata coordinator
                       --> AccountManager account snapshot
                       --> for each active runtime:
                           runWithAccountRuntime(runtime)
                           -> refresh safe GitHub identity
                           -> force Dashboard quota refresh
                           -> cacheModels()
                       --> safe per-account result
                       --> Browser rereads GET views
```

`AccountManager` remains the authority for active runtimes and routing configuration. Dashboard remains the authority for safe projections, quota cache use, HTTP access protection, and browser behavior. The metadata coordinator is intentionally narrow: it orchestrates existing account-scoped sources and returns only allowlisted result states.

### Risks and Dependencies

- Remote `/models`, identity, and quota calls can fail independently. The coordinator must use `Promise.allSettled` per account and per source, then preserve existing safe data.
- `cacheModels()` replaces the selected runtime's cache only after a successful response. This existing behavior is the required retention mechanism for a failed model refresh.
- Existing `refreshCopilotToken()` absorbs failures for its timer lifecycle. Do not use it as the metadata coordinator's success signal unless its error contract is separately refactored and tested. Model refresh failures are independently observable.
- The new POST is a management operation and must stay behind the existing Dashboard access guard, with no body required and no raw upstream error content returned.

## Implementation Units

### U1. Separate Account Snapshot From Dashboard Projection

**Goal:** Make `AccountManager` expose active routed descriptors without importing or invoking Dashboard code.
**Requirements:** R1-R4, R11.
**Dependencies:** None.
**Files:** `src/accounts/manager.ts`, new or relocated account descriptor module under `src/accounts/`, `src/routes/dashboard/handler.ts`, `src/routes/dashboard/route.ts`, `tests/account-manager.test.ts`, `tests/dashboard-introspection.test.ts`.
**Approach:** Replace `listAccounts()`'s projected return with an account-domain snapshot method. Keep hostname/default selection and runtime ownership in `AccountManager`. Move the descriptor type out of the Dashboard handler. Add Dashboard-local projection functions which receive both descriptor and quota cache through ordinary calls or closures, never as an Array callback reference.

**Test scenarios:**

1. A real two-runtime `AccountManager` snapshot returns names, dedicated hostnames, default flag, and runtime identity without performing a Dashboard projection.
2. Dashboard projects both accounts with GitHub tokens and a controlled quota cache without an index becoming a cache argument.
3. Snapshot count excludes known credentials that do not have an active runtime.
4. Legacy routing-disabled account snapshot and existing unavailable-management behavior remain valid.

**Verification:** The current `/dashboard/api/accounts` reproduction changes from HTTP 500 to a complete safe JSON response under local fixtures.

### U2. Add Account-Scoped Metadata Refresh Coordination

**Goal:** Refresh remote Dashboard metadata for every active routed account without changing authentication or routing lifecycle behavior.
**Requirements:** R3, R5-R8, R11.
**Dependencies:** U1.
**Files:** new `src/routes/dashboard/metadata-refresh.ts` or nearest existing Dashboard module, `src/routes/dashboard/handler.ts`, `src/routes/dashboard/route.ts`, `src/routes/dashboard/assets.ts`, `src/clients/factory.ts` only if a narrow existing export is required, `src/lib/token.ts` only if safe identity refresh extraction needs it, `tests/dashboard-route.test.ts`, `tests/dashboard-introspection.test.ts`, `tests/dashboard-assets.test.ts`.
**Approach:** Add `POST /dashboard/api/refresh`. The route obtains the active account snapshot, invokes the Dashboard coordinator, and returns an allowlisted summary per account and metadata kind. In each account runtime, refresh GitHub identity through a non-persisting read operation, force quota refresh, and call `cacheModels()`. Apply independent failure containment and safe status projection. Do not call device-auth setup, write config, or alter token timers.

**Test scenarios:**

1. The POST is accepted from loopback same-origin requests and rejected by the existing remote/origin guards.
2. Two accounts run their identity, quota, and model operations under their own runtime context.
3. One model request failing does not prevent another account's identity and quota refresh or erase the failed account's prior catalog.
4. Result JSON omits tokens, raw upstream error text, analytics identifiers, organizations, and quota IDs.
5. Legacy or globally overridden account-management mode returns the current management-unavailable contract.

**Verification:** Controlled mock upstream calls prove each active account is refreshed once per button operation and all unsafe fields remain absent.

### U3. Add Force-Refresh Semantics To Dashboard Quota Cache

**Goal:** Give manual refresh a fresh quota fetch while preserving cached safe values after a failure.
**Requirements:** R5, R7, R11.
**Dependencies:** U1.
**Files:** `src/routes/dashboard/handler.ts`, `tests/dashboard-introspection.test.ts`.
**Approach:** Add a typed force-refresh method or options argument to `DashboardQuotaCache`. It bypasses a non-expired cache entry, coalesces same-account in-flight requests, updates the safe cache on success, and turns an existing safe result into `stale` on failure. Normal GET overview and account projection retain TTL behavior.

**Test scenarios:**

1. A normal `get()` keeps a fresh cached result within 60 seconds.
2. A manual force refresh calls the loader before TTL expiry.
3. A failed force refresh returns the previous safe projection as `stale`, not `unavailable` and not an empty cache.
4. Concurrent force refreshes for one account coalesce; separate account contexts remain isolated.

**Verification:** Existing quota cache tests continue to prove timeout recovery and no sensitive field exposure.

### U4. Clarify Overview and Browser Refresh Semantics

**Goal:** Present account context accurately and make button-triggered upstream refresh distinct from view loads.
**Requirements:** R3-R6, R9-R11.
**Dependencies:** U1-U3.
**Files:** `src/routes/dashboard/handler.ts`, `src/routes/dashboard/route.ts`, `src/routes/dashboard/assets.ts`, `tests/dashboard-route.test.ts`, `tests/dashboard-assets.test.ts`, `tests/dashboard-introspection.test.ts`.
**Approach:** Include the account summary in Overview. Retain current GitHub/Copilot rows and add a clearly labeled account-context row or equivalent compact display. Models remains request-account scoped. Split `refreshAll()` into GET-only view loading and a manual button flow that POSTs then reloads. Preserve queued refresh behavior so concurrent clicks do not overlap remote refreshes or cause Live to perform POST.

**Test scenarios:**

1. Overview at a named hostname reports the named runtime as current and a different configured account as default.
2. Overview reports the correct active runtime count after a default switch.
3. Initial page setup and Live timer issue no POST.
4. Manual button flow performs POST once, then reloads every view and surfaces a partial refresh warning without overwriting it with a successful GET.
5. Models view continues to render only the current runtime's catalog after a full-account manual refresh.

**Verification:** Asset tests execute the generated browser script with mocked fetches and verify request ordering, state updates, and Authentication text.

### U5. Update Design Documentation and Run Focused Review

**Goal:** Make Dashboard design documentation describe the new ownership and refresh contract.
**Requirements:** R5-R11.
**Dependencies:** U1-U4.
**Files:** `docs/design/dashboard-observability.md`, task-owned test files, task-owned implementation files.
**Approach:** Document that active-account descriptors come from account management, Dashboard projects them, manual POST refreshes remote metadata per account, GET polling remains cache-only, and Overview distinguishes current/default account context. Do not add broad architecture documentation unrelated to Dashboard.

**Test scenarios:**

1. Documentation paths and endpoint descriptions match route registration and access protections.
2. A source search finds no remaining `AccountManager` import of Dashboard handler types or projectors.

**Verification:** Run the focused Dashboard and account tests, then the repository validation gate available in the environment.

## Verification Contract

Run focused tests during implementation: `bun test tests/account-manager.test.ts tests/dashboard-route.test.ts tests/dashboard-assets.test.ts tests/dashboard-introspection.test.ts`.

Before any separately authorized commit or PR, run the repository full gate from `AGENTS.md`: `bun run lint:all`, `bun run typecheck`, the prescribed split Bun test suite, `bun run build`, and `bun run smoke:packaged`. Run the formatter once before a commit only.

The implementation must also reproduce the original local endpoint with a safe HTTP 200 response after the active server is restarted by its owner. Do not restart or modify the user's running service during source verification.

## Definition of Done

- U1: Accounts no longer depends on a Dashboard projector in `AccountManager`, and the original `quotaCache.get` failure has a regression test.
- U2-U3: Manual POST refresh updates safe metadata per active account with isolated partial failure and no lifecycle or secret regression.
- U4: Refresh button, Live behavior, Overview Authentication, and Models account context are unambiguous and tested.
- U5: The design document matches implementation and all task-owned tests pass.
- No abandoned debug code, temporary fixtures, unsafe logs, credential writes, or unrelated formatting changes remain.

## Sources

- `src/accounts/manager.ts`: active runtime ownership and the incorrect `Array.map` callback handoff.
- `src/routes/dashboard/handler.ts`: account projection, quota cache, and Overview payload.
- `src/routes/dashboard/route.ts`: existing Dashboard access guard and management API surface.
- `src/routes/dashboard/assets.ts`: initial load, Live refresh, manual Refresh, Accounts, Models, and Authentication rendering.
- `src/state/account-runtime.ts`, `src/clients/factory.ts`, and `src/lib/token.ts`: account-scoped runtime execution, model cache refresh, and authentication lifecycle constraints.
- `docs/design/dashboard-observability.md`: Dashboard security, safe projection, quota, and account-management contract.
