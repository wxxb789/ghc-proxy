# ghc-proxy

[![npm](https://img.shields.io/npm/v/ghc-proxy)](https://www.npmjs.com/package/ghc-proxy)
[![CI](https://github.com/wxxb789/ghc-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/wxxb789/ghc-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/wxxb789/ghc-proxy/blob/master/LICENSE)

A proxy that turns your GitHub Copilot subscription into an OpenAI and Anthropic compatible API. Use it to power [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), [Cursor](https://www.cursor.com/), or any tool that speaks the OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages protocol.

> [!WARNING]
> Reverse-engineered, unofficial, may break at any time. Excessive use can trigger GitHub abuse detection. **Use at your own risk.**

**TL;DR** — Install [Bun](https://bun.com/docs/installation), then run:

```bash
bunx ghc-proxy@latest start
```

## Prerequisites

Before you start, make sure you have:

1. **Bun** (>= 1.3) -- a fast JavaScript runtime used to run the proxy
   - **Windows:** `winget install --id Oven-sh.Bun`
   - **Other platforms:** see the [official installation guide](https://bun.com/docs/installation)
2. **A GitHub Copilot subscription** -- individual, business, or enterprise

## Quick Start

1. Start the proxy:

       bunx ghc-proxy@latest start

2. On the first run, you will be guided through GitHub's device-code authentication flow. Follow the prompts to authorize the proxy.

3. Once authenticated, the proxy starts on **`http://localhost:4141`** and is ready to accept requests.

That's it. Any tool that supports the OpenAI or Anthropic API can now point to `http://localhost:4141`.

> **Tip:** If you set `--rate-limit`, add `--wait` to queue requests instead of rejecting them with 429 when the cooldown has not elapsed yet. See [Rate Limiting](#rate-limiting) for details.

## Using with Claude Code

This is the most common use case. There are two ways to set it up:

### Option A: One-command launch

```bash
bunx ghc-proxy@latest start --claude-code
```

This starts the proxy, opens an interactive model picker, and prints a ready-to-paste environment command. Run that command in another terminal to launch Claude Code with the correct configuration.

### Option B: Permanent config (Recommended)

Create or edit `~/.claude/settings.json` (this applies globally to all projects):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy-token",
    "ANTHROPIC_MODEL": "claude-opus-4.8",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4.6",
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
bunx ghc-proxy@latest start
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

> **Tip:** The model names above (e.g. `claude-opus-4.8`) are mapped to actual Copilot models by the proxy. See [Model Mapping](#model-mapping) below for details.

See the [Claude Code settings docs](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables) for more options.

## CLI Reference

ghc-proxy uses a subcommand structure:

```bash
bunx ghc-proxy@latest start          # Start the proxy server
bunx ghc-proxy@latest auth           # Run GitHub auth flow without starting the server
bunx ghc-proxy@latest check-usage    # Show your Copilot usage/quota in the terminal
bunx ghc-proxy@latest debug          # Print diagnostic info (version, paths, token status)
bunx ghc-proxy@latest selfcheck      # Probe the packaged bundle (loads every tokenizer chunk; useful for install troubleshooting)
```

### `start` Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--port` | `-p` | `4141` | Port to listen on |
| `--verbose` | `-v` | `false` | Enable verbose logging |
| `--account-type` | `-a` | `individual` | `individual`, `business`, or `enterprise` |
| `--rate-limit` | `-r` | -- | Minimum seconds between requests |
| `--wait` | `-w` | `false` | Queue requests instead of rejecting with 429 when `--rate-limit` cooldown has not elapsed (requires `--rate-limit`) |
| `--manual` | -- | `false` | Manually approve each request |
| `--github-token` | `-g` | -- | Pass a GitHub token directly (from `auth`) |
| `--claude-code` | `-c` | `false` | Generate a Claude Code launch command |
| `--show-token` | -- | `false` | Display tokens on auth and refresh |
| `--dump-failed-payloads` | `-D` | `false` | Dump failed `/responses` payloads on upstream 400 errors for debugging. Can also be enabled with `DUMP_FAILED_PAYLOADS=1`. |
| `--proxy-env` | -- | `false` | Use `HTTP_PROXY`/`HTTPS_PROXY` from env (Node.js only; Bun reads proxy env natively) |
| `--idle-timeout` | -- | `120` | Bun server idle timeout in seconds (`0` disables; Bun max is `255`; streaming routes disable idle timeout automatically) |
| `--upstream-timeout` | -- | `1800` | Upstream request timeout in seconds (0 to disable) |
| `--upstream-queue-concurrency` | -- | `10` | Maximum concurrent Copilot upstream requests |
| `--upstream-queue-retries` | -- | `5` | Maximum retries for upstream 429 responses |
| `--upstream-queue-base-delay` | -- | `2` | Base delay in seconds for upstream 429 backoff when `Retry-After` is absent |
| `--upstream-queue-max-delay` | -- | `60` | Maximum delay in seconds for upstream 429 backoff |
| `--ghe-domain` | `--ghe` | -- | GitHub Enterprise Cloud company domain (e.g. `company.ghe.com`). Required for GHE.com device login on first run; persisted automatically for later runs. |

## Rate Limiting

If you want to throttle how often the proxy forwards requests:

```bash
# Enforce a 30-second cooldown between requests
bunx ghc-proxy@latest start --rate-limit 30

# Same, but queue requests instead of returning 429
bunx ghc-proxy@latest start --rate-limit 30 --wait

# Manually approve every request (useful for debugging)
bunx ghc-proxy@latest start --manual
```

`--wait` only takes effect when `--rate-limit` is also set. Without `--rate-limit`, there is no cooldown to wait on and `--wait` has no effect.

## Account Types

If you have a GitHub Business or Enterprise Copilot plan, pass `--account-type`:

```bash
bunx ghc-proxy@latest start --account-type business
bunx ghc-proxy@latest start --account-type enterprise
```

This routes requests to the correct Copilot API endpoint for your plan. See the [GitHub docs on network routing](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization) for details.

### GitHub Enterprise Cloud (GHE.com)

If your organization uses GitHub Enterprise Cloud (`*.ghe.com`), the standard GitHub device login URL differs from `github.com`. Pass your company's GHE domain on first auth:

```bash
bunx ghc-proxy@latest start --account-type enterprise --ghe-domain company.ghe.com
```

Or authenticate first, then start without the flag on subsequent runs:

```bash
# First run (authenticates and persists the domain)
bunx ghc-proxy@latest auth --ghe-domain company.ghe.com

# Later runs (domain is read from persisted config)
bunx ghc-proxy@latest start --account-type enterprise
```

The proxy normalizes and persists the GHE domain automatically after a successful authentication, so you only need to pass `--ghe-domain` on the first run or when switching tenants.

> **Note:** `--account-type enterprise` alone is not sufficient for GHE.com login — the proxy needs the company domain to construct the correct device login URL (`https://<company>.ghe.com/login/device`). GHE.com support is scoped to `*.ghe.com` only and does not apply to self-hosted GitHub Enterprise Server instances.

## Configuration

The proxy reads an optional JSON config file at:

```
~/.local/share/ghc-proxy/config.json
```

All fields are optional. The full schema:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `githubToken` | `string` | -- | Persisted GitHub token. Normally written automatically by `auth` / `--github-token`; you rarely set this by hand |
| `modelRewrites` | `{ from, to }[]` | -- | Glob-pattern model substitution rules (see [Model Rewrites](#model-rewrites)) |
| `modelFallback` | `object` | -- | Override default model fallbacks (see [Customizing Fallbacks](#customizing-fallbacks)) |
| `modelFallback.claudeOpus` | `string` | `claude-opus-4.8` | Fallback for `claude-opus-*` models |
| `modelFallback.claudeSonnet` | `string` | `claude-sonnet-4.6` | Fallback for `claude-sonnet-*` models |
| `modelFallback.claudeHaiku` | `string` | `claude-haiku-4.5` | Fallback for `claude-haiku-*` models |
| `smallModel` | `string` | -- | Target model for compact request routing (see [Small-Model Routing](#small-model-routing)) |
| `compactUseSmallModel` | `boolean` | `false` | Route compact/summarization requests to `smallModel` |
| `useFunctionApplyPatch` | `boolean` | `true` | Rewrite `apply_patch` custom tool as function tool on Responses path |
| `responsesApiAutoCompactInput` | `boolean` | `false` | Automatically trim Responses `input` to the latest `compaction` item |
| `responsesApiAutoContextManagement` | `boolean` | `false` | Automatically inject Responses `context_management` for selected models |
| `responsesApiContextManagementModels` | `string[]` | -- | Models eligible for auto-injected Responses `context_management` |
| `responsesApiParameterFilters` | `{ models, params }[]` | -- | Extra rules to strip request parameters on the Responses boundary (see [Responses Parameter Filters](#responses-parameter-filters)) |
| `responsesApiParameterFiltersReplaceDefault` | `boolean` | `false` | Disable the built-in reasoning-model default rule so only your `responsesApiParameterFilters` apply |
| `responsesOfficialEmulator` | `boolean` | `false` | Enable local OpenAI-style Responses state emulation for `previous_response_id`, `conversation`, retrieve, input_items, delete, and input_tokens |
| `responsesOfficialEmulatorTtlSeconds` | `number` | `14400` | In-memory TTL for locally emulated Responses state |
| `modelReasoningEfforts` | `Record<string, string>` | -- | Per-model reasoning effort defaults for Anthropic-to-Responses translation. Each value must be one of `none`, `minimal`, `low`, `medium`, `high`, or `xhigh` |
| `upstreamQueueConcurrency` | `number` | `10` | Maximum concurrent Copilot upstream requests |
| `upstreamQueueMaxRetries` | `number` | `5` | Maximum retries for upstream 429 responses |
| `upstreamQueueBaseDelaySeconds` | `number` | `2` | Base delay (seconds) for upstream 429 backoff when `Retry-After` is absent |
| `upstreamQueueMaxDelaySeconds` | `number` | `60` | Maximum delay (seconds) for upstream 429 backoff |
| `gheDomain` | `string` | -- | GitHub Enterprise Cloud company domain (persisted automatically after GHE.com auth) |

Example:

```json
{
  "modelRewrites": [
    { "from": "claude-haiku-*", "to": "gpt-4.1-mini" }
  ],
  "modelFallback": {
    "claudeOpus": "claude-opus-4.8",
    "claudeSonnet": "claude-sonnet-4.6"
  },
  "smallModel": "gpt-4.1-mini",
  "compactUseSmallModel": true,
  "useFunctionApplyPatch": true,
  "responsesApiAutoCompactInput": false,
  "responsesApiAutoContextManagement": false,
  "responsesApiContextManagementModels": ["gpt-5", "gpt-5-mini"],
  "responsesOfficialEmulator": false,
  "responsesOfficialEmulatorTtlSeconds": 14400,
  "modelReasoningEfforts": {
    "gpt-5": "high",
    "gpt-5-mini": "medium"
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
| `claude-opus-*` | `claude-opus-4.8` |
| `claude-sonnet-*` | `claude-sonnet-4.6` |
| `claude-haiku-*` | `claude-haiku-4.5` |

### Customizing Fallbacks

You can override the defaults with **environment variables**:

```bash
MODEL_FALLBACK_CLAUDE_OPUS=claude-opus-4.8
MODEL_FALLBACK_CLAUDE_SONNET=claude-sonnet-4.6
MODEL_FALLBACK_CLAUDE_HAIKU=claude-haiku-4.5
```

Or in the proxy's **config file** (`~/.local/share/ghc-proxy/config.json`):

```json
{
  "modelFallback": {
    "claudeOpus": "claude-opus-4.8",
    "claudeSonnet": "claude-sonnet-4.6",
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

### Small-Model Routing

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

For Anthropic `search_result` blocks, current live probes show Copilot native `/v1/messages` accepts top-level search results and pure search-result tool outputs, but rejects top-level `citations` and mixed text/search-result tool output arrays. The native path sanitizes those known rejection cases, while translated paths flatten search results to text.

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

> **Note:** The `/v1/` prefix is optional for OpenAI-compatible endpoints (`/chat/completions`, `/responses`, `/models`, `/embeddings`). Anthropic endpoints (`/v1/messages`, `/v1/messages/count_tokens`) require the `/v1` prefix. The utility endpoints (`/health`, `/usage`, `/token`) are root-only and not exposed under `/v1`.

## Responses Compatibility

`/v1/responses` is designed to stay close to the OpenAI wire format while making Copilot limitations explicit:

- requests are validated before any mutation
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
- known unsupported builtin tools, such as `web_search`, fail explicitly with `400` instead of being silently removed
- external image URLs on the Responses path fail explicitly with `400`; use `file_id` or data URL image input instead
- official `input_file` and `item_reference` input items are modeled explicitly and validated before forwarding

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

- **Built-in default rule:** any model that advertises `reasoning_effort` has `temperature` and `top_p` stripped. This covers the whole reasoning family (including future point releases like `gpt-5.4-mini`) with no configuration.
- **`responsesApiParameterFilters`:** add your own rules. Each rule is `{ "models": [glob, ...], "params": [name, ...] }`; every rule whose `models` glob matches the resolved model contributes its `params`. Rules are **added** to the default (the union of parameters is stripped). Model globs use the same `*` wildcard as `modelRewrites`.
- **`responsesApiParameterFiltersReplaceDefault`:** set to `true` to disable the built-in reasoning-model rule, so only your `responsesApiParameterFilters` apply — use this to fully **overwrite** the default behavior.

Stripped parameters are removed entirely (never sent as `null`), because upstream rejects the mere presence of the key.

```json
{
  "responsesApiParameterFilters": [
    { "models": ["gpt-5*", "o1*"], "params": ["temperature", "top_p"] },
    { "models": ["some-model"], "params": ["top_k"] }
  ],
  "responsesApiParameterFiltersReplaceDefault": false
}
```

## Docker

Pre-built images are available on GHCR:

```bash
docker pull ghcr.io/wxxb789/ghc-proxy
docker run -p 4141:4141 ghcr.io/wxxb789/ghc-proxy
```

Or build locally:

```bash
docker build -t ghc-proxy .
mkdir -p ./copilot-data
docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/ghc-proxy ghc-proxy
```

Authentication and settings are persisted in `copilot-data/config.json` so they survive container restarts.

You can also pass a GitHub token via environment variable. The container [entrypoint](entrypoint.sh) forwards `GH_TOKEN` to `start --github-token`, so this is Docker-specific — the proxy binary itself does not read `GH_TOKEN` from the environment (outside Docker, use the `--github-token` flag or a persisted `config.json`):

```bash
docker run -p 4141:4141 -e GH_TOKEN=your_token ghcr.io/wxxb789/ghc-proxy
```

To run the one-time device-code auth flow inside the container instead (writes the token into the mounted data volume):

```bash
docker run -it -v $(pwd)/copilot-data:/root/.local/share/ghc-proxy ghc-proxy --auth
```

Docker Compose:

```yaml
services:
  ghc-proxy:
    image: ghcr.io/wxxb789/ghc-proxy
    ports:
      - '4141:4141'
    environment:
      - GH_TOKEN=your_token_here
    restart: unless-stopped
```

## Running from Source

```bash
git clone https://github.com/wxxb789/ghc-proxy.git
cd ghc-proxy
bun install
bun run dev
```

## Development

```bash
bun install              # Install dependencies
bun run dev              # Start with --watch
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

Tests which server-side tool types (bash, text_editor, web_search, memory, etc.) each Copilot model actually accepts. Useful for tracking backend changes over time.

```bash
bun scripts/probes/copilot-tools.ts              # human-readable table
bun scripts/probes/copilot-tools.ts --json        # JSON snapshot to stdout
bun scripts/probes/copilot-tools.ts --model=claude-opus-4.6  # single model
```

The JSON output is designed for weekly diffing — `generatedAt` is the only volatile field:

```bash
# Compare two weekly snapshots
diff <(jq -S 'del(.generatedAt)' week1.json) <(jq -S 'del(.generatedAt)' week2.json)
```
