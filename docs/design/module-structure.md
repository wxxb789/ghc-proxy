# Module Structure

This document describes the source code organization and the responsibility of each module.

## Directory Layout

```text
src/
├── main.ts                    # CLI entry point (citty commands)
├── start.ts                   # Server startup logic
├── app.ts                     # Hono app factory
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
├── lib/                       # Shared utilities
└── types/                     # TypeScript type definitions
```

## Module Details

### `src/routes/` -- HTTP Route Handlers

Each route directory follows a consistent pattern:

```text
routes/<endpoint>/
├── route.ts        # Hono route definition (app.post / app.get)
├── handler.ts      # Request parsing, validation, strategy dispatch
└── strategy.ts     # ExecutionStrategy implementation(s)
```

The messages route is more complex because it has three execution strategies:

```text
routes/messages/
├── route.ts
├── handler.ts                      # Model routing, policy checks
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
├── handler.ts
├── resource-handler.ts             # GET/DELETE /responses/{id}
├── strategy.ts
└── context-management.ts           # Context compaction logic
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
| `request-context.ts`  | Infer interaction type and context from headers      |

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
| `model-capabilities.ts`     | Query model endpoint support and capabilities        |
| `request-model-policy.ts`   | Smart model rerouting (compact/warmup detection)     |
| `api-config.ts`             | Copilot base URL, headers, request ID generation     |
| `validation.ts`             | Zod schemas for all request/response types           |
| `error.ts`                  | HTTPError class, error forwarding, validation errors |
| `config.ts`                 | Config file reader (~/.ghc-proxy/config.json)        |
| `rate-limit.ts`             | Request throttling (queue or error mode)             |
| `upstream-signal.ts`        | AbortSignal management for upstream requests         |
| `tokenizer.ts`              | Token counting via gpt-tokenizer                     |
| `request-logger.ts`         | Structured request/response logging                  |
| `async-iterable.ts`         | Streaming helpers                                    |
| `approval.ts`               | Manual approval workflow                             |
| `paths.ts`                  | Config/token file paths                              |
| `token.ts`                  | GitHub and Copilot token management                  |

### `src/types/` -- Type Definitions

| File            | Types                                                |
|-----------------|------------------------------------------------------|
| `copilot.ts`    | OpenAI-compatible types with Copilot extensions      |
| `responses.ts`  | OpenAI Responses API types                           |
| `github.ts`     | GitHub API types (auth, user)                        |
| `hono.d.ts`     | Hono context type extensions                         |
