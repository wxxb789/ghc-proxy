# State and Configuration

This document describes process-wide configuration and request-selected account
state.

## Global State (`src/state/`)

There is no single `AppState` object. Process-wide state is decomposed under
`src/state/`; account-scoped exports are contextual facades that select the
runtime bound to the current request:

```typescript
import {
  authStore, // Authentication/token lifecycle + request guard settings
  configStore, // Feature-flag / config query interface
  modelCache, // Cached model list and VS Code version
  rateLimiter, // Local request throttling
  responsesEmulatorState, // Optional in-memory Responses emulator state
  runtimeStore, // Process-local debug flags + observability state
} from '~/state'
```

`src/state/account-runtime.ts` owns the `AsyncLocalStorage` request context,
the configured account registry, and one `AuthStore`, `ModelCache`,
`RateLimiter`, and Responses emulator state instance per account. Without
`accountRouting`, the facades resolve to the original legacy singleton and
preserve single-account behavior. With routing enabled, `src/server.ts` binds a
request to exactly one account before CORS or route handling; an unknown
hostname returns `421` before any upstream work.

The client/queue factory (`createCopilotClient`, `getClientConfig`,
`cacheModels`, `cacheVSCodeVersion`, `configureUpstreamRequestQueue`) lives in
`src/clients/factory.ts`. It creates one upstream queue per account runtime so
account and model cooldowns cannot cross account boundaries.

### AuthStore (`src/state/auth.ts`)

```typescript
class AuthStore {
  githubToken?: string // GitHub personal access token
  copilotToken?: string // Copilot API token (derived from GitHub token)
  copilotApiBase?: string // Copilot API base URL
  gheDomain?: string // GitHub Enterprise domain (optional)
  githubLogin?: string // Cached GitHub username
  githubValidatedAt?: number // Last successful GitHub validation (Unix ms)
  copilotTokenExpiresAt?: number // Copilot token expiry (Unix ms)
  copilotTokenLastRefreshAt?: number // Last refresh attempt (Unix ms)
  copilotTokenLastRefreshSucceeded?: boolean
  accountType: 'individual' | 'business' | 'enterprise' = 'individual'
  manualApprove = false // Require manual approval for requests
  rateLimitSeconds?: number // Min seconds between requests
  rateLimitWait = false // Queue (true) or error (false) on limit
  showToken = false // Display token in logs
  upstreamTimeoutSeconds?: number // Upstream request timeout
}
```

Tokens are refreshed automatically when they expire. In hostname-routing mode,
each account has its own refresh schedule and `AuthStore`; the exported
`authStore` facade resolves to the account already selected for the request.

### RunServerOptions (`src/start.ts`)

The `start` command parses its CLI flags into this options object, then applies
them onto `authStore` and the upstream queue:

```typescript
interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string // Normalized to individual | business | enterprise
  manual: boolean // Require manual approval for requests
  rateLimit?: number // Min seconds between requests
  rateLimitWait: boolean // Queue (true) or error (false) on limit
  showToken: boolean // Display token in logs
  upstreamTimeoutSeconds?: number // Upstream request timeout
  upstreamQueueConcurrency?: number // Concurrent Copilot upstream occupancy
  upstreamQueueMaxRetries?: number // Shared retry count (0..2, default 1)
  upstreamRecoveryBudgetSeconds?: number // Recovery deadline (1..120, default 60)
  upstreamQueueBaseDelaySeconds?: number // Base retry delay when Retry-After is absent
  upstreamQueueMaxDelaySeconds?: number // Computed backoff cap; not Retry-After
  // ...plus githubToken, claudeCode, proxyEnv, idleTimeoutSeconds, gheDomain, dumpFailedPayloads
}
```

### RuntimeStore (`src/state/runtime.ts`)

```typescript
class RuntimeStore {
  dumpFailedPayloads = false // Enable /responses upstream 400 payload dumps
  readonly startedAt: string // Process-local ISO timestamp
  readonly requests: RequestActivityStore // Dashboard lifecycle projection

  recordStreamError(requestId: string, error: unknown): void
}
```

