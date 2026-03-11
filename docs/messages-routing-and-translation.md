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
- If the model declares `adaptive_thinking` support and the caller did not specify `thinking`, the proxy fills `thinking: { type: "adaptive" }`.
- If the model declares `adaptive_thinking` support and the caller did not specify `output_config.effort`, the proxy fills an effort derived from `modelReasoningEfforts`.

The proxy does not override explicit caller intent. If the caller already sent `thinking` or `output_config`, those values win.

## Responses Translation Path

When a model supports `/responses` but not native `/v1/messages`, the proxy translates Anthropic Messages into Responses input items, executes the request, and translates the result back into Anthropic shape.

### Exact or Near-Exact Mappings

| Anthropic input | Responses input | Notes |
| --- | --- | --- |
| `system` | `instructions` | Preserved as text. |
| User text | `message` with `input_text` | Preserved in order. |
| User image | `message` with `input_image` | Preserved as data URL input. |
| User `tool_result` | `function_call_output` | Preserved by `tool_use_id` / `call_id`. |
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
| Responses context compaction | Optional policy | Controlled per model by `responsesApiContextManagementModels`. |

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

## Streaming Guarantees

The Responses streaming translator is stateful and emits Anthropic stream events with protocol-level error frames when translation fails. Current guarantees:

- malformed upstream JSON becomes an Anthropic `error` event instead of a broken TCP stream
- completed function-call blocks are not reopened
- excessive whitespace-only function-call argument streams are rejected with an Anthropic `error` event
- unfinished streams emit a terminal Anthropic `error` event instead of silently ending

## Small-Model Routing

Compact and warmup routing only applies to `POST /v1/messages`, and it is disabled by default.

The reroute is allowed only when all of the following are true:

- `smallModel` is configured
- the target model exists in Copilot's model list
- the target model preserves the original model's declared endpoint support
- tool, thinking, or vision requests are not rerouted to a model that lacks the required capabilities

Additional trigger rules:

- `compactUseSmallModel`: matches the known Claude Code / OpenCode compact summarization system prompt
- `warmupUseSmallModel`: requires an explicit warmup/probe marker in `anthropic-beta`, no tools, no system prompt, no explicit thinking request, a small `max_tokens`, and a single short user text message

The warmup path is intentionally conservative. It should avoid ordinary user traffic rather than maximize reroute volume.
