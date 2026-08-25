# Competitive Analysis: ghc-proxy vs LiteLLM GitHub Copilot

## Overview

| Dimension | ghc-proxy | LiteLLM |
|-----------|-----------|---------|
| Positioning | Dedicated Copilot proxy (standalone process) | One provider in a universal LLM gateway |
| Code volume | Entire repo focused on this | ~5 files, ~40KB |
| Language/Runtime | TypeScript / Bun | Python / anyio |
| Output formats | OpenAI + **Anthropic** + Responses | OpenAI + Responses (no native Anthropic) |

---

## ghc-proxy Advantages

### 1. Native Anthropic Messages API Support (Core Differentiator)
The single biggest differentiator. ghc-proxy provides a complete `/v1/messages` endpoint with three execution paths:
- **Native Messages** — Direct passthrough (when Copilot supports it natively)
- **Responses Translation** — Anthropic <-> Responses format translation
- **Chat Completions Fallback** — Anthropic <-> OpenAI Chat translation

LiteLLM **does not provide** an Anthropic-format output interface at all. For clients that depend on the Anthropic API (e.g., Claude Code), ghc-proxy works out of the box; LiteLLM requires client-side adaptation.

### 2. Fine-grained Model Capability Detection and Routing
- Per-model endpoint detection (`/v1/messages` vs `/responses`)
- Per-model vision, tool call, and thinking capability detection
- Automatic fallback to available execution strategies
- Optional small-model routing for recognized compact/summarization requests
  (`compactUseSmallModel: true` plus a configured `smallModel`; disabled by default)

LiteLLM's model routing relies on global configuration with no per-model automatic discovery.

### 3. Comprehensive Token Counting
- Dedicated `/v1/messages/count_tokens` endpoint
- Multiple GPT tokenizer support (o200k_base, cl100k_base, etc.)
- Per-model-family overhead and estimation coefficients
- Image token estimation

### 4. Configurable Rate Limiting
- Supports error mode (immediate 429) and wait mode (auto-wait-and-retry)
- Per-request granularity control

### 5. Copilot Usage Querying
- `check-usage` subcommand and `/usage` endpoint
- Shows premium interactions, chat, and completions quotas
- Quota reset dates and usage percentages

### 6. Complete CLI Experience
- Interactive Claude Code integration (`-c` flag auto-generates launch commands)
- `auth`, `debug`, `check-usage`, `selfcheck` standalone subcommands
- Rich runtime options (host/port, upstream timeout, proxy, recovery queue, dashboard access, etc.)

### 7. Advanced Responses API Support
- Full CRUD endpoints (GET/DELETE response, input items)
- SignatureCodec for structured data encoding/decoding
- Opt-in Responses input trimming and context-management injection (both disabled by default)

### 8. Deep Extended Thinking Support
- Reasoning effort support through `max`
- Thinking block filtering strategies
- Cross-format thinking preservation

---

## LiteLLM Advantages

### 1. Multi-Provider Unified Interface
LiteLLM's core value — one SDK for 100+ models. GitHub Copilot is just one provider; users can seamlessly switch and fallback between Copilot, OpenAI, Azure, AWS Bedrock, etc. ghc-proxy is a single-purpose tool.

### 2. Enterprise-grade Routing and Observability
- Multi-deployment load balancing, health checks
- Latency/success-rate-driven intelligent routing
- Per-key/team/user cost tracking and budget limits
- Integration with Prometheus, Langfuse, and other observability tools

### 3. Python Ecosystem Integration
- Embeddable as a Python SDK (`litellm.completion(model="github_copilot/...")`)
- Async support (anyio)
- Native integration with LangChain, LlamaIndex, etc.

### 4. Lighter Integration Path
For teams already using LiteLLM, adding Copilot requires only a provider configuration — no separate process deployment.

### 5. WebSocket Support
LiteLLM added WebSocket support in March 2026 (`github_copilot/ws/` prefix) for non-native WebSocket providers. ghc-proxy does not currently support WebSocket.

---

## Feature Comparison Matrix

| Feature | ghc-proxy | LiteLLM |
|---------|:---------:|:-------:|
| OpenAI Chat API output | Yes | Yes |
| **Anthropic Messages API output** | Yes | No |
| Responses API | Full CRUD | Basic |
| Embedding API | Yes | Yes |
| Native `/v1/messages` passthrough | Yes | No |
| Multi-path execution strategy | 3 paths | Fixed path |
| Device code auth | Yes | Yes |
| Token auto-refresh | Yes | Yes |
| Vision support | Per-model detection | Recursive scan |
| Extended Thinking | Deep support | Basic support |
| Token counting endpoint | Yes | No |
| Rate limiting | Dual mode | No (provider level) |
| Usage/quota querying | Yes | No |
| Model capability auto-discovery | Yes | No |
| Multi-provider fallback | No | Yes |
| Load balancing | No | Yes |
| Cost tracking | No | Yes |
| WebSocket | No | Yes |
| Python SDK embedding | No | Yes |
| Standalone CLI tool | Yes | No |
| Claude Code one-click integration | Yes | No |
| Automatic context compaction | Optional (off by default) | No |

