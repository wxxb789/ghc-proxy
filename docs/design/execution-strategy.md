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

The `ExecutionStrategy<TResult, TChunk>` interface captures the varying parts, while `runStrategy()` handles the invariant plumbing.

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
async function runStrategy<TResult, TChunk>(
  strategy: ExecutionStrategy<TResult, TChunk>,
  signal: { signal: AbortSignal, clientSignal?: AbortSignal, cleanup: () => void },
): Promise<ExecutionResult>
```

The executor:
1. Calls `strategy.execute()` to get the upstream result
2. If non-streaming: returns `{ kind: 'json', data: strategy.translateResult(result) }`
3. If streaming: iterates the async iterable, translating each chunk via `translateStreamChunk`, yielding `SSEOutput` events via an `AsyncGenerator`
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

- Can apply context compaction only when explicitly enabled in config
- Rewrites `apply_patch` custom tools if enabled
- Forwards response events with minimal transformation

## Pipeline Runner: `runPipeline()`

Route handlers used to manually orchestrate parsing, model transformation, strategy selection, and error recovery inline (~70 lines of boilerplate per handler). The `runPipeline()` function (`src/pipeline/runner.ts`) extracts this into a generic orchestrator.

### Signature

```typescript
async function runPipeline<TPayload, TStrategyCtx>(
  params: PipelineParams,
  config: PipelineConfig<TPayload, TStrategyCtx>,
): Promise<PipelineResult>
```

The two type parameters let each route keep its own payload and strategy context types while sharing the same lifecycle.

### Lifecycle

`runPipeline` executes the Ingest -> Transform -> Dispatch stages in order:

1. **Ingest** -- calls `protocolRegistry.ingest()` for the configured protocol ID, producing a validated `payload` and `RequestMeta`.
2. **afterIngest hook** (optional) -- runs immediately after parsing. Routes use this for debug logging or header pre-processing (e.g., the messages handler extracts the `anthropic-beta` header here).
3. **Transform** -- applies the route's `ModelTransformChain`, updating the payload model and building a `ModelMappingInfo` trace for request logging.
4. **afterTransform hook** (optional) -- runs after model transformation. The chat-completions handler uses this to calculate token counts and set `max_tokens` defaults.
5. **Dispatch** -- creates a `CopilotClient` and upstream signal, builds the strategy context via `buildStrategyContext()`, selects the strategy from the `StrategyRegistry`, and executes it.

### Configuration

```typescript
interface PipelineConfig<TPayload, TStrategyCtx> {
  protocol: ProtocolId
  transformChain: ModelTransformChain
  strategyRegistry: StrategyRegistry<TStrategyCtx>
  buildStrategyContext: (ctx: BuildStrategyContextParams) => TStrategyCtx
  afterIngest?: (ctx: IngestContext<TPayload>) => TPayload | void
  afterTransform?: (ctx: TransformContext<TPayload>) => void | Promise<void>
}
```

Each route provides its own protocol ID, transform chain, strategy registry, and a `buildStrategyContext` function that maps the generic pipeline state into the route-specific strategy context type. The lifecycle hooks let routes inject route-specific logic at well-defined points without forking the pipeline. `afterIngest` may optionally return a replacement payload (used by `/responses` to swap in the emulator's upstream payload); when it returns `void` the ingested payload is used unchanged.

### Route Handler Integration

With `runPipeline`, route handlers become thin configuration objects. For example, the messages handler (`src/routes/messages/handler.ts`) is ~45 lines that configure the pipeline and return its result:

```typescript
export async function handleMessagesCore({ body, signal, headers }) {
  let anthropicBetaHeader: string | undefined
  return runPipeline<AnthropicMessagesPayload, MessagesStrategyContext>(
    { body, signal, headers },
    {
      protocol: 'anthropic-messages',
      transformChain: messagesModelChain,
      strategyRegistry: defaultStrategyRegistry,
      afterIngest({ payload, headers }) { /* extract beta header */ },
      buildStrategyContext(ctx) { /* map to MessagesStrategyContext */ },
    },
  )
}
```

The chat-completions handler follows the same pattern, adding an `afterTransform` hook for token counting. The responses handler (`src/routes/responses/handler.ts`) also runs through `runPipeline`: its emulator-mode logic fits the lifecycle hooks -- `afterIngest` returns the emulator's upstream payload (store decoration prep), `afterTransform` applies tool/input policies and context management, and `buildStrategyContext` wires the streaming/terminal decoration callbacks. The one piece outside the linear pipeline is the post-call decoration of the non-streaming JSON result, which the handler applies to the pipeline result before returning.

## Benefits

1. **DRY streaming logic** -- SSE write loop, error recovery, signal cleanup written once
2. **Testable strategies** -- Each strategy can be tested by calling its methods directly
3. **Consistent error handling** -- All paths emit protocol-level error events on failure
4. **Easy to add new paths** -- Implement the interface, pass to `executeStrategy()`
5. **DRY pipeline orchestration** -- `runPipeline()` eliminates repeated Ingest/Transform/Dispatch boilerplate across route handlers
