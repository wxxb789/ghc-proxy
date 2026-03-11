# Execution Strategy Pattern

This document describes the `ExecutionStrategy` pattern, the central abstraction that unifies request handling across all route handlers.

## The Problem

ghc-proxy needs to handle both streaming and non-streaming responses across multiple execution paths (native messages, responses translation, chat-completions fallback). Each path has different:

- Request body preparation logic
- Upstream endpoint selection
- Response transformation rules
- Streaming chunk translation
- Error handling

Without a shared abstraction, each route handler would duplicate the streaming/non-streaming dispatch, SSE serialization, error recovery, and signal cleanup logic.

## The Solution

The `ExecutionStrategy<TResult, TChunk>` interface captures the varying parts, while `executeStrategy()` handles the invariant plumbing.

### Interface

```typescript
interface ExecutionStrategy<TResult, TChunk> {
  // Execute the upstream request (returns full response or async stream)
  execute: () => Promise<TResult>

  // Type guard: is this a streaming result?
  isStream: (result: TResult) => result is TResult & AsyncIterable<TChunk>

  // Non-streaming: transform the full response to client format
  translateResult: (result: TResult) => unknown

  // Streaming: transform each chunk to SSE output(s)
  translateStreamChunk: (chunk: TChunk) => SSEOutput | SSEOutput[] | null

  // Optional: emit final SSE events after stream ends
  onStreamDone?: () => SSEOutput | SSEOutput[] | null

  // Optional: emit error SSE events on stream failure
  onStreamError?: (error: unknown) => SSEOutput | SSEOutput[] | null

  // Optional: early termination condition
  shouldBreakStream?: (chunk: TChunk) => boolean
}
```

### Executor

```typescript
async function executeStrategy<TResult, TChunk>(
  c: Context,
  strategy: ExecutionStrategy<TResult, TChunk>,
  signal: { signal: AbortSignal, cleanup: () => void },
): Promise<Response>
```

The executor:
1. Calls `strategy.execute()` to get the upstream result
2. If non-streaming: returns `c.json(strategy.translateResult(result))`
3. If streaming: iterates the async iterable, translating each chunk via `translateStreamChunk`, writing SSE events via Hono's `streamSSE`
4. On stream completion: calls `onStreamDone()` for any final events
5. On stream error (if client not aborted): calls `onStreamError()` for error events
6. Always calls `signal.cleanup()` in the finally block

### Key Design Choice: SSEOutput Return Type

Each translation method returns `SSEOutput | SSEOutput[] | null`:

- `null` -- skip (chunk produces no output)
- `SSEOutput` -- single event
- `SSEOutput[]` -- multiple events from one chunk (e.g., Anthropic stream needs `content_block_start` + `content_block_delta` from a single OpenAI delta)

## Strategy Implementations

### Chat Completions Strategy

```text
routes/chat-completions/strategy.ts
```

The simplest strategy. Passes OpenAI Chat format through to Copilot with minimal transformation:

- `execute()` → `CopilotClient.createChatCompletions()`
- `translateStreamChunk()` → forward `data: {chunk}` as-is
- `onStreamDone()` → `data: [DONE]`

### Messages Strategies

Three strategies in `routes/messages/strategies/`:

#### 1. Native Messages (`native-messages.ts`)

Near-passthrough to Copilot's `/v1/messages` endpoint:

- Filters stale assistant thinking blocks
- Fills adaptive thinking config if model supports it
- Forwards response events with minimal transformation

#### 2. Responses API (`responses-api.ts`)

Translates Anthropic Messages ↔ Responses format:

- `execute()` → translates request via `anthropic-to-responses`, calls `CopilotClient.createResponses()`
- `translateStreamChunk()` → uses `ResponsesStreamTranslator` to emit Anthropic-format SSE events
- `onStreamDone()` → flushes translator state for any pending events

#### 3. Chat Completions Fallback (`chat-completions.ts`)

Full Anthropic ↔ OpenAI translation:

- `execute()` → normalizes via adapter, builds CAPI plan, calls `CopilotClient.createChatCompletions()`
- `translateStreamChunk()` → uses `AnthropicStreamTranslator` with per-index transducers
- `onStreamDone()` → emits `message_stop` with final usage

### Responses Strategy

```text
routes/responses/strategy.ts
```

Passes OpenAI Responses format through to Copilot:

- Applies context compaction if configured
- Rewrites `apply_patch` custom tools if enabled
- Forwards response events with minimal transformation

## Benefits

1. **DRY streaming logic** -- SSE write loop, error recovery, signal cleanup written once
2. **Testable strategies** -- Each strategy can be tested by calling its methods directly
3. **Consistent error handling** -- All paths emit protocol-level error events on failure
4. **Easy to add new paths** -- Implement the interface, pass to `executeStrategy()`
