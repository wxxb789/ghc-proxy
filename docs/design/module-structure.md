# Module Structure

This document describes the source code organization and the responsibility of each module.

## Directory Layout

```text
src/
├── main.ts                    # CLI entry point (citty commands)
├── start.ts                   # Server startup logic
├── server.ts                  # Elysia app factory (Bun-native or @elysiajs/node adapter)
├── routes/                    # HTTP route handlers
│   ├── chat-completions/      # POST /chat/completions
│   ├── messages/              # POST /v1/messages
│   ├── responses/             # POST /v1/responses
│   ├── models/                # GET /models, /v1/models
│   ├── embeddings/            # POST /v1/embeddings
│   ├── token/                 # POST /token
│   ├── usage/                 # GET /usage
│   └── middleware/            # Request guard (auth, rate limiting)
├── translator/                # Protocol translation engines
│   ├── anthropic/             # Anthropic <-> OpenAI translation
│   └── responses/             # Anthropic <-> Responses translation
├── adapters/                  # High-level protocol adapters
├── clients/                   # Upstream API clients
├── core/                      # Core domain logic
│   ├── capi/                  # Copilot API abstraction layer
│   └── conversation/          # Conversation intermediate model
├── state/                     # Decomposed state stores
├── pipeline/                  # Pipeline runner and framework types
├── ingest/                    # Protocol registry (parse + validate)
├── transform/                 # Composable model transform chain + sanitizers
├── dispatch/                  # Strategy registry + ResourceDispatcher
├── deliver/                   # Response delivery + error utilities
├── guard/                     # Request auth + rate limiting guard
├── lib/                       # Shared utilities
└── types/                     # TypeScript type definitions
```

## Module Details

### `src/routes/` -- HTTP Route Handlers

Each route directory follows a consistent pattern:

```text
routes/<endpoint>/
├── route.ts        # Elysia route definition
├── handler.ts      # Orchestration via runPipeline() (ingest, transform, dispatch)
└── strategy.ts     # ExecutionStrategy implementation(s)
```

The messages route is more complex because it has three execution strategies:

```text
routes/messages/
├── route.ts
├── handler.ts                      # runPipeline() orchestration with afterIngest/afterTransform hooks
├── count-tokens-handler.ts         # Token counting sub-handler
└── strategies/
    ├── native-messages.ts          # Direct /v1/messages passthrough
    ├── responses-api.ts            # Via Anthropic <-> Responses translation
    └── chat-completions.ts         # Via Anthropic <-> OpenAI fallback
```

The responses route also has additional handlers:

```text
routes/responses/
├── route.ts
├── handler.ts                      # POST /responses create flow
├── resource-handler.ts             # GET/DELETE /responses/{id} and input_tokens
├── emulator.ts                     # Optional OpenAI-style local state emulation helpers
├── strategy.ts
└── context-management.ts           # Optional Responses context-management and compaction policies
```

The embeddings route is intentionally small:

```text
routes/embeddings/
├── route.ts                        # OpenAI-compatible /embeddings route
└── handler.ts                      # Validation + upstream-shape normalization
```

### `src/translator/` -- Protocol Translation

#### `translator/anthropic/` -- Anthropic <-> OpenAI

Three-layer translation architecture:

| Layer         | File(s)                       | Purpose                                           |
|---------------|-------------------------------|---------------------------------------------------|
| Normalization | `anthropic-normalizer.ts`     | Parse Anthropic request into IR                   |
|               | `openai-normalizer.ts`        | Parse OpenAI response into normalized form        |
|               | `ir.ts`                       | Intermediate representation type definitions      |
| Mapping       | `anthropic-openai-mapper.ts`  | Map normalized Anthropic -> OpenAI request        |
|               | `openai-anthropic-mapper.ts`  | Map normalized OpenAI -> Anthropic response       |
| Streaming     | `anthropic-stream-translator.ts` | Orchestrate stream event translation           |
|               | `anthropic-stream-transducer.ts` | Per-index delta buffering and tool reconstruction |
| Policy        | `translation-policy.ts`       | TranslationContext: issue tracking and mode       |
|               | `translation-issue.ts`        | Issue classification (exact/lossy/unsupported)    |

#### `translator/responses/` -- Anthropic <-> Responses

| File                               | Purpose                                         |
|------------------------------------|--------------------------------------------------|
| `anthropic-to-responses.ts`       | Convert Anthropic Messages to Responses items    |
| `responses-to-anthropic.ts`       | Convert Responses result to Anthropic format     |
| `responses-stream-translator.ts`  | Stateful streaming event translation             |
| `signature-codec.ts`              | Opaque encryption for reasoning/compaction state |

### `src/adapters/` -- Protocol Adapters

High-level adapters that wire together translators and clients:

- **AnthropicMessagesAdapter** -- Provides `toConversation()`, `fromCapiResponse()`, and `createStreamSerializer()` for the chat-completions fallback path.

### `src/clients/` -- Upstream API Clients

| Client          | Responsibility                                            |
|-----------------|-----------------------------------------------------------|
| `CopilotClient` | Main Copilot API client (chat, messages, responses, embeddings, models) |
| `GitHubClient`  | Device code auth, token refresh, user profile             |
| `VSCodeClient`  | VS Code version detection (used in request headers)       |

### `src/core/capi/` -- Copilot API Abstraction

