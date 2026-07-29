# Streaming Architecture

This document describes how ghc-proxy handles server-sent event (SSE) streaming across all execution paths.

## Overview

All three execution paths support streaming. The proxy acts as a streaming translator, reading upstream SSE events and emitting downstream SSE events in the client's expected format.

## Streaming Pipeline

```text
Upstream SSE Stream (Copilot)
        |
        v
[fetch-event-stream]         Parse SSE into typed events
        |
        v
[ExecutionStrategy]           Route to appropriate translator
        |
        v
[Stream Translator]           Format-specific event translation
        |
        v
[Elysia SSE]                 Write SSE events to client
        |
        v
Client SSE Stream
```

## SSE Output Model

All stream translators produce `SSEOutput` objects:

```typescript
interface SSEOutput {
  id?: string
  event?: string
  data: string
  comment?: string
  retry?: number
}
```

Translation methods can return:
- `null` -- skip this chunk (no output)
- `SSEOutput` -- emit one event
- `SSEOutput[]` -- emit multiple events (e.g., block_start + delta from one upstream chunk)

## Path-Specific Streaming

### Native Messages Path

Minimal transformation. Upstream Anthropic events flow through nearly unchanged:
- Filters stale thinking blocks from assistant history
- Otherwise passes events directly

### Chat Completions Fallback Path

Translates OpenAI Chat streaming chunks to Anthropic stream events:

```text
OpenAI chunk (delta)
    |
    v
[AnthropicStreamTranslator]
    |
    +-- manages content block index
    +-- delegates to per-index transducers
    |
    v
[AnthropicStreamTransducer] (one per content index)
    |
    +-- buffers partial text deltas
    +-- reconstructs tool calls from fragments
    +-- tracks tool call argument accumulation
    |
    v
Anthropic stream events
```

**Emitted events:**
```text
message_start         → Initial message metadata
content_block_start   → New text or tool_use block
content_block_delta   → Incremental text_delta or input_json_delta
content_block_stop    → Block complete
message_delta         → Final stop_reason and usage
message_stop          → Stream end
```

**Per-index transducer state machine:**

```text
[idle] → text delta → [in_text_block]
                          |
                          v
                   content_block_start(text)
                   content_block_delta(text_delta)*
                   content_block_stop

[idle] → tool call delta → [in_tool_block]
                               |
                               v
                        content_block_start(tool_use)
                        content_block_delta(input_json_delta)*
                        content_block_stop
```

Interleaved tool calls across different OpenAI indexes are handled by maintaining independent transducer lanes per index.

### Responses Path

Translates OpenAI Responses streaming events to Anthropic stream events:

```text
Responses event (response.output_text.delta, etc.)
    |
    v
[ResponsesStreamTranslator]
    |
    +-- tracks current content block index
    +-- buffers function call deltas
    +-- manages reasoning state
    |
    v
Anthropic stream events
```

The Responses translator is stateful:
- It tracks which content blocks are currently open
- It accumulates function call arguments across delta events
- It handles reasoning/thinking block lifecycle

## Error Recovery

### Principle

Streaming errors become protocol-level error events, not broken TCP connections. This allows clients to receive structured error information even during streaming.

### Guarantees

1. **Malformed upstream JSON** → Emits Anthropic `error` event with details
2. **Completed function calls** → Never reopened after `content_block_stop`
3. **Whitespace-only arguments** → Excessive whitespace in tool call arguments triggers `error` event
4. **Unfinished streams** → Terminal `error` event instead of silent EOF
5. **Client abort** → No error events emitted (client disconnected)

### Error Event Format

```json
{
  "event": "error",
  "data": "{\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"...\"}}"
}
```

## AbortSignal Management

The `upstream-signal.ts` module manages request cancellation:

```text
Client AbortSignal (request disconnection)
        |
        v
[createUpstreamSignal]
        |
        +-- links to client signal
        +-- adds optional timeout
        |
        v
Upstream AbortSignal → passed to CopilotClient fetch
```

Cleanup is always called in the `finally` block of `executeStrategy()`, ensuring signal listeners are removed regardless of success or failure.

## Timeout Handling

Configurable via `--upstream-timeout` CLI flag:

- Applied per-request to the upstream fetch
- On timeout: AbortSignal fires, stream terminates
- Client receives appropriate error (504 for non-streaming, error event for streaming)

Timeouts reach the proxy in several different shapes depending on the runtime, and all of them must be handled:

| Runtime | Shape | Source |
|---|---|---|
| Both | `DOMException` named `AbortError` | Our own `AbortController` — the client disconnected, or `createUpstreamSignal`'s timer fired |
| Bun | `DOMException` named `TimeoutError` | Bun's built-in ~300s `fetch` idle timeout (measured on Bun 1.3.14) |
| Node | `TypeError('fetch failed')` with `HeadersTimeoutError` / `ConnectTimeoutError` on `.cause` | undici's `headersTimeout` (~300s) / `connectTimeout` (10s) — the pre-first-byte ceilings |
| Node | `TypeError('terminated')` with `BodyTimeoutError` on `.cause` | undici's `bodyTimeout` (~300s) — the mid-stream ceiling |
| Node | `TypeError('fetch failed')` with an `AggregateError` on `.cause` whose `.errors` hold an `ETIMEDOUT` leaf | Dual-stack connect: `autoSelectFamily` races IPv6 and IPv4, and a leg that times out is collected alongside one that was refused |

The ~300s figure is **not** Bun-specific — Node's undici defaults both
`headersTimeout` and `bodyTimeout` to `300e3` — but on both runtimes it is an
**idle** timeout, not a total-duration cap. `bodyTimeout` resets on every chunk
received, so a steadily streaming response runs well past 300s and is bounded
only by `--upstream-timeout`'s own `AbortSignal`; a *stalled* stream is what the
runtime rejects at ~300s.

`isTimeoutLikeError` (`src/lib/timeout-error.ts`) is the single classifier. On
Node the top-level error is useless as a discriminator — `TypeError('fetch failed')`
is also what `ECONNREFUSED` and DNS failures look like, and `TypeError('terminated')`
is also a clean peer hangup — so the classifier walks `.cause` and
`AggregateError.errors` to a bounded depth and matches on the inner error's `name`
or `code`. The `.errors` walk is load-bearing rather than defensive: on a dual-stack
connect Node's `NodeAggregateError` takes its `code` from `errors[0]`, so when the
refused leg loses the race first, the `ETIMEDOUT` leaf is the *only* evidence of a
timeout and it sits two levels down. It is called on both sides of the stream
boundary: `handleRouteError` in `src/server.ts` maps a pre-first-byte timeout to a
`504`, and the Anthropic stream transducer maps a mid-stream one to an SSE `error`
frame. Keeping one implementation is deliberate: when the rule lived in two places,
each recognized only one name, and a `fetch` ceiling surfaced to clients as a
generic `500`.
