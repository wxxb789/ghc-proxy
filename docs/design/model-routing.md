# Model Resolution and Routing

This document describes how ghc-proxy resolves model identifiers and routes requests to the appropriate execution path.

## Model Resolution

### Fallback Chain

When a client requests a model ID (e.g., `claude-sonnet-4.6`), the resolver checks:

1. **Exact match** -- If the model ID exists in Copilot's cached model list, use it directly
2. **Family fallback** -- If no exact match, map by model family prefix:
   - `claude-opus-*` → configured `claudeOpus` fallback
   - `claude-sonnet-*` → configured `claudeSonnet` fallback
   - `claude-haiku-*` → configured `claudeHaiku` fallback
3. **Pass-through** -- If no family match, forward the ID as-is (let upstream reject it)

### Configuration

Fallbacks can be configured via environment variables or config file (`~/.local/share/ghc-proxy/config.json`):

```text
MODEL_FALLBACK_CLAUDE_OPUS      → config.modelFallback.claudeOpus
MODEL_FALLBACK_CLAUDE_SONNET    → config.modelFallback.claudeSonnet
MODEL_FALLBACK_CLAUDE_HAIKU     → config.modelFallback.claudeHaiku
```

Default fallbacks:
```text
claudeOpus:   claude-opus-5
claudeSonnet: claude-sonnet-5
claudeHaiku:  claude-haiku-4.5
```

### Overload Fallback

Overload fallback is not the missing-model fallback above. It starts only after normal model rewrite, compact routing, and family resolution have produced a valid final effective source model that reaches a terminal `529` or is already locally cooled.

`config.json` may opt in with exact advertised IDs:

```json
{
  "overloadFallbacks": {
    "claude-opus-5": "claude-opus-4.8"
  }
}
```

There is no default mapping. A target must differ from the source, exist in the cached advertised model list, not be behind an account or target-model cooldown, and satisfy the request's endpoint, tool, parallel-tool, streaming, vision, reasoning/thinking, and structured-output requirements. `/responses` targets must advertise `/responses`; Messages re-runs its normal strategy registry for the selected target.

The pipeline rebuilds the fallback attempt from pristine post-ingest input, reapplies target-dependent transforms and capability checks, and appends `OVERLOAD_FALLBACK` as the last model trace step. It dispatches once without a new retry allowance. Successful JSON/SSE output and persisted Responses emulator records disclose the actual target model. Preflight rejection preserves the source `529`; once target fetch starts, any target failure is final.

Mappings are exact one-hop choices, not a fallback graph. Reciprocal mappings are valid because a request never follows a second edge. Fallback does not run for account `429`, connection failures, timeouts, cancellation, other HTTP statuses, validation failures, or failures after any upstream `Response` has committed.

## Model Capabilities

The proxy queries each model's metadata from Copilot's model list to determine:

| Capability              | Used For                                             |
|-------------------------|------------------------------------------------------|
| `supported_endpoints`   | Strategy selection (which execution path to use)     |
| `tool_calls`           | Whether tools can be forwarded                       |
| `vision`               | Whether image inputs are supported                   |
| `adaptive_thinking`    | Whether to fill thinking config                      |
| Vision limits          | Max image tokens, max images per request             |

### Model Endpoint Map

Claude `/v1/messages` rows re-probed **2026-07-25** (enterprise endpoint `api.enterprise.githubcopilot.com`); `/responses` and `/chat/completions` rows are the **2026-06-17** baseline and may be stale. Live surface is volatile — re-run the probe scripts before trusting.

| Model | Endpoints | Notes |
|-------|-----------|-------|
| `claude-opus-5` | `/v1/messages`, `/chat/completions` | 1000k ctx; `adaptive_thinking`; ~1K cache threshold |
| `claude-opus-4.8` | `/v1/messages`, `/chat/completions` | 1000k ctx |
| `claude-opus-4.7` / `-high` / `-xhigh` | `/v1/messages`, `/chat/completions` | 1000k ctx; `-xhigh` has 8K cache threshold |
| `claude-opus-4.6` | `/v1/messages`, `/chat/completions` | 1000k ctx |
| `claude-sonnet-5` | `/v1/messages`, `/chat/completions` | 1000k ctx; `adaptive_thinking`; Anthropic-native (accepts bm25 tool search) |
| `claude-sonnet-4.6` | `/v1/messages`, `/chat/completions` | 1000k ctx; Bedrock-served (rejects bm25) |
| `claude-sonnet-4.5` | `/v1/messages`, `/chat/completions` | 200k ctx; no `adaptive_thinking`/effort |
| `claude-haiku-4.5` | `/v1/messages`, `/chat/completions` | 200k ctx; no `adaptive_thinking`/effort |
| `gpt-5.5` | `/responses` | 1050k ctx; same tool support as gpt-5.4 |
| `gpt-5.4` / `-mini` | `/responses` | 1050k / 400k ctx |
| `gpt-5.3-codex` | `/responses` | 400k ctx |
| `gemini-3.5-flash` | `/chat/completions` | 1000k ctx |
| `gemini-3.1-pro-preview` | `/chat/completions` | 1000k ctx |

