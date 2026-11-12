# ghc-proxy

[![npm](https://img.shields.io/npm/v/ghc-proxy)](https://www.npmjs.com/package/ghc-proxy)
[![CI](https://github.com/wxxb789/ghc-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/wxxb789/ghc-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/wxxb789/ghc-proxy/blob/main/LICENSE)

A proxy that turns your GitHub Copilot subscription into an OpenAI and Anthropic compatible API. Use it to power [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), [Cursor](https://www.cursor.com/), or any tool that speaks the OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages protocol.

> [!WARNING]
> Not affiliated with GitHub. The upstream API is undocumented and may break at any time. Heavy use may be flagged by GitHub's usage systems. **Use at your own risk.**

**TL;DR** — Choose either supported runtime:

```bash
# Bun >= 1.4
bunx --bun ghc-proxy@latest start

# Node.js >= 26
npx ghc-proxy@latest start
```

## Prerequisites

Before you start, make sure you have:

1. **One supported JavaScript runtime:**
   - **Bun >= 1.4:** `winget install --id Oven-sh.Bun` on Windows, or see the [official installation guide](https://bun.com/docs/installation)
   - **Node.js >= 26:** install the latest LTS release from the [official Node.js download page](https://nodejs.org/en/download)
2. **A GitHub Copilot subscription** -- individual, business, or enterprise (or, on Windows only, a Microsoft work account with Microsoft 365 Copilot access for the optional [`--upstream m365`](#microsoft-365-copilot---upstream-m365) target, which needs no GitHub credentials)

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

This asks you to pick two models: a primary model (used for `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_SONNET_MODEL`) and a small model (`ANTHROPIC_DEFAULT_HAIKU_MODEL`). It then prints a ready-to-paste command for your shell that sets those variables along with `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and then runs `claude`, and the proxy starts. Run that command in another terminal to launch Claude Code with the correct configuration. With M365-only or named-account routing, if the default target has no models yet, the proxy skips the command with a warning and starts anyway.

### Option B: Permanent config (Recommended)

Create or edit `~/.claude/settings.json` (this applies globally to all projects):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy-token",
    "ANTHROPIC_MODEL": "claude-opus-5.5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5.5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-5.5",
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

> **Tip:** The model names above (e.g. `claude-opus-5.5`) are mapped to actual Copilot models by the proxy. See [Model Mapping](#model-mapping) below for details.

### Web search

Anthropic server tools (for example `web_search_20250305`, `web_fetch_20250910`) carry no `input_schema`. The proxy accepts that shape at ingress and forwards it unchanged on the native Messages path; it returns no error of its own.

A `400` still appears when the request reaches Copilot: `/v1/messages` answers `The use of the web search tool is not supported.` for the Claude family. The `deny` entry in the config above avoids that upstream error. Pointing Claude Code at a GPT model returns `unsupported_server_tool` instead, because the translated Responses/Chat paths cannot preserve server-side tool execution. OpenAI `web_search` remains available on the native `/responses` boundary.

See the [Claude Code settings docs](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables) for more options.

## CLI Reference

ghc-proxy uses a subcommand structure:

```bash
bunx --bun ghc-proxy@latest start          # Start the proxy server
bunx --bun ghc-proxy@latest auth           # Run GitHub auth flow without starting the server
bunx --bun ghc-proxy@latest auth --account work # Create or replace a named account
bunx --bun ghc-proxy@latest check-usage    # Show your Copilot usage/quota in the terminal
bunx --bun ghc-proxy@latest debug          # Print diagnostic info (version, paths, token status); --json for machine-readable output
bunx --bun ghc-proxy@latest selfcheck      # Probe tokenizer chunks and Bun/Node runtime contracts in the packaged bundle; --json for machine-readable output
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
| `--upstream` | -- | `github` | Upstream API: `github`, or `m365` for the Microsoft 365 Copilot gateway (Windows only; always binds `127.0.0.1`) |
| `--msc-auth-exe` | -- | `GHC_MSC_AUTH_EXE`, else bundled helper | Path to the `msc-auth` helper used by `--upstream m365` |
| `--msc-auth-account` | -- | `config.json` `m365.account`, then `m365.upn`, else the unambiguous broker account | Broker home account ID or exact email from `msc-auth --accounts`; ambiguous emails require the home ID |
| `--claude-code` | `-c` | `false` | Generate a Claude Code launch command |
| `--show-token` | -- | `false` | Display tokens on auth and refresh |
| `--dump-failed-payloads` | `-D` | `false` | Dump failed `/responses` payloads on upstream 400 errors for debugging. Can also be enabled with `DUMP_FAILED_PAYLOADS=1` (or `true`). |
| `--proxy-env` | -- | `false` | Use `HTTP_PROXY`/`HTTPS_PROXY` from env (Node.js only; Bun reads proxy env natively) |
| `--idle-timeout` | -- | `120` | Bun server idle timeout in seconds (`0` disables; Bun max is `255`; streaming routes disable idle timeout automatically) |
| `--upstream-timeout` | -- | `1800` | Upstream request timeout in seconds (`0` disables). Enforced as a total-duration `AbortSignal`. Note both runtimes also apply their own ~300s **idle** timeout to `fetch` (Bun's built-in limit; Node's undici `headersTimeout`/`bodyTimeout`), which fires when no byte arrives for that long — a steadily streaming response is not capped by it, but a stalled one is rejected at ~300s and returned as a `504`. |
| `--upstream-queue-concurrency` | -- | `10` | Maximum concurrent Copilot upstream requests |
| `--upstream-queue-retries` | -- | `1` | Maximum retries across capacity and approved pre-connection failures (`0..2`). Generation requests retry HTTP `429`/`529`; effect-free requests retain the broader transient-status policy |
| `--upstream-recovery-budget` | -- | `60` | Seconds available after the first approved retryable outcome or active-cooldown encounter for all later waits and pre-`Response` attempts (`1..120`) |
| `--upstream-queue-base-delay` | -- | `2` | Base delay in seconds for upstream retry backoff when `Retry-After` is absent |
| `--upstream-queue-max-delay` | -- | `60` | Maximum computed backoff in seconds; never shortens a valid `Retry-After` minimum |
| `--ghe-domain` | `--ghe` | -- | GitHub Enterprise Cloud company domain (e.g. `company.ghe.com`). Required for GHE.com device login on first run; persisted automatically for later runs. |

The five upstream queue/recovery flags override the matching `config.json` fields (`upstreamQueueConcurrency`, `upstreamQueueMaxRetries`, `upstreamRecoveryBudgetSeconds`, `upstreamQueueBaseDelaySeconds`, `upstreamQueueMaxDelaySeconds`); the listed defaults apply only when neither the flag nor the field is set.

### `auth` Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--account` | -- | active account | Named account to create or replace in `credentials.json` |
| `--ghe-domain` | `--ghe` | persisted domain | GitHub Enterprise Cloud company domain (e.g. `company.ghe.com`) |
| `--show-token` | -- | `false` | Display the GitHub token after auth |
| `--verbose` | `-v` | `false` | Enable verbose logging |

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

The proxy normalizes and persists the GHE domain with the credential after a successful authentication, so later `start` runs need no flag. To switch tenants, run `auth --ghe-domain <new-domain>` (add `--account <name>` for a named account). A single-account installation is migrated to named-account routing on its first `start` without `--ghe-domain` or `--github-token`; after that, `start --ghe-domain` is rejected (see [Named Account Routing](#named-account-routing)).

When a GHE domain is in effect (passed with `--ghe-domain` or read from the persisted credential or `config.json`), the default `individual` account type is promoted to `enterprise`, so `--account-type enterprise` is optional for GHE.com.

> **Note:** `--account-type enterprise` alone is not sufficient for GHE.com login — the proxy needs the company domain to construct the correct device login URL (`https://<company>.ghe.com/login/device`). GHE.com support is scoped to `*.ghe.com` only and does not apply to self-hosted GitHub Enterprise Server instances.

### Microsoft 365 Copilot (`--upstream m365`)

A second upstream for the Microsoft 365 Copilot gateway, which serves Claude models over the Anthropic Messages protocol and GPT models over the OpenAI Responses protocol. It uses your own work account through the Windows token broker instead of a GitHub credential.

M365 is a route target beside your GitHub accounts, not a separate mode: one process serves both upstreams on one port, and the request hostname picks the target. Add it from the Dashboard Accounts view — no restart, no second instance, no hosts entry per port. `--upstream m365` still works as a shorthand for an M365-only process.

```bash
bunx --bun ghc-proxy@latest start --upstream m365
```

- **Windows only.** The credential comes from the bundled `msc-auth` helper over WAM/MSAL; the client has no device-code or loopback flow. The helper ships in the npm artifact (`dist/msc-auth/`). Windows source startup (`bun run start`) prepares a complete, current helper automatically; the first local build needs the .NET 10 SDK, C++ build tools, and Windows SDK. A complete `MSC_AUTH_DIR` payload or `--msc-auth-exe` / `GHC_MSC_AUTH_EXE` override avoids compiling. See [helper setup](./msc-auth/README.md#starting-the-proxy-from-source).
- **Broker accounts.** Opening Accounts discovers Windows broker accounts once; Live polling does not repeatedly spawn the helper. Emails and Microsoft tenant IDs are displayed separately from GitHub identities. `msc-auth --accounts` lists `upn<TAB>homeAccountId<TAB>environment`; select an exact email or home ID with `--msc-auth-account`, or use the Dashboard picker, which persists `m365.account`. A profile signed in only inside the Copilot app may not be visible to WAM: use **Sign in another M365 account**, finish the Windows dialog, then apply the selection. Consumer accounts (MSA) do not support this gateway.
- **Gateway endpoint.** The default gateway is `https://loki.delve.office.com/api/v1/llmapi`; `https://df.loki.delve.office.com/api/v1/llmapi` and `https://msit.loki.delve.office.com/api/v1/llmapi` are built-in alternatives. In a process with account management, pick an **Upstream endpoint** or add a **Custom HTTPS endpoint** in Dashboard **Accounts → M365 Copilot target**. The selection is stored in `config.json#m365.endpoint`, extra saved choices in `m365.endpoints`; there is no CLI flag. In an M365-only `start --upstream m365` process (or one started with `--github-token`/`--ghe-domain`) these controls are disabled, so set `m365.endpoint` in `config.json` and restart. Catalog discovery and Messages requests both use the selected endpoint, with no automatic failover. Only select trusted endpoints: the Microsoft access token is sent to the selected address. See [Gateway endpoint selection](./docs/design/m365-upstream.md#gateway-endpoint-selection).
- **Account removal.** Accounts has a **Remove** action for each non-default target. Choose another default before removing the current default; the only remaining target cannot be removed. GitHub removal deletes its local proxy credential and hostname mappings transactionally. Removing M365 deletes its proxy target, not its Windows broker account.
- **Mixed targets.** Register the target once (`accountRouting.hostnames["m365.localhost"] = "m365"`, or the Dashboard section) and point a client at that hostname. Requests that select it are accepted only from the local machine, serve Anthropic Messages and Responses creation only (`/v1/messages`, `/v1/messages/count_tokens`, `/responses`, `/v1/responses`, plus `/`, `/models`, `/v1/models`, `/health`, and the Dashboard; every other path, including Responses resources, `/token`, and `/usage`, answers `400`), and answer `503` with the recorded cause while the account is unavailable. GitHub hostnames are unaffected.
- **Live catalog.** Every built-in gateway serves its catalog at `<endpoint>/models` (the proxy requests the same path on a custom endpoint), and the listed models can differ between gateways. On 2026-11-09 the `loki` catalog returned 10 models: five Claude models on Messages and five GPT models on Responses. The proxy exposes all of them through `http://m365.localhost:4141/models` and `/v1/models`. Claude Code can use a GPT model through `/v1/messages` (translated to Responses), and Responses clients can call `/v1/responses` directly; use the M365 hostname rather than a GitHub hostname. In the Dashboard, the Models view can show the M365 catalog (or any other target's) from whatever hostname the Dashboard was opened on: pick the target, or open `/dashboard#/models?target=m365`. Transient discovery failures may use the built-in catalog, which lists the Claude models only; 401/403 access failures leave the target unavailable instead of reporting it ready.
- **Loopback only when it is the only target.** `--upstream m365` binds `127.0.0.1` because the credential spends your own account's quota; in a mixed process the M365 hostname alone is restricted to loopback peers.

See [M365 Upstream](./docs/design/m365-upstream.md) for the header contract, measured limits, and the family fallbacks applied to unadvertised model names.

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
The name `m365` is reserved for the Microsoft 365 gateway target: a GitHub
credential cannot use it, but `accountRouting.defaultAccount` and `hostnames`
values may select it without a `credentials.json` entry.

An existing single-account installation is automatically migrated at startup.
The credential migrated from the former single-token configuration is named
`default`, and its dedicated hostname is `default-account.localhost`. The
change is persisted transactionally before the server starts accepting
requests. A credential store that already contains multiple accounts but no
`accountRouting` remains in legacy active-account mode; configure its routing
explicitly so no stored account is silently omitted.

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

With that configuration, `http://localhost:4141`, `http://127.0.0.1:4141`, and
the stable dedicated hostname `http://default.localhost:4141` use `default`, while
`http://account1.localhost:4141` uses `account1`. Every routed account must have
exactly one dedicated hostname. The base hostname is an additional alias for
the currently selected default; `127.0.0.1` is a fixed loopback alias for that
same default. Switching the default never changes any dedicated hostname. DNS
hostname matching is case-insensitive, ignores the request port, and accepts a
trailing root dot. Any other hostname is rejected with HTTP `421` before a route handler or
upstream request runs. `Forwarded` and `X-Forwarded-Host` are not trusted for
account selection.

Each account has independent GitHub/Copilot tokens, refresh scheduling, model
cache, Responses emulator state, local rate limiter, and upstream queue/cooldown
state. A failure or capacity response on one account never switches, falls back,
rotates, or load-balances the request to another account. Process-wide policy
configuration remains shared.

`accountRouting` is automatically created only when the existing credential
store contains exactly one account. In routing mode every referenced GitHub account must already exist in `credentials.json`, and
`defaultAccount` must be explicit. Invalid or ambiguous routing config fails
startup. Dashboard bootstrap is unavailable while process-wide
`start --github-token` or `start --ghe-domain` overrides are active, and those
overrides are rejected once routing is enabled because they cannot identify one
named account. Hostname routing is a deterministic selector, not an
authorization boundary: callers that can reach the listener and choose a
configured `Host` can select that account unless access is enforced separately.

For Docker deployments, leave `GH_TOKEN` unset in routing mode and mount the
populated credential/config directory. The image healthcheck reads
`accountRouting.baseHostname`, applies the same DNS ASCII/case/root-dot
normalization, and sends it as `Host` while connecting over loopback, so health
checks continue to exercise the configured base hostname rather than the
`127.0.0.1` default alias.

All fields are optional. The full schema:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `modelRewrites` | `{ from, to }[]` | `[]` | Glob-pattern model substitution rules (see [Model Rewrites](#model-rewrites)) |
| `modelFallback` | `object` | built-in family defaults | Override default model fallbacks (see [Customizing Fallbacks](#customizing-fallbacks)) |
| `modelFallback.claudeOpus` | `string` | `claude-opus-5.5` | Fallback for `claude-opus-*` models |
| `modelFallback.claudeSonnet` | `string` | `claude-sonnet-5.5` | Fallback for `claude-sonnet-*` models |
| `modelFallback.claudeHaiku` | `string` | `claude-haiku-5.5` | Fallback for `claude-haiku-*` models |
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
| `responsesChatCompletionsFallback` | `boolean` | `false` | Opt in to the Responses create bridge for models that advertise `/chat/completions` but not `/responses` |
| `responsesOfficialEmulatorTtlSeconds` | `number` | `14400` | In-memory TTL for locally emulated Responses state |
| `modelReasoningEfforts` | `Record<string, string>` | `{}`; unlisted models use `high` | Per-model reasoning effort defaults for Anthropic-to-Responses translation. Each value must be one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` (ascending) |
| `upstreamQueueConcurrency` | `number` | `10` | Maximum concurrent upstream requests per route target (each named account has its own queue) |
| `upstreamQueueMaxRetries` | `number` | `1` | Maximum retries across capacity and approved pre-connection failures (`0..2`) |
| `upstreamRecoveryBudgetSeconds` | `number` | `60` | Shared recovery deadline after the first retryable outcome or active-cooldown encounter (`1..120` seconds) |
| `overloadFallbacks` | `Record<string, string>` | `{}` (disabled) | Exact effective-model mappings for one opt-in fallback dispatch after terminal model `529` |
| `upstreamQueueBaseDelaySeconds` | `number` | `2` | Base delay (seconds) for upstream retry backoff when `Retry-After` is absent |
| `upstreamQueueMaxDelaySeconds` | `number` | `60` | Maximum computed backoff (seconds); does not clamp `Retry-After` |
| `gheDomain` | `string` | unset | Legacy single-account GHE.com company domain, updated whenever a login runs without `auth --account`. Once `credentials.json` exists, the active credential's own `gheDomain` takes precedence; this field still applies to `start --github-token` and to migrating a legacy `config.json` token. Named accounts in `accountRouting` always use their credential's `gheDomain` |
| `m365` | `{ account?, upn?, endpoint?, endpoints? }` | unset | Microsoft 365 Copilot target settings, used by `--upstream m365` and by an `m365` route target in a mixed process: `account` is the broker home account id from `msc-auth --accounts` (`--msc-auth-account` overrides it); `upn` is an exact broker account email, used only when no account is set (an email that matches no broker account, or more than one, leaves the target unavailable); `endpoint` is the selected HTTPS gateway (default `https://loki.delve.office.com/api/v1/llmapi`); `endpoints` lists extra saved gateway choices. Invalid `m365` settings fail startup |
| `accountRouting` | `{ baseHostname, defaultAccount, hostnames }` | unset | Automatically created for legacy single-account installs; exact DNS hostname routing rejects unknown hosts |

Example:

```json
{
  "modelRewrites": [
    { "from": "claude-haiku-*", "to": "gpt-4.1-mini" }
  ],
  "modelFallback": {
    "claudeOpus": "claude-opus-5.5",
    "claudeSonnet": "claude-sonnet-5.5"
  },
  "smallModel": "gpt-4.1-mini",
  "compactUseSmallModel": true,
  "useFunctionApplyPatch": true,
  "responsesApiAutoCompactInput": false,
  "responsesApiAutoContextManagement": false,
  "responsesApiContextManagementModels": ["gpt-5", "gpt-5-mini"],
  "chatCompletionsUseMaxCompletionTokens": [],
  "responsesOfficialEmulator": false,
  "responsesChatCompletionsFallback": false,
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
| `claude-opus-*` | `claude-opus-5.5` |
| `claude-sonnet-*` | `claude-sonnet-5.5` |
| `claude-haiku-*` | `claude-haiku-5.5` |

### Customizing Fallbacks

You can override the defaults with **environment variables**:

```bash
MODEL_FALLBACK_CLAUDE_OPUS=claude-opus-5.5
MODEL_FALLBACK_CLAUDE_SONNET=claude-sonnet-5.5
MODEL_FALLBACK_CLAUDE_HAIKU=claude-haiku-5.5
```

Or in the proxy's **config file** (`~/.local/share/ghc-proxy/config.json`):

```json
{
  "modelFallback": {
    "claudeOpus": "claude-opus-5.5",
    "claudeSonnet": "claude-sonnet-5.5",
    "claudeHaiku": "claude-haiku-5.5"
  }
}
```

> **Note:** Model fallbacks apply only inside the **Chat Completions adapter** used by the Messages fallback path and by `/v1/messages/count_tokens`; native Messages and Responses strategies pass the model ID through to Copilot unchanged. With no override for a family, its previous default (`claude-opus-5`, `claude-sonnet-5`, or `claude-haiku-4.5`) is selected only when cached models advertise it but omit the 5.5 default.
>
> The M365 target is an exception: when no `modelRewrites` rule matches, unadvertised `claude-opus-*`, `claude-sonnet-*`, and `claude-haiku-*` IDs are mapped to `claude-opus-5.5`, `claude-sonnet-5.5`, and `claude-haiku-5.5` before strategy selection, and `MODEL_FALLBACK_*` / `modelFallback` are ignored (see [M365 family fallbacks](./docs/design/m365-upstream.md#family-fallbacks)).

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

Unlike model fallbacks (which only apply to the chat completions path), rewrites are applied **uniformly** to `/v1/messages`, `/v1/chat/completions`, `/v1/responses`, and `/v1/decisions`. The token-counting routes (`/v1/messages/count_tokens` and `/v1/responses/input_tokens`) do not apply rewrites. Target model names are normalized against Copilot's known model list using dash/dot equivalence (e.g. `gpt-4.1` matches `gpt-4-1`). The same correction applies to the requested model ID when no rule matches, even without any `modelRewrites`.

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

An upstream `429` establishes an account cooldown. A `529` is scoped to the final effective upstream model; if no effective model is known, it remains request-only. Eligible models can bypass cooled waiters while one of the account's slots is free, but active slots and the maximum pending depth are still shared by every model on that account. Each account has its own queue; all queues use the same configured settings, but occupancy and cooldowns never cross accounts.

The first attempt keeps the normal upstream timeout. The recovery budget starts at the first approved retryable outcome or the first encounter with an already-active cooldown, then covers every later cooldown/backoff wait, queue acquisition, same-model attempt until `Response`, and overload fallback. A valid integer-seconds, HTTP-date, or full-string fractional-seconds `Retry-After` is a strict lower bound and installs its full cooldown deadline. If that minimum cannot fit, the proxy skips the same-model retry instead of shortening it. Without a valid header, full jitter is sampled from zero through the smallest of exponential backoff, `upstreamQueueMaxDelaySeconds`, and remaining budget.

Generation requests additionally retry only measured pre-connection shapes: Bun `ConnectionRefused`, or Node `ECONNREFUSED`, `ENOTFOUND`, and `EAI_AGAIN`. Caller aborts, every timeout, TLS/configuration failures, resets, generic fetch errors, body failures, and stream failures are excluded. Once `fetch()` returns a `Response`, that attempt is committed: a later JSON/SSE/body failure is never replayed or sent to fallback.

Recovery logs use the existing request ID and structured fields such as event, retry count, status/connection class, effective model, scope, active/max slots, pending/max depth, queue wait, delay source/delay, elapsed/remaining budget, `nextRetryAt`, and decision. Public responses keep protocol-compatible payloads and only safe standard metadata such as `Retry-After`; no retry-progress SSE event or recovery payload extension is added. Per inbound request, the attempt ceiling is `1 + upstreamQueueMaxRetries + at most one configured fallback`; outer SDK retries multiply that ceiling independently.

## Small-Model Routing

`/v1/messages` can optionally reroute specific low-value requests to a cheaper model:

- `smallModel`: the model to reroute to
- `compactUseSmallModel`: reroute recognized compact/summarization requests

The switch defaults to `false`. Routing is conservative:

- both the requested model (after any `modelRewrites` / dash-dot correction) and the target `smallModel` must exist in Copilot's model list
- it must preserve the original model's declared endpoint support
- tool, thinking, and vision requests are not rerouted to a model that lacks the required capabilities
- requests with an extended-context `anthropic-beta` value of the form `context-<N>k-…` or `context-<N>m-…` (e.g. `context-1m-2025-08-07`) are never rerouted; other `context-` betas such as `context-management-*` do not block rerouting

A request counts as a compact request when its system prompt (a string, or any text block of a system block array) starts with the summarization prefix `You are a helpful AI assistant tasked with summarizing conversations`, which Claude Code sends for compaction.

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

Each request's hostname selects a route target. Besides GitHub Copilot accounts, a target can be the Microsoft 365 Copilot gateway (default `https://loki.delve.office.com/api/v1/llmapi`). That target authenticates with your Windows work account through the bundled `msc-auth` helper and the Windows token broker (WAM) instead of GitHub device flow, serves Anthropic Messages and OpenAI Responses (create), and is reachable from loopback peers only. See [Microsoft 365 Copilot](#microsoft-365-copilot---upstream-m365).

When the Copilot token response includes `endpoints.api`, `ghc-proxy` now prefers that runtime API base automatically instead of relying only on the configured account type. This keeps enterprise/business routing aligned with the endpoint GitHub actually returned for the current token.

Incoming requests hit an [Elysia](https://elysiajs.com/) server. `chat/completions` requests are validated, normalized into the shared planning pipeline, and then forwarded to Copilot. `responses` requests use native Responses when the selected model advertises `/responses`, or an explicitly enabled Responses-to-Chat bridge when it advertises only `/chat/completions`. `messages` requests are routed per-model and can use native Anthropic passthrough, the Responses translation path, or the existing chat-completions fallback. The translator tracks exact vs lossy vs unsupported behavior explicitly; see the [Messages Routing and Translation Guide](./docs/messages-routing-and-translation.md) and the [Anthropic Translation Matrix](./docs/anthropic-translation-matrix.md) for the current support surface.

The built-in Dashboard projects process health, named account status, model routing, behavior, and recent request lifecycle metadata without storing request or response content. Legacy single-account startup automatically migrates to named routing; its protected Accounts view can then authenticate a new account with a dedicated hostname and switch the default account. See [Dashboard Observability](./docs/design/dashboard-observability.md).

For Anthropic `search_result` blocks, an April 17, 2026 probe against `claude-opus-4.6` on Copilot native `/v1/messages` accepted top-level search results and pure search-result tool outputs, but rejected top-level `citations` and mixed text/search-result tool output arrays. The native path sanitizes those observed rejection cases, while translated paths flatten search results to text; re-run the probe before treating that dated upstream result as universal.

### Request Routing

`ghc-proxy` does not force every request through one protocol. The current routing rules are:

- `POST /v1/chat/completions`: OpenAI Chat Completions -> shared planning pipeline -> Copilot `/chat/completions`
- `POST /v1/decisions`: OpenAI Decisions -> Copilot `/v1/decisions` passthrough for models advertising it (e.g. `gpt-6-luna-decisions`), or direct JSON translation to `/v1/systemone` for System One models (e.g. `microsoft-decision-1`); no streaming, strategy, or overload fallback
- `POST /v1/images/generations` and `/v1/images/edits`: OpenAI Images -> the matching advertised Copilot Images endpoint; image-only models do not use the chat or Messages fallback
- `POST /v1/responses`: OpenAI Responses create -> native Responses handler -> Copilot `/responses`, or (with `responsesChatCompletionsFallback: true`) Responses-to-Chat translation -> Copilot `/chat/completions` for Chat-only models
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
| `POST` | `/v1/decisions` | OpenAI Decisions, passed through to `/v1/decisions` or translated to System One (`/v1/systemone`), per model |
| `POST` | `/v1/responses` | Create a Responses API response |
| `POST` | `/v1/responses/input_tokens` | Count Responses input tokens via upstream passthrough or the local official emulator |
| `GET` | `/v1/responses/:responseId` | Retrieve one response via upstream passthrough or the local official emulator |
| `GET` | `/v1/responses/:responseId/input_items` | Retrieve response input items via upstream passthrough or the local official emulator |
| `DELETE` | `/v1/responses/:responseId` | Delete one response via upstream passthrough or the local official emulator |
| `GET`  | `/v1/models` | List available models |
| `POST` | `/v1/embeddings` | Generate embeddings |
| `POST` | `/v1/images/generations` | Generate images from a JSON prompt; JSON or SSE response |
| `POST` | `/v1/images/edits` | Edit images using JSON references or multipart uploads; JSON or SSE response |

**Anthropic compatible:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Messages API with per-model routing across native Messages, Responses translation, or chat-completions fallback |
| `POST` | `/v1/messages/count_tokens` | Token counting |

**Utility:**

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/` | Plain-text `Server running` check |
| `GET`  | `/health` | Liveness/readiness probe — returns `{ status, copilotToken, modelsLoaded, version }` |
| `GET`  | `/usage` | Copilot quota / usage monitoring |
| `GET`  | `/token` | Inspect the current Copilot token |

**Local Dashboard:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dashboard` | Dashboard application (views are addressed by the URL hash, e.g. `/dashboard#/accounts`) |
| `GET` | `/dashboard/assets/app.js` | Dashboard client script |
| `GET` | `/dashboard/assets/app.css` | Dashboard stylesheet |
| `GET` | `/dashboard/theme-init.js` | Dashboard theme bootstrap script (runs before first paint) |
| `GET` | `/dashboard/api/overview` | Process, authentication, quota, request, and queue summary |
| `GET` | `/dashboard/api/models` | Upstream model metadata and effective proxy capabilities for the target the request hostname routes to, or for another route target (including M365) with `?target=<name>`; an unknown target returns `404` |
| `GET` | `/dashboard/api/behavior` | Active routing, compatibility policies, strategies, and effect counters |
| `GET` | `/dashboard/api/requests` | Active requests and the most recent 256 completed request summaries |
| `GET` | `/dashboard/api/accounts` | Safe per-account identity, tenant, authentication, Copilot status, quota, hostname, and default marker |
| `POST` | `/dashboard/api/accounts/bootstrap` | Compatibility bootstrap for an existing legacy account manager |
| `POST` | `/dashboard/api/accounts` | Start device authentication for a new named account and its dedicated hostname |
| `GET` | `/dashboard/api/account-auth/:id` | Read the safe state of an in-progress account authentication |
| `POST` | `/dashboard/api/accounts/default` | Persist and activate an explicit default account |
| `DELETE` | `/dashboard/api/accounts/:accountName` | Remove a non-default target (the current default and the only remaining target cannot be removed) |
| `POST` | `/dashboard/api/refresh` | Force a metadata refresh for every routed target (GitHub: identity, quota, and models; M365: models) |
| `GET` | `/dashboard/api/m365` | M365 target state: registration, gateway endpoint and choices, hostname, broker account, models, availability, and routing |
| `POST` | `/dashboard/api/m365/probe` | Check platform and `msc-auth` helper readiness, and list Windows broker (WAM) accounts |
| `POST` | `/dashboard/api/m365/sign-in` | Sign in another M365 account through WAM (returns the account identity, never a token) |
| `POST` | `/dashboard/api/m365/register` | Register the M365 target (account, hostname, gateway endpoint) |
| `POST` | `/dashboard/api/m365/remove` | Remove the M365 proxy target (not the Windows broker account) |
| `POST` | `/dashboard/api/m365/account` | Select the M365 broker account |
| `POST` | `/dashboard/api/m365/hostname` | Change the M365 target hostname |
| `POST` | `/dashboard/api/m365/endpoint` | Select the M365 gateway endpoint and optionally save the list of endpoint choices |

Dashboard routes are restricted to local access and return `403` when the peer, request host, or supplied `Origin` fails the loopback/same-origin checks. A normal legacy single-account process automatically migrates to named routing at startup, so adding accounts and changing the default are available after startup. Account management returns `409` when it is unavailable for the process: with legacy `start --github-token` or `start --ghe-domain` overrides (they cannot be assigned safely), in an M365-only `start --upstream m365` process, or for a legacy `credentials.json` without `accountRouting` that holds more than one account or whose active account name is not routing-compatible. With `accountRouting` configured, `--github-token` and `--ghe-domain` are startup errors. Dashboard requests are excluded from request history and access logging. See [Dashboard Observability](./docs/design/dashboard-observability.md) for the projection, transaction, and security contract.

> **Note:** The `/v1/` prefix is optional for OpenAI-compatible endpoints (`/chat/completions`, `/decisions`, `/responses` and its resource routes, `/models`, `/embeddings`, `/images/generations`, `/images/edits`). Anthropic endpoints (`/v1/messages`, `/v1/messages/count_tokens`) require the `/v1` prefix. The utility and Dashboard endpoints are root-only and not exposed under `/v1`.

## Images

Use the Images endpoints for models such as `gpt-image-2.5-flare` that advertise
`/v1/images/generations` or `/v1/images/edits` in the Dashboard. Image-only
models show `Messages route: unavailable`; sending them to Chat Completions or
Messages returns `400` rather than attempting a chat fallback.

Generate an image:

```bash
curl http://localhost:4141/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-image-2.5-flare","prompt":"A watercolor fox in a snowy forest","size":"1024x1024"}'
```

Edit uploaded images (repeat `image[]` for multiple inputs; add `mask=@mask.png`
when needed):

```bash
curl http://localhost:4141/v1/images/edits \
  -F model=gpt-image-2.5-flare \
  -F 'prompt=Replace the background with a snowy forest' \
  -F 'image[]=@source.png'
```

Edits also accept JSON with `images: [{"image_url":"data:image/png;base64,..."}]`
or `file_id` references. References are passed upstream; the proxy does not host
a Files API or resolve uploaded file IDs. An explicit model uses the normal
model rewrite rules and must advertise the requested Images endpoint. Omitting
or nulling the edit model leaves the default selection to Copilot.

JSON responses preserve upstream image data (including `b64_json`) and usage.
Set JSON `stream: true`, or multipart `stream=true`, for SSE; image event names,
IDs, and data pass through without chat translation. A stream read failure or
upstream timeout emits an SSE `error` event; a caller disconnect does not.
Optional image parameters
are preserved for upstream validation, not filtered through chat-model rules.
Requests reuse account selection, request approval/rate limiting, upstream
timeouts, and cancellation. Only upstream `429`/`529` capacity refusals can be
retried; a `5xx` or failure after response headers never replays image generation.

The public shape follows the [OpenAI Images API](https://platform.openai.com/docs/api-reference/images).
Local verification uses a simulated upstream, not a quota-consuming Copilot
image-generation probe; account access and model-specific options remain subject
to the live Copilot service.

## Responses Compatibility

`/v1/responses` is designed to stay close to the OpenAI wire format while making Copilot limitations explicit:

- requests are validated before any mutation
- client-supplied `top_k` is rejected with `400` on the OpenAI Chat Completions and Responses boundaries because neither official OpenAI schema defines it; clients that send it by mistake receive an explicit error instead of a silent drop. Anthropic Messages `top_k` remains supported and is preserved when the proxy translates that request internally for Copilot
- common official request fields such as `conversation`, `previous_response_id`, `max_tool_calls`, `truncation`, `user`, `prompt`, and `text` are now modeled explicitly instead of relying on loose passthrough alone
- official `text.format` options are modeled explicitly, including `text`, `json_object`, and `json_schema`
- `responsesChatCompletionsFallback` is opt-in and native-first: a model advertising `/responses` always stays on the native strategy; a Chat-only model is eligible only when it advertises `/chat/completions`. `responsesAvailable` and `upstream.endpoints` continue to describe native/upstream facts, while Dashboard `defaultResponsesStrategy` identifies the effective translated strategy
- an opt-in `responsesOfficialEmulator` mode adds in-memory OpenAI-style state for `previous_response_id`, `conversation`, `GET /responses/{id}`, `GET /responses/{id}/input_items`, `DELETE /responses/{id}`, and `POST /responses/input_tokens`
- emulator state is memory-only and expires after `responsesOfficialEmulatorTtlSeconds` (default `14400`, or 4 hours)
- `background: true` is rejected explicitly while emulator mode is enabled
- `custom` `apply_patch` can be rewritten as a function tool when `useFunctionApplyPatch` is enabled
- automatic Responses `context_management` injection is disabled by default and only applies when `responsesApiAutoContextManagement` is `true` and the model matches `responsesApiContextManagementModels`
- automatic trimming of Responses `input` to the latest `compaction` item is disabled by default and only applies when `responsesApiAutoCompactInput` is `true`
- reasoning defaults for Anthropic -> Responses translation can be tuned with `modelReasoningEfforts`
- request parameters that a model rejects (e.g. `temperature`/`top_p` on reasoning models) are stripped on the Responses boundary rather than leaked upstream as a `400`; see [Responses Parameter Filters](#responses-parameter-filters)
- a `max_output_tokens` below Copilot's floor of `16` is raised to `16` on the native `/v1/responses` path and the `/v1/messages` -> Responses path (not the Chat bridge) instead of being leaked upstream as a `400`
- a `reasoning.effort` that the resolved model does not list in its advertised `reasoning_effort` levels is replaced with the highest level it does advertise, with a warning logged; this applies on the native path and the Chat bridge. `none` and `minimal` pass through unchanged, and models that advertise no effort levels are left untouched
- built-in web search (`web_search`, `web_search_preview`, and their dated variants) is forwarded to Copilot rather than blocked; every `/responses` model reached by the August 4, 2026 acceptance sweep accepted the tool, while functional search execution was verified on `gpt-5.6-sol` and `gpt-5.6-terra`, see [docs/research/responses-web-search.md](docs/research/responses-web-search.md)
- external image URLs on the native Responses path fail explicitly with `400`; the opt-in Chat bridge accepts only HTTP(S) or data URLs when the target's vision capability is eligible
- official `input_file` and `item_reference` input items are modeled explicitly and validated, but the verified Copilot GPT Responses boundary is stateless: it rejects `store: true` and cannot resolve returned item IDs on later requests. The proxy deliberately applies a proxy-wide `store: false` policy, removes all `item_reference` items before dispatch, and removes `function_call_output` items whose `call_id` has no matching `function_call` in the same input array. Without the optional emulator, a caller that requested storage still receives a successful stateless response; retrieve/delete/continuation semantics are available only from the local emulator. The output-only `phase` annotation (`commentary` / `final_answer`) is also stripped from input message items before dispatch, on the native `/v1/responses` path and the `/v1/messages` -> Responses path, because some models reject it as input with a `400`

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

### Responses via Chat Completions

The create operation can be translated through Copilot Chat Completions for a
model that does not advertise `/responses`:

```json
{
  "responsesChatCompletionsFallback": true
}
```

The bridge reuses the CAPI planning pipeline and translates ordinary text,
instructions, message history, supported HTTP/data-URL images, function tools,
and custom text tools. Namespaced tools use a request-local bounded alias map;
custom text is carried through a reversible JSON `{ "input": "..." }`
wrapper. `apply_patch` uses the existing `useFunctionApplyPatch` gate and is
explicitly lossy. JSON mode maps to Chat JSON mode. JSON Schema and function
`strict` are accepted only when the selected model metadata and internal CAPI
wire type can preserve them. Translation warnings are observable; unsupported
intent fails with a client-facing `400` instead of being silently dropped.

The bridge is a proxy compatibility path, not upstream native Responses
support. It does not execute hosted tools, resolve prompt templates or files,
invent encrypted reasoning state, provide remote compaction, or add a second
state store. `conversation`, `previous_response_id`, and `store` continuation
are available only through the existing account-scoped local Responses
emulator. Without the emulator, a bridged request must send `store: false`
explicitly; omitting `store` (OpenAI's default is `true`) or sending `true`
returns `400` (`unsupported_responses_state`), unlike the native path, which
forces `store: false` and succeeds statelessly. The bridge covers `POST /responses` and `/v1/responses` create only;
`input_tokens`, retrieve, input-items, and delete keep their existing
native/emulator behavior. Enabling the flag is not evidence of Gemini model
quality or complete Codex long-session compatibility; those claims require a
pinned client fixture and separate verification.

### Responses Parameter Filters

Some Copilot models reject request parameters that the OpenAI wire format allows. The clearest case: **reasoning models** (the `gpt-5` family, o-series, codex) reject sampling parameters and answer `POST /responses` with `400 Unsupported parameter: 'temperature' is not supported with this model.` Since the client cannot always be changed, the proxy strips the offending parameters on the Responses boundary instead of leaking the incompatibility outward.

This is expressed as a small rule engine that runs on both the native `/v1/responses` path and the `/v1/messages` → Responses translation path. It does not apply to requests served through the [Responses via Chat Completions](#responses-via-chat-completions) bridge, which forwards `temperature`/`top_p` to Chat Completions unchanged:

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

Pre-built multi-arch images (`linux/amd64`, `linux/arm64`) are available on GHCR. Each release is tagged `latest`, `vX.Y.Z`, `vX.Y`, and `vX` (with the `v` prefix), for example `ghcr.io/wxxb789/ghc-proxy:v0.12.1`:

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

If the first container argument begins with `-` (other than the legacy `--auth`), the entrypoint passes the arguments to `start`: `docker run ... ghcr.io/wxxb789/ghc-proxy --verbose --rate-limit 30` runs `start --verbose --rate-limit 30`, and in Compose you can use `command: ["--verbose"]`. Other subcommands run as given, for example `docker run --rm ghcr.io/wxxb789/ghc-proxy selfcheck --json`.

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
Install dev dependencies when building from source: `gpt-tokenizer` is a
build-time dependency whose five encodings are still bundled into the published
runtime for the local count endpoints and packaged `selfcheck`.

```bash
git clone https://github.com/wxxb789/ghc-proxy.git
cd ghc-proxy
bun install
bun run dev              # Start with --watch
# Or use the production-style source command:
bun run start
```

A source checkout serves the Dashboard only after `bun run build:ui` (or a full
`bun run build`) has embedded it; until then `/dashboard` answers `503` with
that instruction. The JSON API under `/dashboard/api/` works either way.

On Windows, `bun run start --port 4141` also prepares `dist/msc-auth/msc-auth.exe`
and `msalruntime.dll` before loading the production-style source CLI. Repeated
starts reuse an unchanged payload. The helper's compiler prerequisites are source
tooling only; a release or complete explicit helper payload does not need .NET.

## Development

```bash
bun install              # Install dependencies, including build-time tokenizer sources
bun run dev              # Start with --watch
bun run start            # Start without --watch
bun run build            # Build the Dashboard UI, bundle with tsdown, then build:msc-auth
                         # (Windows publishes the helper with the .NET 10 SDK; MSC_AUTH_DIR copies a prebuilt one; skipped elsewhere)
bun run build:ui         # Build and embed only the Dashboard UI (Svelte + Vite)
bun run dev:ui           # Vite dev server for the Dashboard; proxies /dashboard/api to 127.0.0.1:4141
bun run lint             # ESLint (cached)
bun run lint:all         # Full ESLint scan (what CI runs)
bun run typecheck        # tsc --noEmit plus svelte-check for ui/
bun test --path-ignore-patterns='**/token-file-removal.test.ts' --path-ignore-patterns='**/token-refresh-retry.test.ts' \
  && bun test tests/token-file-removal.test.ts tests/token-refresh-retry.test.ts
                         # Run tests, split as in CI (module mocks leak across files in one process)
bun run test:ui          # Dashboard UI tests (Vitest + jsdom)
bun run smoke:packaged   # Selfcheck the packaged CLI under Bun and Node (after bun run build; needs node and npm on PATH; no upstream quota)
bun run matrix:live      # Real Copilot upstream compatibility matrix
bun run matrix:live --vision-only --all-responses-models --json
bun run matrix:live --stateful-only --json --model=gpt-5.2-codex
```

> **Note:** `bun run matrix:live` uses your configured GitHub/Copilot credentials and spends real upstream requests. Use it when you want end-to-end verification against the current Copilot service, not for every local edit; for a no-quota sanity check, use the test commands above or `bun run smoke:packaged`.
>
> Useful flags:
> - `--json`: emit machine-readable JSON only
> - `--vision-only`: run just the Responses image probes
> - `--stateful-only`: run follow-up/resource probes such as `previous_response_id`, `input_tokens`, and `input_items`
> - `--all-responses-models`: scan every model that advertises `/responses`
> - `--model=<id>`: pin the Responses scan to one specific model

### Tool Support Probe

Answers whether a tool **works**, not merely whether upstream returns `200` when you mention it. For each (model × tool) it declares the tool, then — unless `--accept-only` — sends a prompt that cannot be answered without it and looks in the response for proof it ran.

Verdicts: `supported` (the tool ran or was called), `inert` (accepted but never invoked), `unsupported` (upstream rejected it), `accepted` (`--accept-only` only: declaration accepted, functional pass skipped). Two labels mark cells with no verdict: `unmeasured` (capacity/gateway fault) and `error` (transport failure); re-run those cells before publishing.

> **Note:** like `matrix:live`, this probe uses your configured GitHub/Copilot credentials and spends real Copilot quota: up to two requests per (model × tool), or one with `--accept-only`, sent sequentially; each request is retried up to twice on capacity/gateway faults.

```bash
bun scripts/probes/tool-support.ts                       # both boundaries
bun scripts/probes/tool-support.ts --json                # JSON snapshot to stdout
bun scripts/probes/tool-support.ts --model=claude-opus-5 # single model
bun scripts/probes/tool-support.ts --boundary=responses  # or: messages
bun scripts/probes/tool-support.ts --accept-only         # skip the functional pass (half the quota)
bun scripts/probes/tool-support.ts --names               # also probe client tool NAMES (WebSearch, shell, ...)
```

Latest results: [docs/research/builtin-tool-support.md](docs/research/builtin-tool-support.md).

The JSON output is designed for weekly diffing. Besides `generatedAt`, the per-cell `evidence` quote (the model's own text) changes between runs, so strip both:

```bash
# Compare two weekly snapshots
strip='del(.generatedAt) | walk(if type == "object" then del(.evidence) else . end)'
diff <(jq -S "$strip" week1.json) <(jq -S "$strip" week2.json)
```
