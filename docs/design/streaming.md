# Streaming Architecture

This document describes how ghc-proxy handles server-sent event (SSE) streaming across all execution paths.

## Overview

All three `/v1/messages` execution paths support streaming. The Responses and
Chat Completions public routes also stream through the same strategy runner,
but those protocol-preserving paths do not have the same synthetic error-event
behavior as the Anthropic translation paths.

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
}
```

Translation methods can return:
- `null` -- skip this chunk (no output)
- `SSEOutput` -- emit one event
- `SSEOutput[]` -- emit multiple events (e.g., block_start + delta from one upstream chunk)

`runStrategy()` returns either `{ kind: 'json', data }` or
`{ kind: 'stream', generator }`. For a stream it translates each chunk, calls
the optional `onStreamDone()` after a clean iterator close, and calls the
optional `onStreamError()` after a non-client exception. The runner itself does
not manufacture a protocol error event; that depends on the selected strategy.

## Path-Specific Streaming

### Native Messages Path

Minimal transformation. Assistant-history sanitization happens before the
upstream call; returned Anthropic events are passed through with their event
name and data. The native strategy has no `onStreamDone()` or
`onStreamError()` hook.

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

### Protocol-Preserving OpenAI Paths

`/chat/completions` parses each JSON data frame so the adapter can normalize
the chunk, and passes `[DONE]` through. `/responses` fixes known stream IDs,
optionally maps terminal response objects, and otherwise preserves upstream
event data. Neither strategy defines `onStreamError()`, so a stream exception
is observable internally but does not produce a synthetic OpenAI/Responses
error frame.

## Error Recovery

### Path-Specific Behavior

| Path | Exception while consuming the stream | Clean EOF without the expected terminal event |
|---|---|---|
| Messages via Chat Completions | Emits an Anthropic `error` event | Closes open blocks and emits the normal final `message_delta` / `message_stop` when a message had started |
| Messages via Responses | Emits an Anthropic `error` event | Records `response_stream_eof` and emits `Responses stream ended without completion` as an Anthropic `error` event |
| Native Messages | Records the failure for observability; emits no synthetic frame | Passes through the upstream EOF |
| Public Chat Completions | Records the failure for observability; emits no synthetic frame | Passes through the upstream EOF |
| Public Responses | Records the failure for observability; emits no synthetic frame | Records `response_stream_eof`; emits no synthetic frame |

Malformed JSON throws on the two translated Messages paths and therefore uses
their Anthropic error hooks. The public Chat Completions path also parses JSON,
but has no protocol error hook; the public Responses path preserves malformed
non-terminal event data rather than validating every frame.

Within the Responses-to-Anthropic translator, completed function-call blocks
cannot be reopened, and more than 20 consecutive whitespace characters in an
arguments delta terminate translation with an Anthropic `error` event. A
terminal upstream `response.failed` event is also translated to an Anthropic
error and marks the observed request failed.

Client cancellation is a delivery outcome. `runStrategy()` suppresses both the
stream-error observer and strategy `onStreamError()` when the client signal is
already aborted.

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

Cleanup occurs immediately when `strategy.execute()` throws or a non-streaming
result is translated. For streams it runs in the generator's `finally` block,
so listeners remain active for the full consumption lifetime and are removed
on completion, failure, or cancellation.

## Timeout Handling

Configurable via `--upstream-timeout` CLI flag:

- Defaults to 1800 seconds; `0` disables the proxy-owned total-duration limit
- Applied per request to the upstream fetch
- On timeout: AbortSignal fires, stream terminates
- Before an upstream `Response` exists, the client receives HTTP 504
- Mid-stream, only the two Anthropic translation strategies synthesize an SSE
  `error` event; protocol-preserving paths terminate without a synthetic frame

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
timeout and it sits two levels down. The classifier is used before and after the
stream boundary: `handleRouteError` in `src/server.ts` maps a pre-first-byte
timeout to a `504`, while the Anthropic Chat and Responses translators receive
the same timeout object through their `onStreamError()` hooks and emit SSE
`error` frames. Protocol-preserving paths still record the sanitized stream
failure but do not synthesize a frame.
