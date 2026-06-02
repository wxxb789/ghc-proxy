# Messages Routing and Translation

This document describes how `ghc-proxy` handles Anthropic Messages requests now that GitHub Copilot models can expose different upstream endpoints.

## Routing Order

Incoming `POST /v1/messages` requests are parsed and validated first. After that, `ghc-proxy` picks one of three execution paths based on the selected model's `supported_endpoints`:

1. Native Copilot `POST /v1/messages`
2. Copilot `POST /responses` through the Anthropic <-> Responses translators
3. Copilot `POST /chat/completions` through the existing Anthropic adapter pipeline

The order matters. Native passthrough wins when the model exposes it. The Responses path is only used when it is the best available endpoint for that model. The chat-completions adapter remains the fallback path.

## Native Messages Path

When a model supports Copilot `POST /v1/messages`, the proxy forwards the Anthropic payload with minimal mutation:

- Existing assistant thinking blocks that only contain placeholder or encoded Responses state are filtered before passthrough.
- `output_config` is stripped for models that reject it (see `MODELS_REJECTING_OUTPUT_CONFIG` in `model-capabilities.ts`). Native forwarding only preserves `output_config.effort`; structured-output fields such as `output_config.format` are stripped because Copilot's native Anthropic endpoint can reject them through provider policy before the proxy can translate them. When the selected model advertises `capabilities.supports.reasoning_effort`, unsupported `output_config.effort` values are clamped to the highest advertised effort before forwarding, e.g. `max`/`xhigh` become `high` for models that only support `low`, `medium`, and `high`.
- `cache_control` fields on system blocks, messages, content blocks, and tools are normalized to `{ type: "ephemeral" }` — extra sub-fields like `scope` are stripped because the upstream Copilot API does not yet accept them. This is a temporary workaround; when Copilot supports `scope`, the filter (`sanitizeCacheControl` in `strategy-registry.ts`) should be removed. The `smoke-cache-control` script includes a direct upstream probe that will fail when `scope` becomes accepted, signalling the filter is no longer needed.
- `search_result` content blocks are forwarded when Copilot accepts the shape. A live upstream probe on April 17, 2026 against `claude-opus-4.6-1m` confirmed that Copilot accepts top-level user `search_result` blocks and pure `tool_result.content[]` arrays of `search_result` blocks. The same probe showed two important native-path sanitizers are still required: top-level `citations` is stripped because Copilot rejects it, and mixed `tool_result.content[]` arrays containing both `search_result` and non-`search_result` blocks are flattened to a single text block because Copilot requires all blocks in that tool result to be `search_result` when any are.
- Anthropic beta headers that Copilot does not support, such as `context-*` and `mid-conversation-system-*`, are stripped before upstream forwarding. Context betas can still trigger configured context-upgrade routing before they are removed.
- Other fields, including `thinking`, are passed through as-is to the upstream endpoint unless a documented sanitizer above handles a known Copilot incompatibility.

Run `bun run scripts/probe-messages-search-results.ts --json` to refresh the current Copilot `search_result` support snapshot.

## Responses Translation Path

When a model supports `/responses` but not native `/v1/messages`, the proxy translates Anthropic Messages into Responses input items, executes the request, and translates the result back into Anthropic shape.

### Exact or Near-Exact Mappings

| Anthropic input | Responses input | Notes |
| --- | --- | --- |
| `system` | `instructions` | Preserved as text. |
| User text | `message` with `input_text` | Preserved in order. |
| User image | `message` with `input_image` | Preserved as data URL input. |
| User `tool_result` | `function_call_output` | Preserved by `tool_use_id` / `call_id`. |
| User `search_result` | `message` with `input_text` | Flattened to text containing title, source, and content. Citation metadata is not preserved. |
| `tool_result` `search_result` content | `function_call_output` | Flattened to text containing title, source, and content. |
| Assistant text | `message` with `output_text` | Preserved as assistant history. |
| Assistant `tool_use` | `function_call` | Preserved as call ID, name, and JSON arguments. |
| Assistant reasoning with signature | `reasoning` | Signature is split into encrypted content and item ID. |
| Encoded compaction carrier | `compaction` | Preserved as opaque encrypted content. |
| Anthropic tools | Responses function tools | Tool schemas stay object-shaped. |

### Intentional Policy Decisions

| Feature | Behavior | Reason |
| --- | --- | --- |
| `thinking: disabled` | Maps to `reasoning.effort = none` | Preserves explicit disable intent. |
| `thinking: adaptive` with no explicit effort | Maps to `reasoning.effort = medium` | Conservative default for a request that asked for adaptive reasoning but did not fix an effort. |
| `output_config.effort` | Maps to Responses reasoning effort | Preserves explicit caller intent. |
| `apply_patch` custom tool | Optional shim to function tool | Controlled by `useFunctionApplyPatch`. |
| Responses context compaction | Optional policy | Disabled by default. Requires `responsesApiAutoContextManagement: true` and a model match in `responsesApiContextManagementModels`. |

### Explicitly Unsupported on the Responses Path

These Anthropic fields are rejected with `400` when the request must execute through `/responses`:

- `stop_sequences`
- `top_k`
- `service_tier`

They are rejected because the current Responses execution path cannot preserve their semantics safely. The proxy does not silently drop them.

## Responses API Compatibility Policies

`POST /v1/responses` is handled as a native OpenAI-style endpoint, but the proxy still applies explicit compatibility rules:

