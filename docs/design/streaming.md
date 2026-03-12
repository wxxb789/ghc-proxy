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
[Hono streamSSE]             Write SSE events to client
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