---

## Anthropic Prompt Caching: Deep Comparison

### ghc-proxy: Cache Coverage Across All Three Paths

**Native Messages passthrough path:**
- Client `cache_control` blocks are forwarded after sanitization; every sub-field
  except `type` is removed before Copilot `/v1/messages`
- Upstream `cache_read_input_tokens` and `cache_creation_input_tokens` returned as-is
- Usage is passthrough, but request-side cache metadata beyond `type` is lossy

**Chat Completions fallback path:**
- Automatic injection of `copilot_cache_control: { type: \"ephemeral\" }` (all models, profile-controlled)
- Smart injection at 3 sites: first system message, last tool, last non-user message
- `prompt_tokens_details.cached_tokens` -> Anthropic `cache_read_input_tokens`
- `input_tokens` automatically subtracts cached portion

**Responses API translation path:**
- `input_tokens_details.cached_tokens` -> `cache_read_input_tokens`
- Final `input_tokens_details.cache_write_tokens` ->
  `cache_creation_input_tokens` when the write count is non-zero
- Cache-read accounting is supported in streaming and non-streaming responses;
  terminal streaming usage carries the same cache-write mapping as
  non-streaming output

Key files:
- `src/core/capi/plan-builder.ts` — `applyCacheCheckpoints()`, `stripTransportFields()`
- `src/core/capi/profile.ts` — `enableCacheControl` per-model control
- `src/translator/anthropic/shared.ts` — `mapOpenAIUsageToAnthropic()`
- `src/translator/responses/responses-stream-translator.ts` — streaming cache token handling

### LiteLLM: No Cache Handling

LiteLLM's GitHub Copilot provider **has not implemented any cache_control handling**:
- No cache-related code in Chat/Responses/Common Utils
- Does not generate `copilot_cache_control`
- Does not track `cache_read_input_tokens`
- No cache-related request headers

Note: LiteLLM's **native Anthropic provider** (direct API) supports cache, but this capability has not been ported to the Copilot provider.

### Cache Feature Comparison

| Cache Feature | ghc-proxy | LiteLLM (Copilot) |
|--------------|:---------:|:-----------------:|
| Client `cache_control` passthrough | Native path preserves only `type` | No |
| Automatic ephemeral cache injection | Yes (all models) | No |
| Smart cache site selection | 3 sites | No |
| `cache_read_input_tokens` returned | All paths | No |
| `cache_creation_input_tokens` returned | Native passthrough; Responses non-stream when reported | No |
| `input_tokens` subtracts cached portion | Yes | No |
| Streaming cache token tracking | Yes | No |
| Per-model profile cache control | Yes | No |

### Practical Impact

- **Cost**: Anthropic prompt caching can reduce input token costs by up to 90% for repeated context. ghc-proxy enables this automatically; LiteLLM completely wastes this capability.
- **Latency**: Cached tokens process faster, yielding lower latency in multi-turn conversations.
- **Transparency**: ghc-proxy exposes cached/uncached token counts on supported paths so users can assess cache hits; LiteLLM provides no Copilot cache visibility.

---

## Cache Implementation Correctness Analysis

### Anthropic Official Cache Specification

**Request side:**
- `cache_control: { type: "ephemeral", ttl?: "5m" | "1h" }` can be placed on: top level, system block, user/assistant content block, tool definition, tool_use, tool_result
- Maximum 4 explicit cache breakpoints
- Minimum token threshold: Opus 4096, Sonnet 1024-2048, Haiku 1024-4096

**Response side — usage field semantics:**
```text
cache_creation_input_tokens = tokens written to cache this request
cache_read_input_tokens     = tokens read from cache this request
```
The three are **additive** and non-overlapping. Total cost = read *0.1 + creation* 1.25 + input * 1.0

**Streaming side:**
- `message_start` event carries full cache usage (input_tokens + cache_*)
- Anthropic's usual incremental `message_delta` carries output usage, but
  ghc-proxy's terminal Responses translation emits the complete final mapped
  usage from `response.completed` / `response.incomplete`

### Per-Path Correctness Analysis

#### Native Messages Path — Mostly Correct
- File: `src/routes/messages/strategies/native-messages.ts`
- Request: client `cache_control` is normalized to `{ type }`; all other
  sub-fields are stripped (see `sanitizeCacheControl` in
  `src/transform/sanitize.ts`)
- Response: `cache_creation_input_tokens` + `cache_read_input_tokens` passed through as-is
- Request-side loss is not limited to `scope`: every key other than `type` is dropped

#### Chat Completions Fallback Path — Two Known Issues

**Issue 1: `cache_creation_input_tokens` missing**
- File: `src/translator/anthropic/shared.ts:26-36`
- `mapOpenAIUsageToAnthropic()` only maps `cache_read_input_tokens`
- OpenAI's `prompt_tokens_details` does not include creation tokens, so **mapping is impossible**
- **This is an upstream API limitation, not a bug** — but Anthropic clients may expect this field

