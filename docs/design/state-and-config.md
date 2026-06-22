# State and Configuration

This document describes the global state management and configuration system.

## Global State (`src/state/`)

There is no single `AppState` object. State is decomposed into a set of
singletons under `src/state/`, each re-exported from `~/state`:

```typescript
import {
  authStore, // Authentication tokens + server runtime settings
  configStore, // Feature-flag / config query interface
  modelCache, // Cached model list and VS Code version
  rateLimiter, // Local request throttling
  responsesEmulatorState, // Optional in-memory Responses emulator state
  runtimeStore, // Process-local debug flags
} from '~/state'
```

The client/queue factory (`createCopilotClient`, `getClientConfig`,
`cacheModels`, `cacheVSCodeVersion`, `configureUpstreamRequestQueue`) lives in
`src/clients/factory.ts`.

### AuthStore (`src/state/auth.ts`)

```typescript
class AuthStore {
  githubToken?: string // GitHub personal access token
  copilotToken?: string // Copilot API token (derived from GitHub token)
  copilotApiBase?: string // Copilot API base URL
  gheDomain?: string // GitHub Enterprise domain (optional)
  githubLogin?: string // Cached GitHub username
  accountType: 'individual' | 'business' | 'enterprise' = 'individual'
  manualApprove = false // Require manual approval for requests
  rateLimitSeconds?: number // Min seconds between requests
  rateLimitWait = false // Queue (true) or error (false) on limit
  showToken = false // Display token in logs
  upstreamTimeoutSeconds?: number // Upstream request timeout
}
```

Tokens are refreshed automatically when they expire. The `authStore` singleton
holds both authentication tokens and the server runtime settings derived from
CLI flags.

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
  upstreamQueueMaxRetries?: number // Max retries for upstream 429
  upstreamQueueBaseDelaySeconds?: number // Base retry delay when Retry-After is absent
  upstreamQueueMaxDelaySeconds?: number // Max retry delay
  // ...plus githubToken, claudeCode, proxyEnv, idleTimeoutSeconds, gheDomain, dumpFailedPayloads
}
```

### RuntimeStore (`src/state/runtime.ts`)

```typescript
class RuntimeStore {
  dumpFailedPayloads = false // Enable /responses upstream 400 payload dumps
}
```

Process-local debug flags are not persisted to `config.json` and are read only by the code path that needs them.

### ModelCache (`src/state/model-cache.ts`)

Holds the cached Copilot model list and VS Code version string (plus model
capability lookups). Both are populated at startup and reused for the lifetime
of the process. The cached GitHub username lives on `authStore.githubLogin`.

### RateLimiter (`src/state/rate-limiter.ts`)

Tracks the next allowed request time internally (Unix ms) and exposes
`acquire(intervalSeconds, waitMode)` for the local request guard.

### ConfigStore (`src/state/config-store.ts`)

`ConfigStore` is a typed singleton class that provides a centralized query interface for all feature flags and configuration values derived from the config file. Instead of scattered standalone getter functions (e.g. `shouldUseNativeMessages()`, `shouldUseResponsesApi()`), all config queries go through the `configStore` singleton:

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
configStore.getReasoningEffort(model) // modelReasoningEfforts
configStore.getModelRewrites() // modelRewrites
configStore.getModelFallback() // modelFallback
configStore.getUpstreamQueueConcurrency() // upstreamQueueConcurrency
configStore.getUpstreamQueueMaxRetries() // upstreamQueueMaxRetries
configStore.getUpstreamQueueBaseDelaySeconds() // upstreamQueueBaseDelaySeconds
configStore.getUpstreamQueueMaxDelaySeconds() // upstreamQueueMaxDelaySeconds
```

Each method reads from `getCachedConfig()` and applies the appropriate default value. This consolidates 10+ config access patterns into a single, discoverable interface and eliminates the risk of inconsistent default handling across call sites.

## Configuration File (`~/.local/share/ghc-proxy/config.json`)

Read once at startup via `getCachedConfig()`:

```typescript
interface ConfigFile {
  // Authentication
  githubToken?: string

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
  responsesOfficialEmulator?: boolean // Opt-in local stateful /responses emulator
  responsesOfficialEmulatorTtlSeconds?: number // In-memory TTL for emulator state

  // Reasoning
  modelReasoningEfforts?: Record<string, ReasoningEffort> // Per-model effort defaults

  // Copilot upstream queue
  upstreamQueueConcurrency?: number // Concurrent upstream occupancy (default 10)
  upstreamQueueMaxRetries?: number // Max retries for upstream 429 (default 5)
  upstreamQueueBaseDelaySeconds?: number // Base backoff delay (default 2)
  upstreamQueueMaxDelaySeconds?: number // Max backoff delay (default 60)

  // GitHub Enterprise
  gheDomain?: string // GitHub Enterprise domain
}
```

