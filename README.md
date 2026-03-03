# ghc-proxy

[![npm](https://img.shields.io/npm/v/ghc-proxy)](https://www.npmjs.com/package/ghc-proxy)
[![CI](https://github.com/wxxb789/ghc-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/wxxb789/ghc-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/wxxb789/ghc-proxy/blob/master/LICENSE)

A proxy that turns your GitHub Copilot subscription into an OpenAI and Anthropic compatible API. Use it to power [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), [Cursor](https://www.cursor.com/), or any tool that speaks the OpenAI Chat Completions or Anthropic Messages protocol.

> [!WARNING]
> Reverse-engineered, unofficial, may break at any time. Excessive use can trigger GitHub abuse detection. **Use at your own risk.**

## Prerequisites

Before you start, make sure you have:

1. **Bun** (>= 1.2) -- a fast JavaScript runtime used to run the proxy
   - **Windows:** `winget install --id Oven-sh.Bun`
   - **Other platforms:** see the [official installation guide](https://bun.com/docs/installation)
2. **A GitHub Copilot subscription** -- individual, business, or enterprise

## Quick Start

1. Start the proxy:

       bunx ghc-proxy@latest start --wait

   > **Recommended:** The `--wait` flag queues requests instead of rejecting them with a 429 error when you hit Copilot rate limits. This is the simplest way to run the proxy for daily use.

2. On the first run, you will be guided through GitHub's device-code authentication flow. Follow the prompts to authorize the proxy.

3. Once authenticated, the proxy starts on **`http://localhost:4141`** and is ready to accept requests.

That's it. Any tool that supports the OpenAI or Anthropic API can now point to `http://localhost:4141`.

## Using with Claude Code

This is the most common use case. There are two ways to set it up:

### Option A: One-command launch

```bash
bunx ghc-proxy@latest start --claude-code
```

This starts the proxy, opens an interactive model picker, and copies a ready-to-paste environment command to your clipboard. Run that command in another terminal to launch Claude Code with the correct configuration.

### Option B: Permanent config (Recommended)

Create or edit `~/.claude/settings.json` (this applies globally to all projects):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy-token",
    "ANTHROPIC_MODEL": "claude-opus-4.6",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4.6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "deny": ["WebSearch"]
  }
}
```

Then simply start the proxy and use Claude Code as usual:

```bash
bunx ghc-proxy@latest start --wait
```

**What each environment variable does:**

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_BASE_URL` | Points Claude Code to the proxy instead of Anthropic's servers |
| `ANTHROPIC_AUTH_TOKEN` | Any non-empty string; the proxy handles real authentication |
| `ANTHROPIC_MODEL` | The model Claude Code uses for primary/Opus tasks |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | The model used for Sonnet-tier tasks |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | The model used for Haiku-tier (fast/cheap) tasks |
| `DISABLE_NON_ESSENTIAL_MODEL_CALLS` | Prevents Claude Code from making extra API calls |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Disables telemetry and non-essential network traffic |

> **Tip:** The model names above (e.g. `claude-opus-4.6`) are mapped to actual Copilot models by the proxy. See [Model Mapping](#model-mapping) below for details.

See the [Claude Code settings docs](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables) for more options.

## What it Does

ghc-proxy sits between your tools and the GitHub Copilot API:

```
┌─────────────┐      ┌───────────┐      ┌──────────────────────┐
│ Claude Code  │──────│ ghc-proxy │──────│ api.githubcopilot.com│
│ Cursor       │      │ :4141     │      │                      │
│ Any client   │      │           │      │                      │
└─────────────┘      └───────────┘      └──────────────────────┘
   OpenAI or            Translates          GitHub Copilot
   Anthropic            between              API
   format               formats
```

The proxy authenticates with GitHub using the [device code OAuth flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) (the same flow VS Code uses), then exchanges the GitHub token for a short-lived Copilot token that auto-refreshes.

Incoming requests hit a [Hono](https://hono.dev/) server. OpenAI-format requests are forwarded directly to Copilot. Anthropic-format requests pass through a translation layer that converts message formats, tool schemas, and streaming events between the two protocols -- including full support for tool use, thinking blocks, and image content.

### Endpoints

**OpenAI compatible:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Chat completions (streaming and non-streaming) |
| `GET`  | `/v1/models` | List available models |
| `POST` | `/v1/embeddings` | Generate embeddings |

**Anthropic compatible:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Messages API with full tool use and streaming support |
| `POST` | `/v1/messages/count_tokens` | Token counting |

**Utility:**

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/usage` | Copilot quota / usage monitoring |
| `GET`  | `/token` | Inspect the current Copilot token |

> **Note:** The `/v1/` prefix is optional. `/chat/completions`, `/models`, and `/embeddings` also work.

## CLI Reference

ghc-proxy uses a subcommand structure:

```bash
bunx ghc-proxy@latest start          # Start the proxy server
bunx ghc-proxy@latest auth           # Run GitHub auth flow without starting the server
bunx ghc-proxy@latest check-usage    # Show your Copilot usage/quota in the terminal
bunx ghc-proxy@latest debug          # Print diagnostic info (version, paths, token status)
```

### `start` Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--port` | `-p` | `4141` | Port to listen on |
| `--verbose` | `-v` | `false` | Enable verbose logging |
| `--account-type` | `-a` | `individual` | `individual`, `business`, or `enterprise` |
| `--rate-limit` | `-r` | -- | Minimum seconds between requests |
| `--wait` | `-w` | `false` | Wait instead of rejecting when rate-limited |
| `--manual` | -- | `false` | Manually approve each request |
| `--github-token` | `-g` | -- | Pass a GitHub token directly (from `auth`) |
| `--claude-code` | `-c` | `false` | Generate a Claude Code launch command |
| `--show-token` | -- | `false` | Display tokens on auth and refresh |
| `--proxy-env` | -- | `false` | Use `HTTP_PROXY`/`HTTPS_PROXY` from env |
| `--idle-timeout` | -- | `120` | Bun server idle timeout in seconds |
| `--upstream-timeout` | -- | `300` | Upstream request timeout in seconds (0 to disable) |

## Rate Limiting

If you are worried about hitting Copilot rate limits:

```bash
# Enforce a 30-second cooldown between requests
bunx ghc-proxy@latest start --rate-limit 30

# Same, but queue requests instead of returning 429
bunx ghc-proxy@latest start --rate-limit 30 --wait

# Manually approve every request (useful for debugging)
bunx ghc-proxy@latest start --manual
```

## Account Types

If you have a GitHub Business or Enterprise Copilot plan, pass `--account-type`:

```bash
bunx ghc-proxy@latest start --account-type business
bunx ghc-proxy@latest start --account-type enterprise
```

This routes requests to the correct Copilot API endpoint for your plan. See the [GitHub docs on network routing](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization) for details.

## Model Mapping

When Claude Code sends a request for a model like `claude-sonnet-4.6`, the proxy maps it to an actual model available on Copilot. The mapping logic works as follows:

1. If the requested model ID is known to Copilot (e.g. `gpt-4.1`, `claude-sonnet-4.5`), it is used as-is.
2. If the model starts with `claude-opus-`, `claude-sonnet-`, or `claude-haiku-`, it falls back to a configured model.

### Default Fallbacks

| Prefix | Default Fallback |
|--------|-----------------|
| `claude-opus-*` | `claude-opus-4.6` |
| `claude-sonnet-*` | `claude-sonnet-4.5` |
| `claude-haiku-*` | `claude-haiku-4.5` |

### Customizing Fallbacks

You can override the defaults with **environment variables**:

```bash
MODEL_FALLBACK_CLAUDE_OPUS=claude-opus-4.6
MODEL_FALLBACK_CLAUDE_SONNET=claude-sonnet-4.5
MODEL_FALLBACK_CLAUDE_HAIKU=claude-haiku-4.5
```

Or in the proxy's **config file** (`~/.local/share/ghc-proxy/config.json`):

```json
{
  "modelFallback": {
    "claudeOpus": "claude-opus-4.6",
    "claudeSonnet": "claude-sonnet-4.5",
    "claudeHaiku": "claude-haiku-4.5"
  }
}
```

**Priority order:** environment variable > config.json > built-in default.

## Docker

Build and run:

```bash
docker build -t ghc-proxy .
mkdir -p ./copilot-data
docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/ghc-proxy ghc-proxy
```

Authentication and settings are persisted in `copilot-data/config.json` so they survive container restarts.

You can also pass a GitHub token via environment variable:

```bash
docker run -p 4141:4141 -e GH_TOKEN=your_token ghc-proxy
```

Docker Compose:

```yaml
services:
  ghc-proxy:
    build: .
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
```
