# State and Configuration

This document describes the global state management and configuration system.

## Global State (`src/lib/state.ts`)

The proxy maintains a single `AppState` object:

```typescript
interface AppState {
  auth: AuthState // Authentication tokens
  config: RuntimeConfig // Server runtime settings
  cache: CacheState // Cached upstream data
  rateLimit: RateLimitState // Request throttling state
}
```

### AuthState

```typescript
interface AuthState {
  githubToken?: string // GitHub personal access token
  copilotToken?: string // Copilot API token (derived from GitHub token)
  copilotApiBase?: string // Copilot API base URL
}
```

Tokens are refreshed automatically when they expire.

### RuntimeConfig

```typescript
interface RuntimeConfig {
  accountType: 'individual' | 'business' | 'enterprise'
  manualApprove: boolean // Require manual approval for requests
  rateLimitSeconds?: number // Min seconds between requests
  rateLimitWait: boolean // Queue (true) or error (false) on limit
  showToken: boolean // Display token in logs
  upstreamTimeoutSeconds?: number // Upstream request timeout
}
```

### CacheState

```typescript
interface CacheState {
  models?: ModelsResponse // Cached model list from Copilot
  vsCodeVersion?: string // Cached VS Code version string
}
```

Both are populated at startup and reused for the lifetime of the process.

### RateLimitState

```typescript
interface RateLimitState {
  nextAvailableAt?: number // Unix ms when next request is allowed
}
```

## Configuration File (`~/.ghc-proxy/config.json`)

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

  // Small model routing
  smallModel?: string // Target model for rerouting
  compactUseSmallModel?: boolean // Reroute compact/summarize requests
  warmupUseSmallModel?: boolean // Reroute warmup/probe requests

  // Responses API
  useFunctionApplyPatch?: boolean // Rewrite apply_patch custom tool
  responsesApiContextManagementModels?: string[] // Models with context compaction

  // Reasoning
  modelReasoningEfforts?: Record<string, ReasoningEffort> // Per-model effort defaults
}
```

## CLI Arguments → RuntimeConfig

The `start` command maps CLI flags to RuntimeConfig:

| CLI Flag                | Config Field              | Default        |
|-------------------------|---------------------------|----------------|
| `--port` / `-p`        | (server port)             | `4141`         |
| `--verbose`            | (consola log level)       | `false`        |
| `--account-type`       | `accountType`             | `individual`   |
| `--rate-limit`         | `rateLimitSeconds`        | (none)         |
| `--wait`               | `rateLimitWait`           | `false`        |
| `--manual-approve`     | `manualApprove`           | `false`        |
| `--show-token`         | `showToken`               | `false`        |
| `--upstream-timeout`   | `upstreamTimeoutSeconds`  | (none)         |
| `--proxy-env`          | (http proxy setup)        | `false`        |
| `--claude-code`        | (interactive setup)       | `false`        |

## Environment Variables

Override configuration values:

| Variable                          | Overrides                           |
|-----------------------------------|-------------------------------------|
| `GITHUB_TOKEN`                   | `config.githubToken`               |
| `MODEL_FALLBACK_CLAUDE_OPUS`    | `config.modelFallback.claudeOpus`  |
| `MODEL_FALLBACK_CLAUDE_SONNET`  | `config.modelFallback.claudeSonnet` |
| `MODEL_FALLBACK_CLAUDE_HAIKU`   | `config.modelFallback.claudeHaiku` |

Priority: Environment variable > Config file > Default value.

## Startup Sequence

```text
1. Parse CLI arguments
2. Read config file (~/.ghc-proxy/config.json)
3. Initialize AppState with merged config
4. Authenticate with GitHub (device code flow or provided token)
5. Obtain Copilot API token from GitHub token
6. Cache VS Code version
7. Cache Copilot model list
8. Start Elysia HTTP server (Bun-native adapter or @elysiajs/node fallback)
9. (Optional) Interactive Claude Code setup
```

## Rate Limiting

Two modes controlled by `rateLimitWait`:

**Error mode** (`--wait` not set):
- If a request arrives before `rateLimitSeconds` elapsed since the last request, immediately return 429

**Queue mode** (`--wait` set):
- If a request arrives too early, delay it until the rate limit window passes
- The request is held in-process (not queued externally)

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
    +-- Stored in state.auth.copilotToken
    +-- Refreshed on expiry
    +-- Used for all upstream API calls
```

Token files are stored at:
- `~/.ghc-proxy/github-token` -- GitHub token persistence
- Copilot token is always derived at runtime (not persisted)
