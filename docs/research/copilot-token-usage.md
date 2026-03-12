# Copilot Token Usage

Research into whether GitHub Copilot's backend returns token usage information, and how ghc-proxy handles it.

## Summary

Copilot **does** return token usage data across all three API paths. The proxy's passthrough architecture correctly translates upstream usage fields into the client's expected format without synthesizing or estimating values. The `gpt-tokenizer` library exists solely for **local estimation** in the `count_tokens` endpoint, not for response usage.

## Upstream Usage by Endpoint

### Chat Completions (`/chat/completions`)

Copilot returns standard OpenAI usage in the response:

```json
{
  "usage": {
    "prompt_tokens": 1234,
    "completion_tokens": 567,
    "prompt_tokens_details": {
      "cached_tokens": 200
    }
  }
}
```

When proxied to an Anthropic client, `mapOpenAIUsageToAnthropic()` in `src/translator/anthropic/shared.ts` maps these fields:

| OpenAI Field | Anthropic Field | Notes |
|---|---|---|
| `prompt_tokens - cached_tokens` | `input_tokens` | Cache-adjusted |
| `completion_tokens` | `output_tokens` | Direct mapping |
| `prompt_tokens_details.cached_tokens` | `cache_read_input_tokens` | Only present when non-zero |

### Responses API (`/v1/responses`)

Copilot returns Responses-format usage:

```json
{
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 567,
    "input_tokens_details": {
      "cached_tokens": 200
    }
  }
}
```

`mapResponsesUsage()` in `src/translator/responses/responses-to-anthropic.ts` maps these fields:

| Responses Field | Anthropic Field | Notes |
|---|---|---|
| `input_tokens - cached_tokens` | `input_tokens` | Cache-adjusted |
| `output_tokens` | `output_tokens` | Direct mapping |
| `input_tokens_details.cached_tokens` | `cache_read_input_tokens` | Only present when non-zero |

For streaming, `ResponsesStreamTranslator` extracts usage from the `response.created` event and emits it in the `message_start` Anthropic event. See `src/translator/responses/responses-stream-translator.ts:117-133`.

### Native Messages (`/v1/messages`)

When Copilot supports native Anthropic messages (direct passthrough), the response already contains Anthropic-format usage fields. No translation is needed -- the response is forwarded as-is.

## Streaming Usage Opt-in

For the Chat Completions path, streaming usage requires explicit opt-in via `stream_options`:

```json
{
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
```

This is configured per CAPI profile in `src/core/capi/profile.ts`. The `claudeProfile` sets `includeUsageOnStream: true`, while the `baseProfile` sets it to `false`. This means streaming usage is automatically requested for Claude models but not for other model families.

## Local Token Estimation (`gpt-tokenizer`)

The `gpt-tokenizer` library is used **only** for local token estimation in the `count_tokens` endpoint (`src/routes/messages/count-tokens-handler.ts`). It is not involved in response usage reporting.

### How `count_tokens` Works

1. The Anthropic `count_tokens` payload is translated to an OpenAI chat-completions payload
2. `getTokenCount()` in `src/lib/tokenizer.ts` uses `gpt-tokenizer` to estimate token counts locally
3. A model-specific correction factor is applied to improve accuracy:
   - **Claude models**: 1.15x multiplier (GPT tokenizers undercount for Claude's tokenizer)
   - **Grok models**: 1.03x multiplier
4. Tool overhead is added when tools are present (346 tokens for Claude, 480 for Grok)

This local estimation exists because Copilot provides no upstream token counting API -- the only way to get accurate counts would be to send the full request upstream, which defeats the purpose of a pre-flight count.

### Why the 1.15x Factor?

GPT tokenizers (BPE-based, e.g., `o200k_base`) produce different token counts than Claude's tokenizer. The 1.15x correction factor for Claude models compensates for this difference, erring on the side of overestimation to avoid underreporting to clients that use `count_tokens` for context window management.

## Summary Table

| Path | Upstream Returns Usage? | Translation Function | Streaming Usage |
|---|---|---|---|
| Chat Completions | Yes (OpenAI format) | `mapOpenAIUsageToAnthropic()` | Opt-in via `stream_options` |
| Responses API | Yes (Responses format) | `mapResponsesUsage()` | Included in `response.created` event |
| Native Messages | Yes (Anthropic format) | None (passthrough) | Included natively |
| `count_tokens` | N/A (local estimation) | `getTokenCount()` + correction factor | N/A |