`RuntimeStore` is not persisted to `config.json`. It owns the process start time,
the request-activity projection used by the dashboard (with a fixed completed
history), and the `dumpFailedPayloads` debug flag. `recordStreamError()`
sanitizes a stream failure before storing it; raw errors are not retained.

### ModelCache (`src/state/model-cache.ts`)

Holds the cached Copilot model list and VS Code version string (plus model
capability lookups). Both are populated at startup and reused for the lifetime
of the process. The cached GitHub username lives on `authStore.githubLogin`.

### RateLimiter (`src/state/rate-limiter.ts`)

Tracks the next allowed request time internally (Unix ms) and exposes
`acquire(intervalSeconds, waitMode)` for the local request guard.

### ConfigStore (`src/state/config-store.ts`)

`ConfigStore` is a typed singleton class that centralizes route-facing feature
and model-policy queries derived from the config file. Authentication reads the
separate credential store, while GHE selection and upstream queue startup still
read `getCachedConfig()` directly. Instead of
adding scattered standalone feature getters, route code uses the
`configStore` singleton:

```typescript
import { configStore } from '~/state'

configStore.isEmulatorEnabled() // responsesOfficialEmulator
configStore.getEmulatorTtlSeconds() // responsesOfficialEmulatorTtlSeconds
configStore.isCompactSmallModelEnabled() // compactUseSmallModel
configStore.getSmallModel() // smallModel
configStore.isFunctionApplyPatchEnabled() // useFunctionApplyPatch
configStore.isAutoCompactResponsesInputEnabled() // responsesApiAutoCompactInput
configStore.isContextManagementEnabled() // responsesApiAutoContextManagement
configStore.isContextManagementModel(model) // responsesApiContextManagementModels
configStore.getContextManagementModels()
configStore.getReasoningEffort(model) // modelReasoningEfforts
configStore.getResponsesParameterFilters() // responsesApiParameterFilters
configStore.shouldReplaceDefaultParameterFilters()
configStore.getModelRewrites() // modelRewrites
configStore.getChatCompletionsMaxCompletionTokensModels()
configStore.getModelFallback() // modelFallback
configStore.getOverloadFallback(sourceModel) // exact overloadFallbacks entry
configStore.getOverloadFallbacks() // defensive copy of all mappings
configStore.hasOverloadFallbacks()
```

Feature/model queries read from `getCachedConfig()` and apply their local defaults. Queue startup values deliberately do not have `ConfigStore` getters: `src/start.ts` merges CLI values with `getCachedConfig()` once and passes milliseconds/counts directly to `configureUpstreamRequestQueue()` in `src/clients/factory.ts`.

## Configuration File (`~/.local/share/ghc-proxy/config.json`)

Read once at startup via `getCachedConfig()`:

```typescript
interface ConfigFile {
  // Model fallbacks
  modelFallback?: {
    claudeOpus?: string // Fallback for claude-opus-* models
    claudeSonnet?: string // Fallback for claude-sonnet-* models
    claudeHaiku?: string // Fallback for claude-haiku-* models
  }

  // Model rewrites
  modelRewrites?: Array<{ from: string, to: string }> // Glob-based model ID rewriting rules

  // Small model routing
  smallModel?: string // Target model for rerouting
  compactUseSmallModel?: boolean // Reroute compact/summarize requests

  // Responses API
  useFunctionApplyPatch?: boolean // Rewrite apply_patch custom tool
  responsesApiAutoCompactInput?: boolean // Auto-trim input to the latest compaction item
  responsesApiAutoContextManagement?: boolean // Auto-inject context_management for selected models
  responsesApiContextManagementModels?: string[] // Models eligible for auto-injected context management
  responsesApiParameterFilters?: Array<{
    models: string[] // Non-empty model glob list
    params: string[] // Non-empty parameter list
  }>
  responsesApiParameterFiltersReplaceDefault?: boolean // Replace, rather than extend, built-in filters
  responsesOfficialEmulator?: boolean // Opt-in local stateful /responses emulator
  responsesOfficialEmulatorTtlSeconds?: number // In-memory TTL for emulator state

  // Chat Completions
  chatCompletionsUseMaxCompletionTokens?: string[] // Extra model globs that need max_completion_tokens instead of max_tokens

  // Reasoning
  modelReasoningEfforts?: Record<string, ReasoningEffort> // Per-model effort defaults

  // Copilot upstream queue
  upstreamQueueConcurrency?: number // Concurrent upstream occupancy (default 10)
  upstreamQueueMaxRetries?: number // Shared retry count, 0..2 (default 1)
  upstreamRecoveryBudgetSeconds?: number // Recovery deadline, 1..120 seconds (default 60)
  upstreamQueueBaseDelaySeconds?: number // Base backoff delay (default 2)
  upstreamQueueMaxDelaySeconds?: number // Computed backoff cap only (default 60)
  overloadFallbacks?: Record<string, string> // Exact one-hop source -> target mappings; absent disables fallback

  // GitHub Enterprise
  gheDomain?: string // GitHub Enterprise domain

  // Optional multi-account routing
  accountRouting?: {
    baseHostname: string
    defaultAccount: string
    hostnames: Record<string, string>
  }
}
```