`claude-opus-5` / `claude-sonnet-5` are the default `claude-opus-*` / `claude-sonnet-*` fallbacks; both are live known models, so exact-match resolution returns them directly (the fallback branch never fires for them).

**Reasoning / effort control** (`/v1/messages`): only `output_config.effort` (string, e.g. `high`/`low`/`max`) is accepted; `effort: null`, `reasoning_effort`, and `reasoning.effort` are rejected under strict validation. `adaptive_thinking` models (`opus-4.6`/`4.7`/`4.8`/`5`, `sonnet-4.6`/`5`) accept `thinking: { type: "adaptive" }` and `output_config.effort`; non-adaptive models (`sonnet-4.5`, `haiku-4.5`) reject both. See `docs/messages-routing-and-translation.md` for how the proxy converts classic `thinking: enabled` to adaptive.

**Official tool support** (`/v1/messages`, `opus-5` / `sonnet-5`, 2026-07-25): supported — `standard_function`, `bash_20250124`, `text_editor_20250728`, `memory_20250818`, `custom`, `tool_search_tool_bm25`(+`_20251119`), `tool_search_tool_regex`(+`_20251119`), `code_execution_20250522`/`20250825`/`20260120`. Rejected — older `text_editor` dates, `web_search_*`, `web_fetch_*`, `mcp_*`, `computer_*`. (`code_execution` was `opus-4.8`-only in June; now broadly advertised. `sonnet-4.6` rejected bm25 as Bedrock-served — `sonnet-5` accepts it.)

## Execution Path Selection

For `POST /v1/messages`, the handler selects a strategy based on the model's `supported_endpoints`:

```text
Does model support /v1/messages?
  ├── YES → Native Messages Strategy (passthrough)
  └── NO
       ├── Does model support /responses?
       │    ├── YES → Responses Translation Strategy
       │    └── NO  → Chat Completions Fallback Strategy
       └── (default) → Chat Completions Fallback Strategy
```

Priority order matters: native passthrough wins when available. The Responses path is used only when it's the best available. Chat Completions is the universal fallback.

## Small-Model Routing

An optional optimization that reroutes certain requests to a smaller (cheaper/faster) model.

## `anthropic-beta` Header Handling

Clients like Claude Code may send `anthropic-beta: context-1m-2025-08-07` to request 1M context. Copilot does not understand `context-*` beta values, so the proxy **strips** them (along with other Copilot-unsupported betas) before forwarding; remaining beta values pass through. SOTA Anthropic models are natively 1000k context, so no model substitution is performed for the header — it is simply removed.

### Small-Model Routing Details

### Activation

Disabled by default. Requires `smallModel` to be set in config.

### Compact Detection

Identifies Claude Code's conversation summarization requests by matching the system prompt pattern. When detected and `compactUseSmallModel` is enabled, the request is rerouted.

### Safety Checks

Before rerouting, the proxy validates the target small model:
- Must exist in Copilot's model list
- Must preserve the original model's endpoint support
- Must support any required capabilities (tools, vision, thinking)

If any check fails, the original model is used.

## Responses Request Policies

The native OpenAI-style `/v1/responses` route stays close to passthrough by default. Two optional request-mutation policies exist for Copilot `/responses` compatibility and long-session ergonomics:

| Key | Default | Effect |
|-----|---------|--------|
| `responsesApiAutoContextManagement` | `false` | Auto-inject `context_management` for models listed in `responsesApiContextManagementModels` |
| `responsesApiAutoCompactInput` | `false` | Auto-trim `input` to the latest `compaction` item before forwarding |

These policies are both disabled by default. They only apply when explicitly enabled in config.

## CAPI Profile Selection

The plan builder selects an API endpoint profile based on model family:

| Model Family | Profile ID | Purpose                                    |
|--------------|------------|--------------------------------------------|
| `claude`     | `claude`   | Claude-specific headers and parameters     |
| (other)      | `base`     | Standard Copilot API headers               |

The profile affects:
- Request headers sent to Copilot
- API base URL construction
- Interaction type defaults
