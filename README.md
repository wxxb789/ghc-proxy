# ghc-proxy

[![npm](https://img.shields.io/npm/v/ghc-proxy)](https://www.npmjs.com/package/ghc-proxy)
[![CI](https://github.com/wxxb789/ghc-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/wxxb789/ghc-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/wxxb789/ghc-proxy/blob/master/LICENSE)

A proxy that turns your GitHub Copilot subscription into an OpenAI and Anthropic compatible API. Use it to power [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), [Cursor](https://www.cursor.com/), or any tool that speaks the OpenAI Chat Completions or Anthropic Messages protocol.

> [!WARNING]
> Reverse-engineered, unofficial, may break. Excessive use can trigger GitHub abuse detection. Use at your own risk.

**Note:** If you're using [opencode](https://github.com/sst/opencode), you don't need this -- opencode supports GitHub Copilot natively.

## Installation

The quickest way to get started is with `npx`:

    npx ghc-proxy@latest start

This starts the proxy on `http://localhost:4141`. It will walk you through GitHub authentication on first run.

You can also install it globally:

    npm install -g ghc-proxy

Or run it from source with [Bun](https://bun.sh/) (>= 1.2):

    git clone https://github.com/wxxb789/ghc-proxy.git
    cd ghc-proxy
    bun install
    bun run dev

## What it does

ghc-proxy sits between your tools and the GitHub Copilot API. It authenticates with GitHub using the device code flow, obtains a Copilot token, and exposes the following endpoints:

**OpenAI compatible:**

- `POST /v1/chat/completions` -- chat completions (streaming and non-streaming)
- `GET /v1/models` -- list available models
- `POST /v1/embeddings` -- generate embeddings

**Anthropic compatible:**

- `POST /v1/messages` -- the Anthropic Messages API, with full tool use and streaming support
- `POST /v1/messages/count_tokens` -- token counting

Anthropic requests are translated to OpenAI format on the fly, sent to Copilot, and the responses are translated back. This means Claude Code thinks it's talking to Anthropic, but it's actually talking to Copilot.

There are also utility endpoints: `GET /usage` for quota monitoring and `GET /token` to inspect the current Copilot token.

## Using with Claude Code

The fastest way to get Claude Code running on Copilot:

    npx ghc-proxy@latest start --claude-code

This starts the proxy, prompts you to pick a model, and copies a ready-to-paste command to your clipboard. Run that command in another terminal to launch Claude Code.

If you prefer a permanent setup, create `.claude/settings.json` in your project:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "deny": ["WebSearch"]
  }
}
```

See the [Claude Code settings docs](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables) for more options.

## CLI commands

ghc-proxy uses a subcommand structure:

    ghc-proxy start          # start the proxy server
    ghc-proxy auth           # run the GitHub auth flow without starting the server
    ghc-proxy check-usage    # show your Copilot usage/quota in the terminal
    ghc-proxy debug          # print diagnostic info (version, paths, token status)

### Start options

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

## Rate limiting

If you're worried about hitting Copilot rate limits, you have a few options:

    # Enforce a 30-second cooldown between requests
    npx ghc-proxy@latest start --rate-limit 30

    # Same, but wait instead of returning a 429 error
    npx ghc-proxy@latest start --rate-limit 30 --wait

    # Manually approve every request (useful for debugging)
    npx ghc-proxy@latest start --manual

## Docker

Build and run:

    docker build -t ghc-proxy .
    mkdir -p ./copilot-data
    docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/ghc-proxy ghc-proxy

The authentication and settings are persisted in `copilot-data/config.json` so authentication survives container restarts.

You can also pass a GitHub token via environment variable:

    docker run -p 4141:4141 -e GH_TOKEN=your_token ghc-proxy

Docker Compose:

```yaml
services:
  ghc-proxy:
    build: .
    ports:
      - "4141:4141"
    environment:
      - GH_TOKEN=your_token_here
    restart: unless-stopped
```

## Account types

If you have a GitHub business or enterprise Copilot plan, pass the `--account-type` flag:

    npx ghc-proxy@latest start --account-type business
    npx ghc-proxy@latest start --account-type enterprise

This routes requests to the correct Copilot API endpoint for your plan. See the [GitHub docs on network routing](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization) for more details.

## How it works

The proxy authenticates with GitHub using the [device code OAuth flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) (the same flow VS Code uses), then exchanges the GitHub token for a short-lived Copilot token that auto-refreshes.

Incoming requests hit a [Hono](https://hono.dev/) server. OpenAI-format requests are forwarded directly to `api.githubcopilot.com`. Anthropic-format requests pass through a translation layer (`src/translator/`) that converts the message format, tool schemas, and streaming events between the two protocols -- including full support for tool use, thinking blocks, and image content.

The server spoofs VS Code headers so the Copilot API treats it like a normal editor session.

## Development

    bun install
    bun run dev          # start with --watch
    bun run build        # build with tsdown
    bun run lint         # eslint
    bun run typecheck    # tsc --noEmit
    bun test             # run tests