| File                  | Purpose                                              |
|-----------------------|------------------------------------------------------|
| `types.ts`            | CAPI-specific types (CapiExecutionPlan, CapiMessage)  |
| `plan-builder.ts`     | Build execution plans from conversation requests     |
| `profile.ts`          | API endpoint profile selection by model family       |
| `request-context.ts`  | Infer interaction type from headers, normalize `x-session-id`, consume subagent markers, and apply initiator/session overrides |

### `src/core/conversation/` -- Conversation Model

Language-neutral intermediate model for message exchanges:

```text
ConversationRequest
  ├── model: string
  ├── turns: ConversationTurn[]
  │     ├── role: system | user | assistant | tool
  │     └── blocks: ConversationBlock[]
  │           ├── TextBlock
  │           ├── ImageBlock
  │           ├── ThinkingBlock
  │           ├── ToolUseBlock
  │           └── ToolResultBlock
  ├── tools: ConversationTool[]
  ├── thinking: ThinkingConfig
  └── completionOptions: CompletionOptions
```

### `src/lib/` -- Shared Utilities

| File                        | Purpose                                              |
|-----------------------------|------------------------------------------------------|
| `execution-strategy.ts`     | Generic ExecutionStrategy interface and executor     |
| `state.ts`                  | Global AppState (auth, config, cache, rate limit)    |
| `model-resolver.ts`         | Model ID resolution with configurable fallbacks      |
| `model-rewrite.ts`          | Unified model rewrite (user rules, normalization)    |
| `model-capabilities.ts`     | Query model endpoint support and capabilities        |
| `request-model-policy.ts`   | Smart model rerouting (compact detection)             |
| `function-schema.ts`        | Normalize function tool parameter schemas for Copilot compatibility |
| `api-config.ts`             | Copilot base URL, headers, request ID generation     |
| `validation/`               | Zod schemas for all request/response types (anthropic-messages, openai-chat, responses, embeddings, shared) |
| `error.ts`                  | HTTPError class, error forwarding, validation errors |
| `config.ts`                 | Config file reader (~/.ghc-proxy/config.json)        |
| `ghe-domain.ts`             | GitHub Enterprise domain URL resolution              |
| `rate-limit.ts`             | Request throttling (queue or error mode)             |
| `upstream-signal.ts`        | AbortSignal management for upstream requests         |
| `retry.ts`                  | Retry logic with exponential backoff                 |
| `request-timeout.ts`        | Request timeout helpers                              |
| `tokenizer.ts`              | Local token estimation via gpt-tokenizer (used only by `count_tokens` endpoint, not for response usage) |
| `request-logger.ts`         | Structured request/response logging                  |
| `async-iterable.ts`         | Streaming helpers                                    |
| `approval.ts`               | Manual approval workflow                             |
| `paths.ts`                  | Config/token file paths                              |
| `token.ts`                  | GitHub and Copilot token management                  |
| `responses-emulator-state.ts` | In-memory TTL state for the opt-in Responses official emulator |

### `src/types/` -- Type Definitions

| File            | Types                                                |
|-----------------|------------------------------------------------------|
| `copilot.ts`    | OpenAI-compatible types with Copilot extensions      |
| `responses.ts`  | OpenAI Responses API types                           |
| `github.ts`     | GitHub API types (auth, user)                        |
| `responses.ts`  | OpenAI Responses API types                           |

## New Pipeline Layers

### Pipeline-Stage Directories (added in architecture redesign)

```text
src/
├── state/           # Decomposed state stores (replaced global AppState)
├── pipeline/        # Pipeline runner (runPipeline) and framework types
├── ingest/          # Protocol registry (parse + validate per protocol)
├── transform/       # Composable model transform chain + payload sanitizers
├── dispatch/        # Strategy registry + ResourceDispatcher
├── deliver/         # Response delivery + error utilities
└── guard/           # Request auth + rate limiting guard
```

These layers co-exist with the original `src/lib/` and `src/routes/` structure. The new layers provide:

- **A generic pipeline runner** — `src/pipeline/runner.ts` exports `runPipeline()`, which wraps the three core stages (Ingest→Transform→Dispatch) with lifecycle hooks (`afterIngest`, `afterTransform`) and config-driven `contextRetry`. Guard is applied separately as an Elysia plugin, and Deliver happens after `runPipeline()` returns. Route handlers call `runPipeline()` instead of orchestrating each stage manually.
- **Composable alternatives to inline handler logic** — logic that was previously duplicated across route handlers is extracted into named, testable pipeline steps.
- **Registries instead of hardcoded switch/if-else** — `src/ingest/` and `src/dispatch/` use registry patterns so new protocols and strategies can be added without touching existing handler code.
- **Decomposed state instead of the global AppState object** — `src/state/` splits the monolithic `AppState` into focused stores (`AuthStore`, `ModelCache`, `ConfigStore`, `RateLimiter`, `EmulatorStore`), each with a single responsibility. `ConfigStore` consolidates scattered `shouldUse*()` config getter functions into a typed class with semantic query methods (e.g., `isEmulatorEnabled()`, `isContextUpgradeEnabled()`, `getReasoningEffort()`).

## Test Coverage Layout

- `tests/api-smoke.test.ts` covers public API compatibility.
- `tests/embeddings.test.ts` covers embeddings-specific normalization and diagnostics.
- `tests/validation.test.ts` covers request-schema validation.

`tests/helpers.ts` provides shared route mounting and mock helpers for those suites.