## CLI Arguments → Runtime Settings

The `start` command maps CLI flags onto `authStore` and the upstream queue:

| CLI Flag                | Config Field              | Default        |
|-------------------------|---------------------------|----------------|
| `--port` / `-p`        | (server port)             | `4141`         |
| `--verbose`            | (consola log level)       | `false`        |
| `--account-type`       | `accountType`             | `individual`   |
| `--rate-limit`         | `rateLimitSeconds`        | (none)         |
| `--wait`               | `rateLimitWait`           | `false`        |
| `--manual-approve`     | `manualApprove`           | `false`        |
| `--show-token`         | `showToken`               | `false`        |
| `--dump-failed-payloads` / `-D` | `runtimeStore.dumpFailedPayloads` | `false` |
| `--upstream-timeout`   | `upstreamTimeoutSeconds`  | (none)         |
| `--upstream-queue-concurrency` | `upstreamQueueConcurrency` | `10`     |
| `--upstream-queue-retries` | `upstreamQueueMaxRetries` | `5`       |
| `--upstream-queue-base-delay` | `upstreamQueueBaseDelaySeconds` | `2` |
| `--upstream-queue-max-delay` | `upstreamQueueMaxDelaySeconds` | `60` |
| `--proxy-env`          | (http proxy setup)        | `false`        |
| `--claude-code`        | (interactive setup)       | `false`        |

## Environment Variables

Override configuration values:

| Variable                          | Overrides                           |
|-----------------------------------|-------------------------------------|
| `GITHUB_TOKEN`                   | `config.githubToken`               |
| `DUMP_FAILED_PAYLOADS`           | `runtimeStore.dumpFailedPayloads`  |
| `MODEL_FALLBACK_CLAUDE_OPUS`    | `config.modelFallback.claudeOpus`  |
| `MODEL_FALLBACK_CLAUDE_SONNET`  | `config.modelFallback.claudeSonnet` |
| `MODEL_FALLBACK_CLAUDE_HAIKU`   | `config.modelFallback.claudeHaiku` |

Priority: CLI argument > Environment variable > Config file > Default value. `DUMP_FAILED_PAYLOADS` is a runtime debug flag only and is not persisted to `config.json`.

## Startup Sequence

```text
1. Parse CLI arguments
2. Read config file (~/.local/share/ghc-proxy/config.json)
3. Initialize state singletons (`authStore`, etc.) with merged config
4. Authenticate with GitHub (device code flow or provided token)
5. Obtain Copilot API token from GitHub token
6. Cache VS Code version
7. Cache Copilot model list
8. Start Elysia HTTP server (Bun-native adapter or @elysiajs/node fallback)
9. (Optional) Interactive Claude Code setup
```

## Responses Official Emulator

The Responses official emulator is disabled by default. When `responsesOfficialEmulator` is `true`, the proxy keeps an in-memory, TTL-bound state store for `/v1/responses` objects and related resources.

- `POST /v1/responses` still uses Copilot upstream create
- the proxy locally persists OpenAI-style state for `previous_response_id` and `conversation`
- `GET /v1/responses/:id`, `GET /v1/responses/:id/input_items`, `DELETE /v1/responses/:id`, and `POST /v1/responses/input_tokens` switch from passthrough to local emulator behavior
- state expires after `responsesOfficialEmulatorTtlSeconds` seconds (default `14400`, or 4 hours)
- `background: true` is explicitly unsupported in emulator mode

### Memory Management

The emulator state is stored across seven internal maps (responses, conversations, conversation heads, input items, and three deletion flag maps). Without bounds, these can grow unboundedly -- a single `setResponse()` call may write up to 3 entries (response, conversation, conversation head), and deletion methods add deletion flag entries.

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

This local request guard is separate from the Copilot upstream queue. The upstream queue is always active for Copilot API calls and handles upstream HTTP 429 with global back-pressure and retry. See [Upstream Request Queue](upstream-request-queue.md).

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
- The GitHub token is persisted in `~/.local/share/ghc-proxy/config.json` (the `githubToken` field, written via `writeConfigField`)
- The Copilot token is always derived at runtime (not persisted)
