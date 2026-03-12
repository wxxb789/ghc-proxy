# Anthropic Translation Matrix

This matrix documents the current Anthropic translator behavior for the chat-completions fallback path in `ghc-proxy`.

For the newer per-model routing behavior, including the Anthropic <-> Responses path, see [Messages Routing and Translation](./messages-routing-and-translation.md).

## Anthropic Request -> OpenAI Request

| Feature | Status | Notes |
| --- | --- | --- |
| System text | Exact | Preserved as `system` messages. |
| User text | Exact | Preserved in order. |
| User image | Exact | Converted to `image_url` data URLs. |
| User `tool_result` | Exact | Converted into ordered `tool` messages without reordering surrounding user text. |
| Assistant text | Exact | Preserved as assistant content. |
| Assistant `tool_use` | Exact | Converted into OpenAI `tool_calls` in order. |
| Assistant `thinking` history | Lossy | Preserved in IR, omitted from upstream prompt, emits `lossy_thinking_omitted_from_prompt`. |
| Assistant `text/tool_use/text` interleaving | Lossy | Flattened into assistant content plus `tool_calls`, emits `lossy_interleaving_flattened`. |
| `thinking.adaptive` | Lossy | Mapped to `reasoning_effort: medium` and hard-coded budget `24000`. |
| `top_k` | Unsupported | Dropped with `unsupported_top_k`. |
| `service_tier` | Unsupported | Dropped with `unsupported_service_tier`. |

## OpenAI Response -> Anthropic Response

| Feature | Status | Notes |
| --- | --- | --- |
| Single-choice text response | Exact | Converted to Anthropic text blocks. |
| Single-choice tool call response | Exact | Converted to Anthropic `tool_use`. |
| Multiple choices | Lossy | Uses `index=0` only, emits `lossy_multiple_choices_ignored`. |
| Malformed tool call JSON | Unsupported | Fails as upstream protocol error (`502`). |
| `finish_reason: content_filter` | Lossy | Mapped to Anthropic `refusal`. |

## OpenAI Stream -> Anthropic Stream

| Feature | Status | Notes |
| --- | --- | --- |
| Text deltas | Exact | Emitted as `text_delta`. |
| Thinking deltas | Exact | Emitted as `thinking_delta`. |
| Sequential tool call deltas | Exact | Emitted as `tool_use` + `input_json_delta`. |
| Interleaved tool call deltas across indexes | Exact | Maintains independent per-index lanes and finalizes all open tool blocks on completion. |
| `[DONE]` without final finish chunk | Lossy | Finalized as `end_turn`. |

## Validation

The validator currently enforces:

- Role/block compatibility for user and assistant messages
- Declared tool existence for `tool_choice.type = tool`
- Positive `thinking.enabled.budget_tokens`
- Object-like tool schemas
- Image block base64 source shape
- `tool_result` content structure
