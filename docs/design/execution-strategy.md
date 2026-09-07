# Execution Strategy Pattern

This document describes the `ExecutionStrategy` pattern, the shared execution
abstraction used by the pipeline-driven generation routes. Small direct routes
such as models, embeddings, usage, token, and Dashboard do not use it.

## The Problem

ghc-proxy needs to handle both streaming and non-streaming responses across multiple execution paths (native messages, responses translation, chat-completions fallback). Each path has different:

- Request body preparation logic
- Upstream endpoint selection
- Response transformation rules
- Streaming chunk translation
- Error handling

Without a shared abstraction, each route handler would duplicate the streaming/non-streaming dispatch, SSE serialization, optional protocol-error conversion, observability notification, and signal cleanup logic.

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
  signal: {
    signal: AbortSignal
    clientSignal?: AbortSignal
    cleanup: () => void
  },
  observer?: { onStreamError?: (error: unknown) => void },
): Promise<ExecutionResult>
```

The executor:
1. Calls `strategy.execute()` to get the upstream result
2. If non-streaming: returns `{ kind: 'json', data: strategy.translateResult(result) }`
3. If streaming: iterates the async iterable, translating each chunk via `translateStreamChunk`, yielding `SSEOutput` events via an `AsyncGenerator`
4. On stream completion: calls `onStreamDone()` for any final events
5. On client abort: relies on the linked upstream signal to record the
   cancellation, then does not report a stream failure or synthesize a
   protocol error event
6. On other stream errors: notifies the optional metadata-only observer, then
   calls `onStreamError()` for protocol error events
7. Always calls `signal.cleanup()`, which removes the linked client-abort
   listener

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

The public Chat Completions path is adapter-backed rather than a raw proxy:

- `OpenAIChatAdapter.toCapiPlan()` normalizes the OpenAI payload through the Conversation model and builds the CAPI execution plan.
- `execute()` calls `CopilotClient.createChatCompletions()` with that plan and its normalized request context.
- `translateResult()` calls `OpenAIChatAdapter.fromCapiResponse()` to strip CAPI-only response fields.
- `translateStreamChunk()` preserves SSE metadata and `[DONE]`, while parsed data chunks pass through `OpenAIChatAdapter.serializeStreamChunk()`.

This passthrough-shaped strategy has no `onStreamError()` hook; `runStrategy()`
still notifies request observability for non-client-cancellation failures.

### Messages Strategies

Three strategies in `routes/messages/strategies/`:

#### 1. Native Messages (`native-messages.ts`)

Near-passthrough to Copilot's `/v1/messages` endpoint. The registry performs
native compatibility reconciliation before constructing the strategy: thinking
shape/history, output config/format, mutually exclusive sampling parameters,
cache-control metadata, and output-token limits. The strategy then removes the
runtime-only top-level `citations` field and flattens mixed search-result tool
content before forwarding response events with minimal transformation.

Native Messages has no `onStreamError()` hook, so a caught stream failure is
observed but does not synthesize an Anthropic event.

#### 2. Responses API (`responses-api.ts`)

Translates Anthropic Messages ↔ Responses format:

- `execute()` → translates request via `anthropic-to-responses`, calls `CopilotClient.createResponses()`
- `translateStreamChunk()` → uses `ResponsesStreamTranslator` to emit Anthropic-format SSE events
- `onStreamDone()` → turns an unterminated stream into a terminal Anthropic error event
- `onStreamError()` → translates caught stream/parser failures into an Anthropic error event
- Terminal Responses events are observed so `response.failed` and EOF without a terminal event are visible in request activity

#### 3. Chat Completions Fallback (`chat-completions.ts`)

Full Anthropic ↔ OpenAI translation:

- `execute()` → normalizes via adapter, builds CAPI plan, calls `CopilotClient.createChatCompletions()`
- `translateStreamChunk()` → uses `AnthropicStreamTranslator` with per-index transducers
- `onStreamDone()` → emits `message_delta`/`message_stop` and includes final upstream usage when present
- `onStreamError()` → uses the stream translator to emit an Anthropic error event

### Responses Strategy

```text
routes/responses/strategy.ts
```

Passes OpenAI Responses format through to Copilot. The route's
`afterTransform()` hook applies tool normalization, the fixed input policy,
compaction/context management, per-model parameter filters, and output/reasoning
clamps before the strategy runs. The strategy itself:

- calls `CopilotClient.createResponses()`;
- stabilizes response/item IDs across streamed events;
- applies optional emulator response decoration and persistence callbacks;
- recognizes `response.completed`, `response.incomplete`, and `response.failed` as terminal events; and
- forwards non-JSON data unchanged rather than inventing a protocol error.

The passthrough strategy has no `onStreamError()` hook. An EOF without a
terminal event is recorded by its callback, and stream exceptions are recorded
by the shared observer.

## Pipeline Runner: `runPipeline()`

Route handlers used to orchestrate parsing, model transformation, strategy
selection, and error recovery inline. The `runPipeline()` function
(`src/pipeline/runner.ts`) extracts that repeated lifecycle into a generic
orchestrator.

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
2. **afterIngest hook** (optional) -- runs immediately after parsing and must return the payload that continues through the pipeline. Routes use it for debug/header processing or to replace the payload (the Responses emulator supplies its expanded upstream payload here).
3. **Transform** -- calls `resolveRequestModel()`, which applies the model rewrite, optional compact small-model routing, and the cached-model lookup, updating `payload.model` and building a `ModelMappingInfo` trace for request logging.
4. **afterTransform hook** (optional) -- runs after model transformation. Chat applies output-token default/rename handling without local prompt tokenization; Responses applies its tool/input/context/parameter policies.
5. **Dispatch** -- creates a `CopilotClient` and upstream signal, builds the strategy context via `buildStrategyContext()`, selects the strategy from the `StrategyRegistry`, records authoritative observability, and executes it. The source attempt is recorded immediately; fallback-attempt mapping, strategy, and effects are deferred until that target becomes authoritative.

`runPipeline()` also owns the only overload-fallback branch. It preserves pristine post-ingest input before the source attempt. After a terminal source-model `529` (or a pre-existing local source cooldown), it looks up one exact `overloadFallbacks` target, validates advertised capabilities, and calls the same preparation boundary again with that target. This reruns transforms, capability checks, strategy-context construction, and registry selection without reapplying source model resolution. The target dispatch receives no new retry allowance and cannot trigger another fallback.

Fallback preflight and pre-fetch failures preserve the source `529` and its
model/strategy observability. Once target fetch begins, the fallback attempt
becomes authoritative and commits its model mapping, selected strategy, and
effects exactly once, including when the target later fails. Effects emitted
while preparing or executing the fallback are buffered per request until that
fetch boundary; a pre-fetch failure discards the buffer instead of attaching
target-only transforms to the source result. A successful result rewrites known
model identity fields in JSON or SSE to the actual target and appends
`OVERLOAD_FALLBACK` to the access-log trace. Responses emulator persistence
therefore records the served target, not the failed source.

The replay boundary is earlier than delivery: once `strategy.execute()` obtains an upstream `Response`, the queue has committed the request. `runStrategy()` may later translate JSON, iterate a stream, or emit a protocol error, but a body failure or stream failure before the first client event never re-enters retry or fallback. Caller cancellation and normal upstream timeout cleanup remain active during delivery; the recovery deadline covers only pre-`Response` work.

### Configuration

```typescript
interface PipelineConfig<TPayload, TStrategyCtx> {
  protocol: ProtocolId
  applyModelPolicy?: boolean // compact small-model routing; /v1/messages only
  strategyRegistry: StrategyRegistry<TStrategyCtx>
  buildStrategyContext: (ctx: {
    payload: TPayload
    meta: RequestMeta
    headers: Headers
    selectedModel: Model | undefined
    copilotClient: CopilotClient
    upstreamSignal: ReturnType<typeof createUpstreamSignalFromConfig>
    modelMapping: ModelMappingInfo
    recovery: UpstreamRecoveryRecord
  }) => TStrategyCtx
  afterIngest?: (ctx: IngestContext<TPayload>) => TPayload
  afterTransform?: (ctx: TransformContext<TPayload>) => void | Promise<void>
}
```

Each route provides its own protocol ID, strategy registry, and a `buildStrategyContext` function that maps the generic pipeline state into the route-specific strategy context type. Model resolution is shared: every route runs the same `resolveRequestModel()`, and `applyModelPolicy` selects whether compact small-model routing participates (only `/v1/messages` sends the Anthropic-shaped payload the policy inspects). The lifecycle hooks let routes inject route-specific logic at well-defined points without forking the pipeline. `afterIngest` resolves the payload that flows into transform/dispatch and its return is required: side-effect-only callers end with `return ctx.payload` to forward the ingested payload unchanged, while replacement callers (e.g. `/responses`) return a different payload to swap in the emulator's upstream payload. The required return makes a forgotten replacement a compile error rather than a silent fallback.

`buildStrategyContext` receives the full mutable `ModelMappingInfo` and shared
`UpstreamRecoveryRecord`, not a standalone `requestId`. Route contexts commonly
project `recovery.requestId` for metadata-only stream observation while retaining
`modelMapping` so adapter-level model resolution can append a trace step. The
observability projection does not receive request content.

### Route Handler Integration

With `runPipeline`, route handlers become configuration objects. The Messages
handler follows this shape:

```typescript
export async function handleMessagesCore({ body, signal, headers, requestId, callerRequestId }) {
  let anthropicBetaHeader: string | undefined
  return runPipeline<AnthropicMessagesPayload, MessagesStrategyContext>(
    { body, signal, headers, requestId, callerRequestId },
    {
      protocol: 'anthropic-messages',
      applyModelPolicy: true,
      strategyRegistry: defaultStrategyRegistry,
      afterIngest({ payload, headers }) {
        /* normalize anthropic-beta */
        return payload
      },
      buildStrategyContext({ payload, meta, headers, selectedModel, copilotClient, upstreamSignal, modelMapping, recovery }) {
        return {
          requestId: recovery.requestId,
          copilotClient,
          anthropicPayload: payload,
          anthropicBetaHeader,
          selectedModel,
          upstreamSignal,
          headers,
          requestContext: meta.requestContext ?? {},
          modelMapping,
        }
      },
    },
  )
}
```

The chat-completions handler follows the same pattern, adding an `afterTransform` hook that defaults `max_tokens` from model limits and then applies the model-specific `max_tokens` to `max_completion_tokens` rename. It performs no local token counting. The responses handler (`src/routes/responses/handler.ts`) also runs through `runPipeline`: its emulator-mode logic fits the lifecycle hooks -- `afterIngest` returns the emulator's upstream payload (store decoration prep), `afterTransform` applies tool/input policies and context management, and `buildStrategyContext` clones that attempt's final transformed input while wiring the streaming/terminal decoration callbacks. Both the streaming and non-streaming responses are decorated and persisted through those same callbacks inside the passthrough strategy (`translateStreamChunk` and `translateResult`). A fallback attempt captures its own final input, so the terminal attempt's dispatched input is the one stored. The handler remains pure pipeline configuration with no post-call processing.

## Benefits

1. **DRY streaming logic** -- SSE iteration, optional error-event hooks, observer notification, and signal cleanup written once
2. **Testable strategies** -- Each strategy can be tested by calling its methods directly
3. **Explicit error scope** -- Translated paths opt into protocol-level error events; passthrough paths retain upstream behavior while shared observability still records failures
4. **Easy to add new paths** -- Implement the interface and pass it to `runStrategy()`
5. **DRY pipeline orchestration** -- `runPipeline()` eliminates repeated Ingest/Transform/Dispatch boilerplate across route handlers