- Requests are validated before mutation.
- Common official fields such as `conversation`, `previous_response_id`, `max_tool_calls`, `truncation`, `user`, `prompt`, and `text` are modeled explicitly.
- Official `text.format` options such as `text`, `json_object`, and `json_schema` are validated explicitly.
- `custom` `apply_patch` can be rewritten into a function tool when enabled.
- Automatic `context_management` injection is disabled by default and only applies when explicitly enabled in config.
- Automatic prompt slicing to the latest `compaction` item is disabled by default and only applies when explicitly enabled in config.
- Known unsupported builtin tools, such as `web_search`, fail explicitly with `400`.
- External `input_image.image_url` values that point at remote HTTP(S) URLs fail explicitly with `400`.
- Official `input_file` and `item_reference` input items are modeled explicitly and validated before forwarding.
- Unknown fields are passed through when they do not interfere with proxy-side policies, so newer official fields can continue to flow to Copilot when the upstream endpoint supports them.

### Current live upstream note

As of March 11, 2026, local end-to-end scans against every Copilot model that advertised `/responses` support showed a stable vision mismatch:

- external image URLs were rejected upstream with `400`
- the proxy now rejects external image URLs locally because that upstream rejection was stable across the full scanned `/responses` model set
- the current PNG data URL probe was also rejected upstream, despite the fixture decoding as a valid image locally

That means the proxy cannot currently promise end-to-end Responses vision support just from model metadata. Vision on the Responses path should be treated as a live-verified capability, not a static guarantee.

The same applies to the broader Responses resource surface. As of March 11, 2026, live probes showed:

- `POST /responses` works
- `POST /responses/input_tokens` returns upstream `404`
- `GET /responses/{id}` returns upstream `404`
- `GET /responses/{id}/input_items` returns upstream `404`
- `DELETE /responses/{id}` returns upstream `404`
- `previous_response_id` follow-up requests return upstream `400 previous_response_id is not supported`

Those routes are still exposed by the proxy because they belong to the official OpenAI Responses surface, but current Copilot upstream support is not there yet.

### Server-side tool support

As of April 30, 2026, the Copilot `/v1/messages` endpoint recognizes type-based (server-side) tools but support varies per model. A comprehensive probe across all Claude models showed:

| Tool type | Universally supported | Notes |
|-----------|----------------------|-------|
| Standard function tools (`input_schema`) | Yes | All models |
| `bash_20250124` | Yes | All models |
| `text_editor_20250728` | Yes | All models (name must be `str_replace_based_edit_tool`) |
| `custom` | Yes | All models |
| `memory_20250818` | Partial | Opus 4.6+, Opus 4.7, Sonnet 4.5, Haiku 4.5 |
| `tool_search_tool_*` | Partial | Opus 4.6+, Opus 4.7, Sonnet 4.5 |
| `code_execution_20250522` | Partial | Opus 4.7 only |
| `code_execution_20250825` | Partial | Opus 4.7 only |
| `code_execution_20260120` | Partial | Opus 4.7 only |
| `web_search_20250305` | No | Tag registered but policy-blocked on all models |
| `web_search_20260209` | No | Not registered on any model |
| `web_fetch_20250910` | No | Not registered on any model |
| `web_fetch_20260209` | No | Not registered on any model |
| `mcp_toolset` | No | Not registered on any model |
| `mcp-client-2025-11-20` | No | Not registered on any model |
| `text_editor_20250124/0429` | No | Deprecated; newer models reject them |
| `computer_20250124` | No | Tag not registered |

All four Opus 4.7 variants (`claude-opus-4.7`, `claude-opus-4.7-high`, `claude-opus-4.7-xhigh`, `claude-opus-4.7-1m-internal`) have identical tool support. They gained `code_execution` (all three versions) and `tool_search_tool_bm25` compared to Opus 4.6.

On the `/responses` endpoint (GPT models including `gpt-5.5`), `web_search_preview` and custom tools (`apply_patch`, `shell`) are accepted. `file_search`, `code_interpreter`, `computer_use_preview`, `image_generation`, and `mcp` are rejected. `gpt-5.5` has identical tool support to `gpt-5.4`.

### Prompt caching

As of April 30, 2026, prompt caching via `cache_control: { type: "ephemeral" }` is supported across all tested models on both `/v1/messages` and `/responses` paths. One notable exception:

- `claude-opus-4.7-xhigh` has a higher minimum cache threshold (~8K tokens vs the standard ~4K for other Opus models). The `cache_control` field is accepted without error, but caching only activates when the cacheable content exceeds approximately 8192 tokens.

Run `bun scripts/probe-cache-threshold.ts --model=<id>` to probe a specific model's cache threshold.

Run `bun scripts/probe-all-copilot-tools.ts --json` to get a current snapshot. Weekly diffs detect backend changes.

## Streaming Guarantees

The Responses streaming translator is stateful and emits Anthropic stream events with protocol-level error frames when translation fails. Current guarantees:

- `response.id` is stabilized across lifecycle events on the native `/v1/responses` passthrough boundary
- child events that carry `item_id` are normalized structurally by `output_index` instead of relying on a fixed event-name whitelist
- malformed upstream JSON becomes an Anthropic `error` event instead of a broken TCP stream
- completed function-call blocks are not reopened
- excessive whitespace-only function-call argument streams are rejected with an Anthropic `error` event
- unfinished streams emit a terminal Anthropic `error` event instead of silently ending

For the current `/v1/responses` stream identity contract, see [responses-stream-compatibility.md](/Q:/repos/ghc-proxy/docs/responses-stream-compatibility.md).

## Small-Model Routing

Compact routing only applies to `POST /v1/messages`, and it is disabled by default.

The reroute is allowed only when all of the following are true:

- `smallModel` is configured
- the target model exists in Copilot's model list
- the target model preserves the original model's declared endpoint support
- tool, thinking, or vision requests are not rerouted to a model that lacks the required capabilities

Additional trigger rules:

- `compactUseSmallModel`: matches the known Claude Code / OpenCode compact summarization system prompt