**Issue 2: Client `cache_control` overwritten**
- File: `src/core/capi/plan-builder.ts:242-272`
- `applyCacheCheckpoints()` overwrites all sites with hardcoded `{ type: 'ephemeral' }`
- Client's original `cache_control` (e.g., custom TTL) is discarded
- **Low severity**: the proxy's injected `copilot_cache_control` transport field is fixed to `ephemeral`

**Correct aspects:**
- `input_tokens = prompt_tokens - cached_tokens` — matches Anthropic semantics
- `cache_read_input_tokens` correctly mapped
- Cache enabled for all models (profile-controlled)

#### Responses Translation Path — Final Usage Mapped

- File: `src/translator/responses/responses-to-anthropic.ts`
- `mapResponsesUsage()` maps `cached_tokens` to `cache_read_input_tokens`
- When upstream reports `cache_write_tokens`, non-streaming and terminal
  streaming translation map it to `cache_creation_input_tokens` and omit a zero
  write
- Streaming `message_start` uses preliminary usage from `response.created`;
  terminal `message_delta` translates the final response through the same
  `mapResponsesUsage()` path as non-streaming output

**Correct aspects:**
- `input_tokens = inputTokens - cachedTokens`
- `cache_read_input_tokens` correctly mapped
- Cache-write tokens are mapped when final upstream usage supplies them
- Streaming `message_start` cache-read tokens are mapped
- Terminal streaming usage carries the full final mapped usage

**Zero-value edge case:**
- Non-streaming and terminal streaming translation emit
  `cache_read_input_tokens: 0` only when upstream explicitly reports
  `cached_tokens: 0`; they omit the field when upstream omits `cached_tokens`
- Preliminary streaming `message_start` currently defaults an absent cached
  count to `cache_read_input_tokens: 0`

**Request-side distinction:**
- Anthropic `cache_control` is not translated into a Responses cache key
- `prompt_cache_key` on the Anthropic-to-Responses path is derived from the
  `session_*` component of `metadata.user_id`; direct Responses clients may
  provide `prompt_cache_key`, `prompt_cache_options`, and cache breakpoints
  explicitly

### Correctness Summary

| Check | Native | Chat Comp | Responses |
|-------|:------:|:---------:|:---------:|
| `cache_control` passthrough | Only `type` preserved | Overwritten | Not translated to a cache key |
| `input_tokens` semantics | Correct | Correct | Correct |
| `cache_read_input_tokens` | Correct | Correct | Correct |
| `cache_creation_input_tokens` | Correct | Missing | Mapped from final usage when reported |
| Omit read field when no cache | Correct | Correct | Final usage omits when absent; `message_start` defaults to 0 |
| Streaming cache tokens | Correct | Correct | Preliminary read + complete terminal usage |

---

## Verification Tests

Test file: `tests/cache-correctness.test.ts`

14 test cases covering:

1. **Chat Completions — non-streaming cache token mapping**: Verifies `prompt_tokens_details.cached_tokens` correctly maps to `cache_read_input_tokens` and is subtracted from `input_tokens`
2. **Chat Completions — no cache hit**: Verifies `cache_read_input_tokens` is omitted (not set to 0) when upstream returns no cached tokens
3. **Chat Completions — cache checkpoint injection**: Verifies `copilot_cache_control: { type: "ephemeral" }` is injected at exactly 3 sites (first system message, last tool, last non-user message)
4. **Chat Completions — streaming cache tokens**: Verifies streaming `message_delta` events contain correct cache token counts
5. **Responses — non-streaming cache token mapping**: Verifies `input_tokens_details.cached_tokens` maps correctly to `cache_read_input_tokens`
6. **Responses — streaming cache in message_start**: Verifies `message_start` event contains correct `cache_read_input_tokens` and adjusted `input_tokens`
7. **Responses — no cache omission**: Verifies `cache_read_input_tokens` is absent when no cached tokens
8. **All models — cache injection**: Verifies all models (including GPT) receive `copilot_cache_control` on messages and tools
9. **Responses — cache write mapping**: Verifies `cache_write_tokens` maps to `cache_creation_input_tokens`
10. **Responses — no cache write**: Verifies `cache_creation_input_tokens` is omitted when the write count is zero
11. **Responses — explicit cache controls**: Verifies direct `prompt_cache_key`, `prompt_cache_options`, and content breakpoints are forwarded
12. **Responses — unsupported TTL**: Rejects a cache TTL that upstream does not accept
13. **Responses — supported TTL**: Accepts the supported `30m` TTL
14. **Responses — invalid mode**: Rejects an unknown `prompt_cache_options.mode`

---

## Conclusion

**ghc-proxy** comprehensively leads in **depth and specialization** for Copilot proxying — especially native Anthropic protocol support, multi-path execution strategies, fine-grained model capability detection, token counting, and Claude Code integration. These are capabilities LiteLLM does not offer.

**LiteLLM's** strength lies in **breadth and ecosystem** — as a universal LLM gateway, it provides multi-provider unified interfaces, enterprise-grade routing, and cost management. Its Copilot implementation is a "good enough" integration rather than a deeply optimized solution.

In short: **ghc-proxy is a Swiss Army knife for Copilot; LiteLLM is a universal remote for the LLM world**. Their target users and use cases do not fully overlap.
