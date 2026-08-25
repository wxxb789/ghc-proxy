# Model Resolution and Routing

This document describes how ghc-proxy resolves model identifiers and routes requests to the appropriate execution path.

## Model Resolution

### Request Resolution Order

The common request pipeline resolves the model before selecting an execution
strategy. The order is load-bearing:

1. **Configured rewrite** -- The first matching `modelRewrites` rule wins. Its
   target is canonicalized to an advertised ID when dash/dot equivalence finds
   one.
2. **Built-in correction** -- If no configured rule matched, dash/dot
   equivalence is checked against the cached Copilot model list (for example,
   a dotted client spelling can resolve to the advertised dashed spelling).
3. **Compact routing** -- Only `POST /v1/messages` applies the optional compact
   small-model policy. It runs after rewrite, and is skipped for a `context-*`
   Anthropic beta request.
4. **Exact cache lookup** -- The resulting ID is looked up as-is and the route
   strategy is selected from that model record and the request payload.

An ID that is still unknown after these steps remains unknown. The common
pipeline does **not** apply Claude family fallback before selecting Native
Messages or Responses.

### Chat-Adapter Family Fallback

Claude family fallback has a narrower scope: it belongs to the Anthropic ->
Chat Completions adapter used by the Messages chat fallback and the Messages
token-count path. When that adapter builds its CAPI plan, it resolves the
already-rewritten ID as follows:

1. If the ID is in Copilot's cached model list, keep it.
2. Otherwise map an unknown Claude family ID by prefix:
   - `claude-opus-*` → configured `claudeOpus` fallback
   - `claude-sonnet-*` → configured `claudeSonnet` fallback
   - `claude-haiku-*` → configured `claudeHaiku` fallback
3. Pass every other unknown ID through unchanged.

Because strategy selection has already happened, this adapter-local fallback
does not retroactively move a request from Chat Completions to a native
Messages or Responses strategy.

### Family-Fallback Configuration

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

Mappings are exact one-hop choices, not a fallback graph. Blank, same-model, and reciprocal two-node mappings are rejected at configuration load. Fallback does not run for account `429`, connection failures, timeouts, cancellation, other HTTP statuses, validation failures, or failures after any upstream `Response` has committed.

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

**Reasoning / effort control** (`/v1/messages`): the modeled Anthropic field is
`output_config.effort` (`low`/`medium`/`high`/`xhigh`/`max`, or `null`). A null
effort is accepted at ingress and removed before native dispatch; unsupported
ranked values are normalized per path as described in
`docs/messages-routing-and-translation.md`. Alternative spellings such as
top-level `reasoning_effort` or `reasoning.effort` are not part of the
translation contract: the loose native payload may pass unknown fields through,
while translated paths do not map them. `adaptive_thinking` models
(`opus-4.6`/`4.7`/`4.8`/`5`, `sonnet-4.6`/`5`) accept
`thinking: { type: "adaptive" }` and `output_config.effort`; non-adaptive models
(`sonnet-4.5`, `haiku-4.5`) reject both upstream. See the routing document for
the proxy's classic `thinking: enabled` conversion.

**Official tool support** (`/v1/messages`, `opus-5` / `sonnet-5`, 2026-07-25): supported — `standard_function`, `bash_20250124`, `text_editor_20250728`, `memory_20250818`, `custom`, `tool_search_tool_bm25`(+`_20251119`), `tool_search_tool_regex`(+`_20251119`), `code_execution_20250522`/`20250825`/`20260120`. Rejected — older `text_editor` dates, `web_search_*`, `web_fetch_*`, `mcp_*`, `computer_*`. (`code_execution` was `opus-4.8`-only in June; now broadly advertised. `sonnet-4.6` rejected bm25 as Bedrock-served — `sonnet-5` accepts it.)

The web-search verdict above is **`/v1/messages`-only** and does not transfer: on `/responses`, the 2026-08-04 acceptance sweep found `web_search` accepted by every reached model and `web_search_preview` accepted in every measured cell; real search execution was verified on `gpt-5.6-sol` and `gpt-5.6-terra`. See `docs/research/responses-web-search.md`. A tool's support is a property of the boundary, model, schema, and execution mechanism, not of the proxy alone.

## Execution Path Selection

For `POST /v1/messages`, the handler selects a strategy from both the resolved
model metadata and the payload:

```text
Does model support /v1/messages, and can this payload be preserved there?
  ├── YES → Native Messages Strategy
  └── NO
       ├── Does model support /responses?
       │    ├── YES → Responses Translation Strategy
       │    └── NO  → Chat Completions Fallback Strategy
       └── (default) → Chat Completions Fallback Strategy
```

Native preservation is payload-aware for structured output. A request with no
`output_config.format` can use native Messages whenever the model advertises
that endpoint. A request with `output_config.format` can stay native only when
the model supports structured output and the format can be reduced without
discarding semantics: `name` may be removed, but `description` and `strict`
must be preserved by routing through Responses. If Responses is unavailable,
the Chat Completions strategy rejects the format with `400` instead of silently
dropping it.

Priority order otherwise remains native Messages, then Responses translation,
then Chat Completions. The last entry is a strategy fallback, not proof that
the chosen model actually advertises `/chat/completions`; upstream can still
reject an unsupported or unknown model.

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

The native OpenAI-style `/v1/responses` route stays close to the OpenAI
boundary, but it always applies the Copilot compatibility policies documented
in [Messages Routing and Translation](../messages-routing-and-translation.md):
`store=false`, removal of `item_reference` and orphaned
`function_call_output` items, assistant-`phase` removal, remote-image
rejection, function-schema normalization, per-model parameter filtering, the
16-token output floor, and reasoning-effort normalization.

Two additional request-mutation policies are optional and disabled by default:

| Key | Default | Effect |
|-----|---------|--------|
| `responsesApiAutoContextManagement` | `false` | Auto-inject `context_management` for models listed in `responsesApiContextManagementModels` |
| `responsesApiAutoCompactInput` | `false` | Auto-trim `input` to the latest `compaction` item before forwarding |

These policies are both disabled by default. They only apply when explicitly enabled in config.

## CAPI Profile Selection

The CAPI profile is used only while the Anthropic -> Chat Completions adapter
builds a CAPI execution plan (including its token-count payload). Native
Messages and Responses requests do not use these profiles. Selection happens
after the adapter-local family fallback has resolved its effective model:

| Model Family | Profile ID | Plan behavior |
|--------------|------------|---------------|
| `claude` | `claude` | Emits both `reasoning_effort` and `thinking_budget` for enabled/adaptive thinking. |
| (other) | `base` | Emits `reasoning_effort` but not the Claude-only `thinking_budget`. |

Both current profiles add cache checkpoints, request streaming usage, and use
the same request-context/initiator builder. Profile selection does not choose
the upstream base URL, synthesize model-family headers, or own interaction-type
defaults.