`accountRouting` is an opt-in fail-closed boundary. `baseHostname` always maps
to `defaultAccount`; every entry in `hostnames` maps one additional DNS hostname
to one named credential. Hostnames are converted to ASCII, lower-cased, and
compared without a trailing root dot; ports are not part of the key. IP
addresses, authorities containing ports, duplicate normalized names, missing
accounts, and incomplete routing objects fail validation. Untrusted
`Forwarded` and `X-Forwarded-Host` values do not participate in selection.
Account names are case-sensitive, contain 1-64 ASCII letters, numbers, dots,
underscores, or hyphens, and must begin with an alphanumeric character.

The request-lifetime binding uses Elysia's higher-order `wrap()` hook because it
covers both the general fetch path and Bun's compiled per-route system router.
That hook is an internal Elysia API, so the packaged `account-hostname-routing`
selfcheck is a required compatibility gate under both Bun and Node.

`githubToken` is intentionally absent. `readConfig()` removes that legacy key
from its in-memory result even while an interrupted migration keeps the original
file available for recovery.

## Credential File (`~/.local/share/ghc-proxy/credentials.json`)

Long-lived GitHub credentials have a separate versioned contract:

```typescript
interface CredentialStoreFile {
  version: 1
  activeAccount: string
  accounts: Record<string, {
    githubToken: string // Canonical Base64
    gheDomain?: string // Tenant bound to this credential
  }>
}
```

Legacy single-account mode reads and writes `activeAccount`, initially
`default`. `auth --account <name>` creates or replaces a sibling without
changing `activeAccount`; hostname-routing mode reads every account referenced
by `accountRouting` and ignores `activeAccount` for request selection. Base64
only reduces accidental disclosure when a configuration file is inspected or
pasted; it does not resist deliberate file access or decoding. On non-Windows
platforms, credential and migration files are written with mode `0600`; Windows
uses its native file ACL behavior.

Legacy migration uses
`~/.local/share/ghc-proxy/config.json.github-token-migration.bak` as the commit
record and recovery copy. The sequence is backup the complete config, atomically
stage the credential file, validate GitHub identity, acquire a Copilot token,
atomically remove the legacy config field, and delete the backup last. Any
failure leaves the backup in place and reports its path. A restart resumes the
same pending migration without starting device login or duplicating accounts.
Forced re-authentication first tries that normal completion path. When the
legacy credential is explicitly rejected with `401` or `403`, the replacement
credential must pass both GitHub identity and Copilot token validation before
it replaces the staged credential and the legacy backup is removed. Transient
validation failures remain fail-closed. Replacement commit progress is recorded
in a versioned
`config.json.github-token-migration.bak.replacement.json` transaction journal.
The journal stores only SHA-256 token digests, never either raw token, and is
deleted last. A restart can therefore distinguish an intentional validated
replacement from unrelated credential drift, bind validation to the replacement
tenant, persist that tenant back to `config.json`, and finish cleanup
idempotently without starting another device flow.

An explicit `--ghe-domain` remains the requested runtime tenant during this
recovery. The pending replacement is validated and committed against its stored
tenant first; when the explicit tenant differs, authentication then continues
against the requested tenant. If that second login fails, the recovered
credential remains committed instead of rolling back to the legacy token.
Replacement also accepts the legitimate split state where `config.json` was
already cleaned but the backup had not yet been deleted, provided the backup and
active stored legacy credential still match.

