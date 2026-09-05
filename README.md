# ghc-proxy

[![npm](https://img.shields.io/npm/v/ghc-proxy)](https://www.npmjs.com/package/ghc-proxy)
[![CI](https://github.com/wxxb789/ghc-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/wxxb789/ghc-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/wxxb789/ghc-proxy/blob/main/LICENSE)

A proxy that turns your GitHub Copilot subscription into an OpenAI and Anthropic compatible API. Use it to power [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), [Cursor](https://www.cursor.com/), or any tool that speaks the OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages protocol.

> [!WARNING]
> Reverse-engineered, unofficial, may break at any time. Excessive use can trigger GitHub abuse detection. **Use at your own risk.**

**TL;DR** — Choose either supported runtime:

```bash
# Bun >= 1.4
bunx --bun ghc-proxy@latest start

# Node.js >= 24
npx ghc-proxy@latest start
```

## Prerequisites

Before you start, make sure you have:

1. **One supported JavaScript runtime:**
   - **Bun >= 1.4:** `winget install --id Oven-sh.Bun` on Windows, or see the [official installation guide](https://bun.com/docs/installation)
   - **Node.js >= 24:** install the latest LTS release from the [official Node.js download page](https://nodejs.org/en/download)
2. **A GitHub Copilot subscription** -- individual, business, or enterprise

## Quick Start

1. Start the proxy with your chosen runtime:

   ```bash
   # Bun
   bunx --bun ghc-proxy@latest start

   # Node.js
   npx ghc-proxy@latest start
   ```

2. On the first run, you will be guided through GitHub's device-code authentication flow. Follow the prompts to authorize the proxy.

3. Once authenticated, the proxy starts on **`http://localhost:4141`** and is ready to accept requests.

That's it. Any tool that supports the OpenAI or Anthropic API can now point to `http://localhost:4141`.

The examples below use `bunx --bun`. If you chose Node.js, replace `bunx --bun` with `npx`; the published CLI and commands are the same.

> **Tip:** If you set `--rate-limit`, add `--wait` to queue requests instead of rejecting them with 429 when the cooldown has not elapsed yet. See [Rate Limiting](#rate-limiting) for details.

## Using with Claude Code

This is the most common use case. There are two ways to set it up:

### Option A: One-command launch

```bash
bunx --bun ghc-proxy@latest start --claude-code
```

This starts the proxy, opens an interactive model picker, and prints a ready-to-paste environment command. Run that command in another terminal to launch Claude Code with the correct configuration.

### Option B: Permanent config (Recommended)

Create or edit `~/.claude/settings.json` (this applies globally to all projects):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy-token",
    "ANTHROPIC_MODEL": "claude-opus-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "deny": ["WebSearch"]
  }
}
```

Then simply start the proxy and use Claude Code as usual:

```bash
bunx --bun ghc-proxy@latest start
```

**What each environment variable does:**

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_BASE_URL` | Points Claude Code to the proxy instead of Anthropic's servers |
| `ANTHROPIC_AUTH_TOKEN` | Any non-empty string; the proxy handles real authentication |
| `ANTHROPIC_MODEL` | The model Claude Code uses for primary/Opus tasks |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | The model used for Sonnet-tier tasks |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | The model used for Haiku-tier (fast/cheap) tasks |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Disables telemetry and non-essential network traffic |

> **Tip:** The model names above (e.g. `claude-opus-5`) are mapped to actual Copilot models by the proxy. See [Model Mapping](#model-mapping) below for details.

See the [Claude Code settings docs](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables) for more options.

## CLI Reference

ghc-proxy uses a subcommand structure:

```bash
bunx --bun ghc-proxy@latest start          # Start the proxy server
bunx --bun ghc-proxy@latest auth           # Run GitHub auth flow without starting the server
bunx --bun ghc-proxy@latest auth --account work # Create or replace a named account
bunx --bun ghc-proxy@latest check-usage    # Show your Copilot usage/quota in the terminal
bunx --bun ghc-proxy@latest debug          # Print diagnostic info (version, paths, token status)
bunx --bun ghc-proxy@latest selfcheck      # Probe tokenizer chunks and Bun/Node runtime contracts in the packaged bundle
```

### `start` Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--port` | `-p` | `4141` | Port to listen on (`1..65535`; malformed or zero values fail before startup) |
| `--verbose` | `-v` | `false` | Enable verbose logging |
| `--account-type` | `-a` | `individual` | `individual`, `business`, or `enterprise` |
| `--rate-limit` | `-r` | -- | Minimum seconds between requests |
| `--wait` | `-w` | `false` | Queue requests instead of rejecting with 429 when `--rate-limit` cooldown has not elapsed (requires `--rate-limit`) |
| `--manual` | -- | `false` | Manually approve each request |
| `--github-token` | `-g` | -- | Use a GitHub token for this process only (normally obtained with `auth`); this flag does not persist it to `config.json` |
| `--claude-code` | `-c` | `false` | Generate a Claude Code launch command |
| `--show-token` | -- | `false` | Display tokens on auth and refresh |
| `--dump-failed-payloads` | `-D` | `false` | Dump failed `/responses` payloads on upstream 400 errors for debugging. Can also be enabled with `DUMP_FAILED_PAYLOADS=1`. |
| `--proxy-env` | -- | `false` | Use `HTTP_PROXY`/`HTTPS_PROXY` from env (Node.js only; Bun reads proxy env natively) |
| `--idle-timeout` | -- | `120` | Bun server idle timeout in seconds (`0` disables; Bun max is `255`; streaming routes disable idle timeout automatically) |
| `--upstream-timeout` | -- | `1800` | Upstream request timeout in seconds (`0` disables). Enforced as a total-duration `AbortSignal`. Note both runtimes also apply their own ~300s **idle** timeout to `fetch` (Bun's built-in limit; Node's undici `headersTimeout`/`bodyTimeout`), which fires when no byte arrives for that long — a steadily streaming response is not capped by it, but a stalled one is rejected at ~300s and returned as a `504`. |
| `--upstream-queue-concurrency` | -- | `10` | Maximum concurrent Copilot upstream requests |
| `--upstream-queue-retries` | -- | `1` | Maximum retries across capacity and approved pre-connection failures (`0..2`). Generation requests retry HTTP `429`/`529`; effect-free requests retain the broader transient-status policy |
| `--upstream-recovery-budget` | -- | `60` | Seconds available after the first approved retryable outcome or active-cooldown encounter for all later waits and pre-`Response` attempts (`1..120`) |
| `--upstream-queue-base-delay` | -- | `2` | Base delay in seconds for upstream retry backoff when `Retry-After` is absent |
| `--upstream-queue-max-delay` | -- | `60` | Maximum computed backoff in seconds; never shortens a valid `Retry-After` minimum |
| `--ghe-domain` | `--ghe` | -- | GitHub Enterprise Cloud company domain (e.g. `company.ghe.com`). Required for GHE.com device login on first run; persisted automatically for later runs. |

## Rate Limiting

If you want to throttle how often the proxy forwards requests:

```bash
# Enforce a 30-second cooldown between requests
bunx --bun ghc-proxy@latest start --rate-limit 30

# Same, but queue requests instead of returning 429
bunx --bun ghc-proxy@latest start --rate-limit 30 --wait

# Manually approve every request (useful for debugging)
bunx --bun ghc-proxy@latest start --manual
```

`--wait` only takes effect when `--rate-limit` is also set. Without `--rate-limit`, there is no cooldown to wait on and `--wait` has no effect.

## Account Types

If you have a GitHub Business or Enterprise Copilot plan, pass `--account-type`:

```bash
bunx --bun ghc-proxy@latest start --account-type business
bunx --bun ghc-proxy@latest start --account-type enterprise
```

This routes requests to the correct Copilot API endpoint for your plan. See the [GitHub docs on network routing](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization) for details.

### GitHub Enterprise Cloud (GHE.com)

If your organization uses GitHub Enterprise Cloud (`*.ghe.com`), the standard GitHub device login URL differs from `github.com`. Pass your company's GHE domain on first auth:

```bash
bunx --bun ghc-proxy@latest start --account-type enterprise --ghe-domain company.ghe.com
```

Or authenticate first, then start without the flag on subsequent runs:

```bash
# First run (authenticates and persists the domain)
bunx --bun ghc-proxy@latest auth --ghe-domain company.ghe.com

# Later runs (domain is read from persisted config)
bunx --bun ghc-proxy@latest start --account-type enterprise
```

The proxy normalizes and persists the GHE domain automatically after a successful authentication, so you only need to pass `--ghe-domain` on the first run or when switching tenants.

> **Note:** `--account-type enterprise` alone is not sufficient for GHE.com login — the proxy needs the company domain to construct the correct device login URL (`https://<company>.ghe.com/login/device`). GHE.com support is scoped to `*.ghe.com` only and does not apply to self-hosted GitHub Enterprise Server instances.

## Configuration

The proxy reads an optional JSON config file at:

```
~/.local/share/ghc-proxy/config.json
```

GitHub credentials are stored separately at
`~/.local/share/ghc-proxy/credentials.json`. The credential file is versioned,
selects one active account for legacy single-account mode, and can retain
multiple named accounts:

```json
{
  "version": 1,
  "activeAccount": "default",
  "accounts": {
    "default": {
      "githubToken": "<base64>",
      "gheDomain": "company.ghe.com"
    }
  }
}
```

Base64 is low-cost obfuscation, not encryption; anyone who can read the file can
decode it. On first startup after upgrading, a legacy `config.json` token is
copied into this store only after a complete temporary config backup is created.
The legacy field and backup are removed after the stored credential succeeds at
both GitHub identity validation and Copilot token acquisition. A failed or
interrupted migration keeps the backup and reports its recovery path.

### Named Account Routing

Authenticate each account under a stable name:

```bash
bunx --bun ghc-proxy@latest auth --account default
bunx --bun ghc-proxy@latest auth --account account1

# A named GHE.com account keeps its own tenant beside its credential.
bunx --bun ghc-proxy@latest auth --account work --ghe-domain company.ghe.com
```

Account names are case-sensitive, 1-64 characters, and may contain ASCII
letters, numbers, `.`, `_`, and `-`; the first character must be alphanumeric.

For an existing single-account installation, open the local Dashboard Accounts
view. The current legacy account remains the default, and the bootstrap form
suggests `defaultaccount.localhost` as its dedicated hostname. Edit that value
if needed, then enable routing. The change is persisted transactionally and
takes effect without restarting the process.

You can also configure hostname routing directly in `config.json`:

```json
{
  "accountRouting": {
    "baseHostname": "localhost",
    "defaultAccount": "default",
    "hostnames": {
      "default.localhost": "default",
      "account1.localhost": "account1"
    }
  }
}
```

With that configuration, `http://localhost:4141` and the stable dedicated
hostname `http://default.localhost:4141` use `default`, while
`http://account1.localhost:4141` uses `account1`. Every routed account must have
exactly one dedicated hostname. The base hostname is an additional alias for
the currently selected default, so switching the default never changes any
dedicated hostname. DNS hostname matching is case-insensitive, ignores the
request port, and accepts a trailing root dot.
Any other hostname is rejected with HTTP `421` before a route handler or
upstream request runs. `Forwarded` and `X-Forwarded-Host` are not trusted for
account selection.

Each account has independent GitHub/Copilot tokens, refresh scheduling, model
cache, Responses emulator state, local rate limiter, and upstream queue/cooldown
state. A failure or capacity response on one account never switches, falls back,
rotates, or load-balances the request to another account. Process-wide policy
configuration remains shared.

`accountRouting` is opt-in so existing single-account installations retain their
current Host behavior until the local Dashboard bootstrap is explicitly
confirmed. The active legacy credential becomes the explicit default account;
the suggested `defaultaccount.localhost` hostname is editable before commit. In
routing mode every referenced account must already exist, and `defaultAccount`
must be explicit. Invalid or ambiguous routing config fails startup. Dashboard
bootstrap is unavailable while process-wide `start --github-token` or
`start --ghe-domain` overrides are active, and those overrides are rejected once
routing is enabled because they cannot identify one named account. Hostname
routing is a deterministic selector, not an authorization boundary: callers
that can reach the listener and choose a configured `Host` can select that
account unless access is enforced separately.

For Docker deployments, leave `GH_TOKEN` unset in routing mode and mount the
populated credential/config directory. The image healthcheck reads
`accountRouting.baseHostname`, applies the same DNS ASCII/case/root-dot
normalization, and sends it as `Host` while connecting over loopback, so health
checks do not require an IP-hostname exception.

All fields are optional. The full schema:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `modelRewrites` | `{ from, to }[]` | `[]` | Glob-pattern model substitution rules (see [Model Rewrites](#model-rewrites)) |
| `modelFallback` | `object` | built-in family defaults | Override default model fallbacks (see [Customizing Fallbacks](#customizing-fallbacks)) |
| `modelFallback.claudeOpus` | `string` | `claude-opus-5` | Fallback for `claude-opus-*` models |
| `modelFallback.claudeSonnet` | `string` | `claude-sonnet-5` | Fallback for `claude-sonnet-*` models |
| `modelFallback.claudeHaiku` | `string` | `claude-haiku-4.5` | Fallback for `claude-haiku-*` models |
| `smallModel` | `string` | unset | Target model for compact request routing (see [Small-Model Routing](#small-model-routing)) |
| `compactUseSmallModel` | `boolean` | `false` | Route compact/summarization requests to `smallModel` |
| `useFunctionApplyPatch` | `boolean` | `true` | Rewrite `apply_patch` custom tool as function tool on Responses path |
| `responsesApiAutoCompactInput` | `boolean` | `false` | Automatically trim Responses `input` to the latest `compaction` item |
| `responsesApiAutoContextManagement` | `boolean` | `false` | Automatically inject Responses `context_management` for selected models |
| `responsesApiContextManagementModels` | `string[]` | `[]` | Models eligible for auto-injected Responses `context_management` |
| `responsesApiParameterFilters` | `{ models, params }[]` | `[]` | Extra rules to strip request parameters on the Responses boundary; the built-in reasoning-model rule remains active unless replaced (see [Responses Parameter Filters](#responses-parameter-filters)) |
| `responsesApiParameterFiltersReplaceDefault` | `boolean` | `false` | Disable the built-in reasoning-model default rule so only your `responsesApiParameterFilters` apply |
| `chatCompletionsUseMaxCompletionTokens` | `string[]` | `[]` | Extra model globs that rename Chat Completions `max_tokens` to `max_completion_tokens`; adds to the built-in `gpt-5.4` / `gpt-5.4-*` rules |
| `responsesOfficialEmulator` | `boolean` | `false` | Enable local OpenAI-style Responses state emulation for `previous_response_id`, `conversation`, retrieve, input_items, delete, and input_tokens |
| `responsesOfficialEmulatorTtlSeconds` | `number` | `14400` | In-memory TTL for locally emulated Responses state |
| `modelReasoningEfforts` | `Record<string, string>` | `{}`; unlisted models use `high` | Per-model reasoning effort defaults for Anthropic-to-Responses translation. Each value must be one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` (ascending) |
| `upstreamQueueConcurrency` | `number` | `10` | Maximum concurrent Copilot upstream requests |
| `upstreamQueueMaxRetries` | `number` | `1` | Maximum retries across capacity and approved pre-connection failures (`0..2`) |
| `upstreamRecoveryBudgetSeconds` | `number` | `60` | Shared recovery deadline after the first retryable outcome or active-cooldown encounter (`1..120` seconds) |
| `overloadFallbacks` | `Record<string, string>` | `{}` (disabled) | Exact effective-model mappings for one opt-in fallback dispatch after terminal model `529` |
| `upstreamQueueBaseDelaySeconds` | `number` | `2` | Base delay (seconds) for upstream retry backoff when `Retry-After` is absent |
| `upstreamQueueMaxDelaySeconds` | `number` | `60` | Maximum computed backoff (seconds); does not clamp `Retry-After` |
| `gheDomain` | `string` | unset | GitHub Enterprise Cloud company domain (persisted automatically after GHE.com auth) |
| `accountRouting` | `{ baseHostname, defaultAccount, hostnames }` | unset | Opt-in exact DNS hostname to named-account routing; unknown hostnames are rejected |

Example:

```json
{
  "modelRewrites": [
    { "from": "claude-haiku-*", "to": "gpt-4.1-mini" }
  ],
  "modelFallback": {
    "claudeOpus": "claude-opus-5",
    "claudeSonnet": "claude-sonnet-5"
  },
  "smallModel": "gpt-4.1-mini",
  "compactUseSmallModel": true,
  "useFunctionApplyPatch": true,
  "responsesApiAutoCompactInput": false,
  "responsesApiAutoContextManagement": false,
  "responsesApiContextManagementModels": ["gpt-5", "gpt-5-mini"],
  "chatCompletionsUseMaxCompletionTokens": [],
  "responsesOfficialEmulator": false,
  "responsesOfficialEmulatorTtlSeconds": 14400,
  "modelReasoningEfforts": {
    "gpt-5": "high",
    "gpt-5-mini": "medium"
  },
  "overloadFallbacks": {
    "claude-opus-5": "claude-opus-4.8"
  }
}
```

**Priority order** for model fallbacks: environment variable > config.json > built-in default.

## Model Mapping

When Claude Code sends a request for a model like `claude-sonnet-4.6`, the proxy maps it to an actual model available on Copilot. The mapping logic works as follows:

1. If the requested model ID is known to Copilot (e.g. `gpt-4.1`, `claude-sonnet-4.5`), it is used as-is.
2. If the model starts with `claude-opus-`, `claude-sonnet-`, or `claude-haiku-`, it falls back to a configured model.

### Default Fallbacks

| Prefix | Default Fallback |
|--------|-----------------|
| `claude-opus-*` | `claude-opus-5` |
| `claude-sonnet-*` | `claude-sonnet-5` |
| `claude-haiku-*` | `claude-haiku-4.5` |

### Customizing Fallbacks

You can override the defaults with **environment variables**:

```bash
MODEL_FALLBACK_CLAUDE_OPUS=claude-opus-5
MODEL_FALLBACK_CLAUDE_SONNET=claude-sonnet-5
MODEL_FALLBACK_CLAUDE_HAIKU=claude-haiku-4.5
```

Or in the proxy's **config file** (`~/.local/share/ghc-proxy/config.json`):

```json
{
  "modelFallback": {
    "claudeOpus": "claude-opus-5",
    "claudeSonnet": "claude-sonnet-5",
    "claudeHaiku": "claude-haiku-4.5"
  }
}
```

> **Note:** Model fallbacks only apply to the **chat completions translation path**. The native Messages and Responses API strategies pass the model ID through to Copilot as-is.

### Model Rewrites

For more general model substitution, use `modelRewrites` in the config file. Each rule maps a `from` pattern to a `to` model ID. The `from` field supports glob patterns with `*` wildcards, and the first matching rule wins.

```json
{
  "modelRewrites": [
    { "from": "claude-haiku-*", "to": "gpt-4.1-mini" },
    { "from": "gpt-5.4*", "to": "gpt-5.2" }
  ]
}
```

Unlike model fallbacks (which only apply to the chat completions path), rewrites are applied **uniformly to all three endpoints** — `/v1/messages`, `/v1/chat/completions`, and `/v1/responses`. Target model names are normalized against Copilot's known model list using dash/dot equivalence (e.g. `gpt-4.1` matches `gpt-4-1`).

Rewrites run **before** any other model policy — small-model routing and strategy selection all see the rewritten model.

### Overload Fallbacks

`overloadFallbacks` is a separate, opt-in recovery policy. Each key and value is an exact advertised model ID after normal rewrite/compact resolution:

```json
{
  "overloadFallbacks": {
    "claude-opus-5": "claude-opus-4.8"
  }
}
```

Fallback is considered only after a terminal source-model `529` or a pre-existing local cooldown for that source. It never runs for account `429`, connection failures, timeouts, cancellation, validation failures, other statuses, or failures after an upstream `Response` exists. The target must be distinct, advertised, not locally cooled, and compatible with the request's endpoint, tools, parallel tools, streaming, vision, reasoning/thinking, and structured-output needs. The pipeline rebuilds target-dependent transforms and strategy selection from pristine input, dispatches once with no fresh retry allowance, and reports the actual served target in response model fields and the `OVERLOAD_FALLBACK` model trace.

Mappings are exact one-hop choices, not a traversed graph. Blank, same-model, and reciprocal two-node entries such as `A -> B` plus `B -> A` are ignored with a configuration warning. An unknown or incompatible runtime target preserves the source `529`.

## Upstream Capacity Recovery

An upstream `429` establishes an account cooldown. A `529` is scoped to the final effective upstream model; if no effective model is known, it remains request-only. Eligible models can bypass cooled waiters while a global slot is free, but active slots and the maximum pending depth remain process-global limits.

The first attempt keeps the normal upstream timeout. The recovery budget starts at the first approved retryable outcome or the first encounter with an already-active cooldown, then covers every later cooldown/backoff wait, queue acquisition, same-model attempt until `Response`, and overload fallback. A valid integer-seconds, HTTP-date, or full-string fractional-seconds `Retry-After` is a strict lower bound and installs its full cooldown deadline. If that minimum cannot fit, the proxy skips the same-model retry instead of shortening it. Without a valid header, full jitter is sampled from zero through the smallest of exponential backoff, `upstreamQueueMaxDelaySeconds`, and remaining budget.

Generation requests additionally retry only measured pre-connection shapes: Bun `ConnectionRefused`, or Node `ECONNREFUSED`, `ENOTFOUND`, and `EAI_AGAIN`. Caller aborts, every timeout, TLS/configuration failures, resets, generic fetch errors, body failures, and stream failures are excluded. Once `fetch()` returns a `Response`, that attempt is committed: a later JSON/SSE/body failure is never replayed or sent to fallback.

Recovery logs use the existing request ID and structured fields such as event, retry count, status/connection class, effective model, scope, active/max slots, pending/max depth, queue wait, delay source/delay, elapsed/remaining budget, `nextRetryAt`, and decision. Public responses keep protocol-compatible payloads and only safe standard metadata such as `Retry-After`; no retry-progress SSE event or recovery payload extension is added. Per inbound request, the attempt ceiling is `1 + upstreamQueueMaxRetries + at most one configured fallback`; outer SDK retries multiply that ceiling independently.

## Small-Model Routing

`/v1/messages` can optionally reroute specific low-value requests to a cheaper model:

- `smallModel`: the model to reroute to
- `compactUseSmallModel`: reroute recognized compact/summarization requests

The switch defaults to `false`. Routing is conservative:

- the target `smallModel` must exist in Copilot's model list
- it must preserve the original model's declared endpoint support
- tool, thinking, and vision requests are not rerouted to a model that lacks the required capabilities

## How it Works

ghc-proxy sits between your tools and the GitHub Copilot API:

```text
┌──────────────┐      ┌───────────┐      ┌───────────────────────┐
│ Claude Code  │──────│ ghc-proxy │──────│ api.githubcopilot.com │
│ Cursor       │      │ :4141     │      │                       │
│ Any client   │      │           │      │                       │
└──────────────┘      └───────────┘      └───────────────────────┘
   OpenAI or           Translates           GitHub Copilot
   Anthropic           between              API
   format              formats
```

The proxy authenticates with GitHub using the [device code OAuth flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) (the same flow VS Code uses), then exchanges the GitHub token for a short-lived Copilot token that auto-refreshes.

When the Copilot token response includes `endpoints.api`, `ghc-proxy` now prefers that runtime API base automatically instead of relying only on the configured account type. This keeps enterprise/business routing aligned with the endpoint GitHub actually returned for the current token.

Incoming requests hit an [Elysia](https://elysiajs.com/) server. `chat/completions` requests are validated, normalized into the shared planning pipeline, and then forwarded to Copilot. `responses` requests use a native Responses path with explicit compatibility policies. `messages` requests are routed per-model and can use native Anthropic passthrough, the Responses translation path, or the existing chat-completions fallback. The translator tracks exact vs lossy vs unsupported behavior explicitly; see the [Messages Routing and Translation Guide](./docs/messages-routing-and-translation.md) and the [Anthropic Translation Matrix](./docs/anthropic-translation-matrix.md) for the current support surface.

The built-in Dashboard projects process health, named account status, model routing, behavior, and recent request lifecycle metadata without storing request or response content. Its protected Accounts view can explicitly bootstrap a legacy account into named routing, authenticate a new account with a dedicated hostname, and switch the default account. See [Dashboard Observability](./docs/design/dashboard-observability.md).

For Anthropic `search_result` blocks, an April 17, 2026 probe against `claude-opus-4.6` on Copilot native `/v1/messages` accepted top-level search results and pure search-result tool outputs, but rejected top-level `citations` and mixed text/search-result tool output arrays. The native path sanitizes those observed rejection cases, while translated paths flatten search results to text; re-run the probe before treating that dated upstream result as universal.

### Request Routing

`ghc-proxy` does not force every request through one protocol. The current routing rules are:

- `POST /v1/chat/completions`: OpenAI Chat Completions -> shared planning pipeline -> Copilot `/chat/completions`
- `POST /v1/responses`: OpenAI Responses create -> native Responses handler -> Copilot `/responses`
- `POST /v1/responses/input_tokens`: Responses input-token counting passthrough by default, or local estimation in official emulator mode
- `GET /v1/responses/:responseId`: Responses retrieve passthrough by default, or local retrieval in official emulator mode
- `GET /v1/responses/:responseId/input_items`: Responses input-items passthrough by default, or local retrieval in official emulator mode
- `DELETE /v1/responses/:responseId`: Responses delete passthrough by default, or local deletion in official emulator mode
- `POST /v1/messages`: Anthropic Messages -> choose the best available upstream path for the selected model:
  - native Copilot `/v1/messages` when supported
  - Anthropic -> Responses -> Anthropic translation when the model only supports `/responses`
  - Anthropic -> Chat Completions -> Anthropic fallback otherwise

This keeps the existing chat pipeline stable while allowing newer Copilot models to use the endpoint they actually expose.

### Endpoints

**OpenAI compatible:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Chat completions (streaming and non-streaming) |
| `POST` | `/v1/responses` | Create a Responses API response |
| `POST` | `/v1/responses/input_tokens` | Count Responses input tokens via upstream passthrough or the local official emulator |
| `GET` | `/v1/responses/:responseId` | Retrieve one response via upstream passthrough or the local official emulator |
| `GET` | `/v1/responses/:responseId/input_items` | Retrieve response input items via upstream passthrough or the local official emulator |
| `DELETE` | `/v1/responses/:responseId` | Delete one response via upstream passthrough or the local official emulator |
| `GET`  | `/v1/models` | List available models |
| `POST` | `/v1/embeddings` | Generate embeddings |

**Anthropic compatible:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Messages API with per-model routing across native Messages, Responses translation, or chat-completions fallback |
| `POST` | `/v1/messages/count_tokens` | Token counting |

**Utility:**

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/health` | Liveness/readiness probe — returns `{ status, copilotToken, modelsLoaded, version }` |
| `GET`  | `/usage` | Copilot quota / usage monitoring |
| `GET`  | `/token` | Inspect the current Copilot token |

**Local Dashboard:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dashboard` | Dashboard application |
| `GET` | `/dashboard/styles.css` | Dashboard stylesheet |
| `GET` | `/dashboard/app.js` | Dashboard client script |
| `GET` | `/dashboard/api/overview` | Process, authentication, quota, request, and queue summary |
| `GET` | `/dashboard/api/models` | Upstream model metadata and effective proxy capabilities |
| `GET` | `/dashboard/api/behavior` | Active routing, compatibility policies, strategies, and effect counters |
| `GET` | `/dashboard/api/requests` | Active requests and the most recent 256 completed request summaries |
| `GET` | `/dashboard/api/accounts` | Safe per-account identity, tenant, authentication, Copilot status, quota, hostname, and default marker |
| `POST` | `/dashboard/api/accounts/bootstrap` | Persist and enable named routing for the current legacy default account |
| `POST` | `/dashboard/api/accounts` | Start device authentication for a new named account and its dedicated hostname |
| `GET` | `/dashboard/api/account-auth/:id` | Read the safe state of an in-progress account authentication |
| `POST` | `/dashboard/api/accounts/default` | Persist and activate an explicit default account |

Dashboard routes are restricted to local access and return `403` when the peer, request host, or supplied `Origin` fails the loopback/same-origin checks. A normal legacy single-account process exposes an explicit bootstrap action; adding accounts and changing the default remain unavailable until bootstrap succeeds. Processes using `start --github-token` or `start --ghe-domain` retain legacy behavior and return `409` for account management because those overrides cannot be assigned safely. Dashboard requests are excluded from request history and access logging. See [Dashboard Observability](./docs/design/dashboard-observability.md) for the projection, transaction, and security contract.

> **Note:** The `/v1/` prefix is optional for OpenAI-compatible endpoints (`/chat/completions`, `/responses` and its resource routes, `/models`, `/embeddings`). Anthropic endpoints (`/v1/messages`, `/v1/messages/count_tokens`) require the `/v1` prefix. The utility and Dashboard endpoints are root-only and not exposed under `/v1`.

## Responses Compatibility

`/v1/responses` is designed to stay close to the OpenAI wire format while making Copilot limitations explicit:

- requests are validated before any mutation
- client-supplied `top_k` is rejected with `400` on the OpenAI Chat Completions and Responses boundaries because neither official OpenAI schema defines it; clients that send it by mistake receive an explicit error instead of a silent drop. Anthropic Messages `top_k` remains supported and is preserved when the proxy translates that request internally for Copilot
- common official request fields such as `conversation`, `previous_response_id`, `max_tool_calls`, `truncation`, `user`, `prompt`, and `text` are now modeled explicitly instead of relying on loose passthrough alone
- official `text.format` options are modeled explicitly, including `text`, `json_object`, and `json_schema`
- an opt-in `responsesOfficialEmulator` mode adds in-memory OpenAI-style state for `previous_response_id`, `conversation`, `GET /responses/{id}`, `GET /responses/{id}/input_items`, `DELETE /responses/{id}`, and `POST /responses/input_tokens`
- emulator state is memory-only and expires after `responsesOfficialEmulatorTtlSeconds` (default `14400`, or 4 hours)
- `background: true` is rejected explicitly while emulator mode is enabled
- `custom` `apply_patch` can be rewritten as a function tool when `useFunctionApplyPatch` is enabled
- automatic Responses `context_management` injection is disabled by default and only applies when `responsesApiAutoContextManagement` is `true` and the model matches `responsesApiContextManagementModels`
- automatic trimming of Responses `input` to the latest `compaction` item is disabled by default and only applies when `responsesApiAutoCompactInput` is `true`
- reasoning defaults for Anthropic -> Responses translation can be tuned with `modelReasoningEfforts`
- request parameters that a model rejects (e.g. `temperature`/`top_p` on reasoning models) are stripped on the Responses boundary rather than leaked upstream as a `400`; see [Responses Parameter Filters](#responses-parameter-filters)
- built-in web search (`web_search`, `web_search_preview`, and their dated variants) is forwarded to Copilot rather than blocked; every `/responses` model reached by the August 4, 2026 acceptance sweep accepted the tool, while functional search execution was verified on `gpt-5.6-sol` and `gpt-5.6-terra`, see [docs/research/responses-web-search.md](docs/research/responses-web-search.md)
- external image URLs on the Responses path fail explicitly with `400`; use `file_id` or data URL image input instead
- official `input_file` and `item_reference` input items are modeled explicitly and validated, but the verified Copilot GPT Responses boundary is stateless: it rejects `store: true` and cannot resolve returned item IDs on later requests. The proxy deliberately applies a proxy-wide `store: false` policy, removes all `item_reference` items before dispatch, and removes `function_call_output` items whose `call_id` has no matching `function_call` in the same input array. Without the optional emulator, a caller that requested storage still receives a successful stateless response; retrieve/delete/continuation semantics are available only from the local emulator

Example opt-in configuration for these two Responses-specific policies:

```json
{
  "responsesApiAutoContextManagement": true,
  "responsesApiContextManagementModels": ["gpt-5"],
  "responsesApiAutoCompactInput": true,
  "responsesOfficialEmulator": true,
  "responsesOfficialEmulatorTtlSeconds": 14400
}
```

> See [Responses Upstream Notes](./docs/responses-upstream-notes.md) for detailed upstream compatibility observations from live testing.

### Responses Parameter Filters

Some Copilot models reject request parameters that the OpenAI wire format allows. The clearest case: **reasoning models** (the `gpt-5` family, o-series, codex) reject sampling parameters and answer `POST /responses` with `400 Unsupported parameter: 'temperature' is not supported with this model.` Since the client cannot always be changed, the proxy strips the offending parameters on the Responses boundary instead of leaking the incompatibility outward.

This is expressed as a small rule engine that runs on both the native `/v1/responses` path and the `/v1/messages` → Responses translation path:

- **Built-in default rule:** any model that advertises `reasoning_effort` has `temperature` stripped. It also has `top_p` stripped except for `*-codex` / `*-codex-*` models, which are exempt because the July 26, 2026 probe found the tested Codex model accepted `top_p` while its reasoning-model siblings rejected it. This exemption narrows only the built-in rule; an operator rule can still strip `top_p`.
- **`responsesApiParameterFilters`:** add your own rules. Each rule is `{ "models": [glob, ...], "params": [name, ...] }`; every rule whose `models` glob matches the resolved model contributes its `params`. Rules are **added** to the default (the union of parameters is stripped). Model globs use the same `*` wildcard as `modelRewrites`.
- **`responsesApiParameterFiltersReplaceDefault`:** set to `true` to disable the built-in reasoning-model rule, so only your `responsesApiParameterFilters` apply — use this to fully **overwrite** the default behavior.

Stripped parameters are removed entirely (never sent as `null`), because upstream rejects the mere presence of the key.

```json
{
  "responsesApiParameterFilters": [
    { "models": ["gpt-5*", "o1*"], "params": ["temperature", "top_p"] },
    { "models": ["some-model"], "params": ["service_tier"] }
  ],
  "responsesApiParameterFiltersReplaceDefault": false
}
```

## Docker

Pre-built images are available on GHCR:

```bash
docker pull ghcr.io/wxxb789/ghc-proxy
docker volume create ghc-proxy-data
docker run --rm -p 127.0.0.1:4141:4141 \
  -v ghc-proxy-data:/home/bun/.local/share/ghc-proxy \
  ghcr.io/wxxb789/ghc-proxy
```

Or build locally:

```bash
docker build -t ghc-proxy .
docker volume create ghc-proxy-data
docker run --rm -p 127.0.0.1:4141:4141 \
  -v ghc-proxy-data:/home/bun/.local/share/ghc-proxy \
  ghc-proxy
```

Authentication and settings are persisted in the `ghc-proxy-data` volume so they survive container restarts. The proxy does not provide API authentication. Keep the port bound to loopback as shown; any non-loopback deployment needs an authenticated TLS reverse proxy or a firewall that restricts access.

Run the device-code authentication flow once against the same volume:

```bash
docker run --rm -it \
  -v ghc-proxy-data:/home/bun/.local/share/ghc-proxy \
  ghcr.io/wxxb789/ghc-proxy auth
```

The legacy `--auth` container argument remains supported, but `auth` is the standard CLI subcommand:

```bash
docker run --rm -it \
  -v ghc-proxy-data:/home/bun/.local/share/ghc-proxy \
  ghcr.io/wxxb789/ghc-proxy --auth
```

You can also pass a GitHub token via `GH_TOKEN`. The container [entrypoint](entrypoint.sh) forwards a non-empty value only when starting the proxy, as `start --github-token`:

```bash
docker run --rm -p 127.0.0.1:4141:4141 \
  -v ghc-proxy-data:/home/bun/.local/share/ghc-proxy \
  -e GH_TOKEN=your_token \
  ghcr.io/wxxb789/ghc-proxy
```

Docker Compose:

```yaml
services:
  ghc-proxy:
    image: ghcr.io/wxxb789/ghc-proxy
    ports:
      - '127.0.0.1:4141:4141'
    volumes:
      - ghc-proxy-data:/home/bun/.local/share/ghc-proxy
    environment:
      - GH_TOKEN=your_token_here
    restart: unless-stopped

volumes:
  ghc-proxy-data:
```

## Running from Source

Repository development uses Bun >= 1.4 even if you run the published package with Node.js.

```bash
git clone https://github.com/wxxb789/ghc-proxy.git
cd ghc-proxy
bun install
bun run dev              # Start with --watch
# Or use the production-style source command:
bun run start
```

## Development

```bash
bun install              # Install dependencies
bun run dev              # Start with --watch
bun run start            # Start without --watch
bun run build            # Build with tsdown
bun run lint             # ESLint
bun run typecheck        # tsc --noEmit
bun test                 # Run tests
bun run matrix:live      # Real Copilot upstream compatibility matrix
bun run matrix:live --vision-only --all-responses-models --json
bun run matrix:live --stateful-only --json --model=gpt-5.2-codex
```

> **Note:** `bun run matrix:live` uses your configured GitHub/Copilot credentials and spends real upstream requests. Use it when you want end-to-end verification against the current Copilot service, not for every local edit.
>
> Useful flags:
> - `--json`: emit machine-readable JSON only
> - `--vision-only`: run just the Responses image probes
> - `--stateful-only`: run follow-up/resource probes such as `previous_response_id`, `input_tokens`, and `input_items`
> - `--all-responses-models`: scan every model that advertises `/responses`
> - `--model=<id>`: pin the Responses scan to one specific model

### Tool Support Probe

Answers whether a tool **works**, not merely whether upstream returns `200` when you mention it. For each (model × tool) it declares the tool, then — unless `--accept-only` — sends a prompt that cannot be answered without it and looks in the response for proof it ran.

Verdicts: `supported` (the tool ran or was called), `inert` (accepted but never invoked), `unsupported` (upstream rejected it), `unmeasured` (capacity/gateway fault — no verdict, re-run before publishing).

```bash
bun scripts/probes/tool-support.ts                       # both boundaries
bun scripts/probes/tool-support.ts --json                # JSON snapshot to stdout
bun scripts/probes/tool-support.ts --model=claude-opus-5 # single model
bun scripts/probes/tool-support.ts --boundary=responses  # or: messages
bun scripts/probes/tool-support.ts --accept-only         # skip the functional pass (half the quota)
bun scripts/probes/tool-support.ts --names               # also probe client tool NAMES (WebSearch, shell, ...)
```

Latest results: [docs/research/builtin-tool-support.md](docs/research/builtin-tool-support.md).

The JSON output is designed for weekly diffing — `generatedAt` is the only volatile field:

```bash
# Compare two weekly snapshots
diff <(jq -S 'del(.generatedAt)' week1.json) <(jq -S 'del(.generatedAt)' week2.json)
```
