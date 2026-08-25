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
| `tool_result.is_error` | Lossy | Chat Completions tool messages have no equivalent error flag. The content is preserved, the flag is dropped, and the adapter records `lossy_tool_result_error_flag_dropped`. |
| User `search_result` | Lossy | Flattened to text containing title, source, and result content. Citation metadata is not preserved. |
| `tool_result` `search_result` content | Lossy | Flattened into the OpenAI tool message content. |
| `tool_result` `document` content | Lossy | Flattened to text (`[document]` + inline `text`/`content` source data). Binary/url document sources are placeholdered. |
| Assistant text | Exact | Preserved as assistant content. |
| Assistant `tool_use` | Exact | Converted into OpenAI `tool_calls` in order. |
| Assistant `thinking` history | Lossy | Preserved in IR, omitted from upstream prompt, emits `lossy_thinking_omitted_from_prompt`. |
| Assistant `text/tool_use/text` interleaving | Lossy | Flattened into assistant content plus `tool_calls`, emits `lossy_interleaving_flattened`. |
| `thinking.enabled` | Near-exact | The Claude CAPI profile forwards the requested `thinking_budget`; `reasoning_effort` is inferred as `low` for budgets `<=8000`, `medium` for `<=24000`, and `high` above that unless `output_config.effort` overrides it. Non-Claude profiles omit `thinking_budget`. |
| `thinking.adaptive` | Lossy | Uses synthetic budget `24000`; without an explicit effort this yields `reasoning_effort: medium`. The Claude profile emits both fields, while other model families emit only effort. |
| `thinking.disabled` | Exact | Emits neither `reasoning_effort` nor `thinking_budget`. |
| `output_config.effort` | Exact | Forwarded as `reasoning_effort` and takes precedence over budget inference. This Chat Completions adapter does not clamp it against model metadata. |
| `top_k` | Exact | Forwarded as a Copilot extension on both translated paths. See [research/sampling-parameters.md](research/sampling-parameters.md). |
| `service_tier` | Unsupported | Translation fails before upstream with `400 unsupported_service_tier`; the value is never silently dropped. |
| Function tools | Exact | Converted to Chat Completions function tools; the caller's parameter schema is preserved without the Responses-path annotation normalizer. |
| Anthropic built-ins and client toolsets | Unsupported | If the request cannot remain on native Messages, translation fails before upstream with `400 unsupported_server_tool`; typed definitions are not approximated as ordinary function tools. |

## OpenAI Response -> Anthropic Response

| Feature | Status | Notes |
| --- | --- | --- |
| Single-choice text response | Exact | Converted to Anthropic text blocks. |
| Single-choice tool call response | Exact | Converted to Anthropic `tool_use`. |
| Multiple choices | Lossy | Uses `index=0` only, emits `lossy_multiple_choices_ignored`. |
| Malformed tool call JSON | Unsupported | Fails as upstream protocol error (`502`). |
| `finish_reason: content_filter` | Lossy | Mapped to Anthropic `refusal`. |
| `usage.cached_tokens` | Exact | Mapped to `cache_read_input_tokens` and subtracted from `input_tokens`. |
| Missing usage | Synthetic default | Anthropic requires token counts, so a non-streaming response with no upstream usage maps to `input_tokens: 0` and `output_tokens: 0`. These zeroes mean "not reported", not a measured zero-token request. |

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
- Object-like `input_schema` for ordinary function tools
- A non-null tool `type` other than `custom` identifies an Anthropic built-in or client toolset even if extra fields include `input_schema`; native Messages forwards it unchanged, while either translated path rejects it explicitly
- Positive `thinking.enabled.budget_tokens`
- Image block base64 source shape
- `tool_result` content structure, including Anthropic `search_result` and `document` content blocks