Process-wide `start --github-token` and `start --ghe-domain` overrides are
rejected when `accountRouting` is enabled because neither flag identifies one
named account. A pending legacy credential migration is completed through the
existing transactional path before routed account initialization begins.

## CLI Arguments → Runtime Settings

The `start` command maps CLI flags onto `authStore` and the upstream queue:

| CLI Flag                | Config Field              | Default        |
|-------------------------|---------------------------|----------------|
| `--port` / `-p`        | (server port)             | `4141` (`1..65535`) |
| `--verbose`            | (consola log level)       | `false`        |
| `--account-type`       | `accountType`             | `individual`   |
| `--rate-limit`         | `rateLimitSeconds`        | (none)         |
| `--wait`               | `rateLimitWait`           | `false`        |
| `--manual`            | `manualApprove`           | `false`        |
| `--show-token`         | `showToken`               | `false`        |
| `--dump-failed-payloads` / `-D` | `runtimeStore.dumpFailedPayloads` | `false` |
| `--idle-timeout`       | (server adapter option)   | `120`          |
| `--upstream-timeout`   | `upstreamTimeoutSeconds`  | `1800`; `0` disables |
| `--upstream-queue-concurrency` | `upstreamQueueConcurrency` | `10`     |
| `--upstream-queue-retries` | `upstreamQueueMaxRetries` | `1` (`0..2`) |
| `--upstream-recovery-budget` | `upstreamRecoveryBudgetSeconds` | `60` (`1..120`) |
| `--upstream-queue-base-delay` | `upstreamQueueBaseDelaySeconds` | `2` |
| `--upstream-queue-max-delay` | `upstreamQueueMaxDelaySeconds` | `60` (computed backoff only) |
| `--proxy-env`          | (http proxy setup)        | `false`        |
| `--claude-code`        | (interactive setup)       | `false`        |
| `--github-token` / `-g` | `authStore.githubToken`  | credential store/device flow |
| `--ghe-domain` / `--ghe` | `authStore.gheDomain`   | persisted config |

## Environment Variables

Override configuration values (read directly from `process.env` by the proxy):

| Variable                          | Overrides                           |
|-----------------------------------|-------------------------------------|
| `DUMP_FAILED_PAYLOADS`           | `runtimeStore.dumpFailedPayloads`  |
| `MODEL_FALLBACK_CLAUDE_OPUS`    | `config.modelFallback.claudeOpus`  |
| `MODEL_FALLBACK_CLAUDE_SONNET`  | `config.modelFallback.claudeSonnet` |
| `MODEL_FALLBACK_CLAUDE_HAIKU`   | `config.modelFallback.claudeHaiku` |

These are the only environment variables the proxy binary reads at runtime for
configuration (`MODEL_FALLBACK_*` in `src/lib/model-resolver.ts`,
`DUMP_FAILED_PAYLOADS` in `src/start.ts`). There is **no** `GITHUB_TOKEN` /
`GH_TOKEN` environment override in application code — supply a GitHub token via
the `--github-token` (`-g`) flag or the persisted credential store.
The Docker image is the exception: its [`entrypoint.sh`](../../entrypoint.sh)
forwards a non-empty `GH_TOKEN` to `start --github-token`, so `GH_TOKEN` works
only inside the container, not for the bare binary.

Priority for queue settings is CLI argument > config file > queue default; there are no queue environment variables. `DUMP_FAILED_PAYLOADS` is a runtime debug flag only and is not persisted to `config.json`.

`--upstream-queue-concurrency` accepts only an integer greater than zero. An
invalid CLI value logs a warning and is treated as absent, so a valid
`config.json` value can still win before the queue default of 10. The config
schema applies the same positive-integer rule and drops an invalid field while
retaining other individually valid fields.

## Startup Sequence

```text
1. Parse CLI arguments
2. Initialize proxy/logging options and apply CLI-derived `authStore` and
   `runtimeStore` settings
3. Ensure data paths exist, then read
   `~/.local/share/ghc-proxy/config.json`
4. Merge queue CLI/config values and call
   `configureUpstreamRequestQueue()` directly
5. Apply persisted GHE domain, with the CLI value taking precedence
6. Cache the VS Code version
7. When `--github-token` is present, keep it process-only. If a legacy
   `config.json` credential migration is pending, independently validate that
   stored candidate against its original GitHub tenant, acquire a Copilot token,
   and finalize the migration before using the runtime override. The override is
   never written to the credential store. If legacy validation fails, retain the
   recovery files, report the migration error, and continue with the explicit
   runtime override. Otherwise, stage or resume any legacy migration and resolve
   the GitHub token from the credential store or device flow
8. For the persisted path, validate the GitHub identity, obtain and schedule
   refresh for the Copilot token, then finalize a pending migration by removing
   the legacy field and deleting its backup
9. Create the Copilot client and cache the upstream model list
10. Optionally prompt for Claude Code model choices and print its launch command
11. Print the startup banner, create the Elysia app, and call `listen()` using
    the Bun-native adapter or `@elysiajs/node` fallback
12. Register `SIGTERM`/`SIGINT` cleanup for token refresh and the HTTP server
```

## Responses Official Emulator

The Responses official emulator is disabled by default. When `responsesOfficialEmulator` is `true`, the proxy keeps an in-memory, TTL-bound state store for `/v1/responses` objects and related resources.

- `POST /v1/responses` still uses Copilot upstream create
- the proxy locally persists OpenAI-style state for `previous_response_id` and `conversation`
- `GET /v1/responses/:id`, `GET /v1/responses/:id/input_items`, `DELETE /v1/responses/:id`, and `POST /v1/responses/input_tokens` switch from passthrough to local emulator behavior
- state expires after `responsesOfficialEmulatorTtlSeconds` seconds (default `14400`, or 4 hours)
- `background: true` is explicitly unsupported in emulator mode

### Memory Management

The emulator state is stored across six internal maps (responses, conversations, conversation heads, input items, and two deletion flag maps -- responses and input items). Without bounds, these can grow unboundedly -- a single `setResponse()` call may write up to 3 entries (response, conversation, conversation head), and deletion methods add deletion flag entries.

To prevent unbounded growth, the emulator enforces a hard cap of 10,000 total entries (`DEFAULT_MAX_TOTAL_ENTRIES`, overridable via `maxTotalEntries` option) across all maps. Memory is managed at two layers:

**Write-time enforcement (`enforceCapOnWrite`):** Called automatically by `writeMap()` and `putDeletionFlag()` before inserting a new key. When the total entry count reaches the cap:
1. Expired entries are pruned first
2. If still at or over the cap, the oldest entry (by expiration time) is evicted from the largest map in a loop until space is available

**Background sweep:** A `setInterval` timer runs `pruneExpired()` every 60 seconds to remove entries that have passed their TTL. The timer is not started at import/construction time — it is armed lazily on the first write (`writeMap()` or `putDeletionFlag()`), stopped on `clear()`, and re-armed on the next write. It is `unref()`'d so it does not prevent process exit.

## Rate Limiting

Two modes controlled by `rateLimitWait`:

**Error mode** (`--wait` not set):
- If a request arrives before `rateLimitSeconds` elapsed since the last request, immediately return 429

**Queue mode** (`--wait` set):
- If a request arrives too early, delay it until the rate limit window passes
- The request is held in-process (not queued externally)

This local request guard is separate from the Copilot upstream queue. The upstream queue is always active: `429` creates account back-pressure, model-aware `529` creates model-scoped back-pressure, and model-less `529` stays request-only. See [Upstream Request Queue](upstream-request-queue.md).

## Token Lifecycle

```text
GitHub Token (long-lived)
    |
    v
[GitHubClient.getCopilotToken()]
    |
    v
Copilot Token (short-lived, auto-refreshed)
    |
    +-- Stored in authStore.copilotToken
    +-- Refreshed on expiry
    +-- Used for all upstream API calls
```

Token persistence:
- The GitHub token is Base64-obfuscated in the active named account in `~/.local/share/ghc-proxy/credentials.json`
- After migration completes, `config.json` contains non-secret settings only; a legacy raw token remains there solely while a migration backup is pending or recovery is required
- The Copilot token is always derived at runtime (not persisted)
