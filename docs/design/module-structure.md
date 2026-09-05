# Module Structure

This document describes the source code organization and the responsibility of each module.

## Directory Layout

```text
src/
├── main.ts                    # CLI entry point (citty commands)
├── start.ts                   # Server startup logic
├── server.ts                  # Elysia app factory (Bun-native or @elysiajs/node adapter)
├── routes/                    # HTTP route handlers
│   ├── chat-completions/      # POST /chat/completions (+ /v1 alias)
│   ├── messages/              # POST /v1/messages
│   ├── responses/             # Responses create, input_tokens, and resource routes
│   ├── models/                # GET /models, /v1/models
│   ├── embeddings/            # POST /embeddings, /v1/embeddings
│   ├── token/                 # GET /token
│   ├── usage/                 # GET /usage
│   ├── dashboard/             # Loopback Dashboard assets and JSON projections
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
├── pipeline/                  # Pipeline runner (runPipeline)
├── ingest/                    # Protocol registry (parse + validate)
├── transform/                 # Model resolution + payload sanitizers
├── dispatch/                  # Strategy registry
├── deliver/                   # Response delivery + error utilities
├── guard/                     # Request auth + rate limiting guard
├── observability/             # Request activity projection + proxy-effect catalog
├── cli/                       # CLI helpers (proxy, shell, startup banner)
├── util/                      # Generic utilities (async-iterable, duration, sleep, version)
├── lib/                       # Shared utilities
└── types/                     # TypeScript type definitions
```

## Module Details

### `src/routes/` -- HTTP Route Handlers

Strategy-backed generative routes use the following pattern:

```text
routes/<endpoint>/
├── route.ts        # Elysia route definition
├── handler.ts      # Orchestration via runPipeline() (ingest, transform, dispatch)
├── strategy.ts     # ExecutionStrategy implementation(s)
└── strategy-registry.ts # Per-route strategy selection and execution
```

Small routes such as token, usage, models, and embeddings intentionally use
only the files they need. Responses resource operations and the Dashboard also
bypass `runPipeline()` because they are not model-generation dispatches.

The messages route is more complex because it has three execution strategies:

```text
routes/messages/
├── route.ts
├── handler.ts                      # runPipeline() orchestration with afterIngest/afterTransform hooks
├── count-tokens-handler.ts         # Token counting sub-handler
├── shared.ts                       # Anthropic adapter construction
├── strategy-registry.ts            # Native / Responses / Chat selection and transforms
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
├── resource-handler.ts             # Resource parameter parsing and core handlers
├── emulator.ts                     # Optional OpenAI-style local state emulation helpers
├── resource-dispatcher.ts          # Emulator/upstream dispatch for retrieve, list, delete, input_tokens
├── strategy.ts                     # Responses passthrough + stream ID/terminal handling
└── strategy-registry.ts            # Per-model strategy selection for /responses
```

(Responses context-management and compaction policies now live in `src/transform/context-management.ts`, not under this route directory.)

The embeddings route is intentionally small, and the Dashboard owns a separate
read-only presentation surface:

```text
routes/embeddings/
├── route.ts                        # OpenAI-compatible /embeddings route
└── handler.ts                      # Validation + upstream-shape normalization

routes/dashboard/
├── route.ts                        # Loopback access checks and routes
├── handler.ts                      # Sanitized overview/model/behavior/request projections
└── assets.ts                       # Embedded HTML/CSS/JavaScript assets
```

### `src/translator/` -- Protocol Translation

#### `translator/anthropic/` -- Anthropic <-> OpenAI

Translation building blocks for the Messages Chat-Completions fallback. That
request path no longer uses a standalone Anthropic -> OpenAI payload mapper;
it runs Anthropic -> normalized IR -> Conversation -> CAPI through
`AnthropicMessagesAdapter` (see `src/adapters/`).

| Layer         | File(s)                       | Purpose                                           |
|---------------|-------------------------------|---------------------------------------------------|
| Normalization | `anthropic-normalizer.ts`     | Parse Anthropic request into normalized IR         |
|               | `openai-normalizer.ts`        | Parse CAPI/OpenAI response into normalized IR      |
|               | `ir.ts`                       | Normalized request/response type definitions       |
| Mapping       | `openai-anthropic-mapper.ts`  | Map normalized OpenAI -> Anthropic response        |
| Streaming     | `anthropic-stream-transducer.ts` | `AnthropicStreamTranslator`, per-index delta buffering, and tool reconstruction |
| Policy        | `translation-policy.ts`       | `TranslationPolicy` plus `TranslationContext` issue tracking |
|               | `translation-issue.ts`        | `TranslationIssue`, severity metadata, and `TranslationFailure` |

#### `translator/responses/` -- Anthropic <-> Responses

| File                               | Purpose                                         |
|------------------------------------|--------------------------------------------------|
| `anthropic-to-responses.ts`       | Convert Anthropic Messages to Responses items    |
| `responses-to-anthropic.ts`       | Convert Responses result to Anthropic format     |
| `responses-stream-translator.ts`  | Stateful streaming event translation             |
| `signature-codec.ts`              | Pack/unpack opaque reasoning and compaction carriers |
| `function-schema.ts`              | Normalize function tool parameter schemas for Copilot compatibility |

### `src/adapters/` -- Protocol Adapters

High-level adapters that wire ingress protocols to the Conversation model and
CAPI plan builder, then sanitize/map CAPI responses back to the public protocol:

- **`AnthropicMessagesAdapter`** -- Provides `toConversation()`, `toCapiPlan()`, `toTokenCountPayload()`, `fromCapiResponse()`, and `createStreamSerializer()` for the Messages Chat-Completions fallback.
- **`OpenAIChatAdapter`** -- Provides the request/plan boundary for the public Chat Completions route, plus `fromCapiResponse()` and `serializeStreamChunk()` to remove CAPI-only response fields.

### `src/clients/` -- Upstream API Clients

| Client          | Responsibility                                            |
|-----------------|-----------------------------------------------------------|
| `CopilotClient` | Main Copilot API client (chat, messages, Responses create/resources/input_tokens, embeddings, models) |
| `GitHubClient`  | Device code auth, token refresh, user profile             |
| `VSCodeClient`  | VS Code version detection (used in request headers)       |

`clients/factory.ts` owns configured client/queue creation.
`clients/upstream-queue.ts` owns global concurrency, bounded pending depth,
transient retries, cooldowns, recovery deadlines, and recovery records.

### `src/core/capi/` -- Copilot API Abstraction

| File                  | Purpose                                              |
|-----------------------|------------------------------------------------------|
| `types.ts`            | CAPI-specific types (CapiExecutionPlan, CapiMessage)  |
| `plan-builder.ts`     | Build execution plans from conversation requests     |
| `profile.ts`          | API endpoint profile selection by model family       |
| `request-context.ts`  | Infer interaction type from headers, normalize `x-session-id`, consume subagent markers, and apply initiator/session overrides |
| `subagent-marker.ts`  | Parse and remove synthetic subagent marker blocks    |
| `headers.ts`          | Build CAPI request headers from normalized context    |

### `src/core/conversation/` -- Conversation Model

Language-neutral intermediate model for message exchanges:

```text
ConversationRequest
  ├── model: string
  ├── turns: ConversationTurn[]
  │     ├── role: system | developer | user | assistant | tool
  │     └── blocks: ConversationBlock[]
  │           ├── TextBlock
  │           ├── ImageBlock
  │           ├── ThinkingBlock
  │           ├── RedactedThinkingBlock
  │           ├── ToolUseBlock
  │           └── ToolResultBlock
  ├── maxTokens / stopSequences / stream
  ├── temperature / topP / topK / userId
  ├── tools / toolChoice / thinking / outputEffort
  └── completionOptions: CompletionOptions
```

`ConversationTurn.meta` carries CAPI-only response-history fields such as
`toolCallId`, `reasoningOpaque`, `encryptedContent`, `phase`, and
`copilotAnnotations`. The Conversation model is used by the Chat Completions
route and the Messages Chat fallback; the Anthropic↔Responses translators are
direct and do not pass through this model.

### `src/lib/` -- Shared Utilities

| File                        | Purpose                                              |
|-----------------------------|------------------------------------------------------|
| `execution-strategy.ts`     | Generic ExecutionStrategy interface and executor     |
| `model-resolver.ts`         | Model ID resolution with configurable fallbacks      |
| `error.ts`                  | HTTPError class, error forwarding, validation errors |
| `config.ts`                 | Config file reader (`~/.local/share/ghc-proxy/config.json`) |
| `credentials.ts`            | Versioned named-account credential storage and legacy config migration |
| `upstream-signal.ts`        | AbortSignal management for upstream requests         |
| `retry.ts`                  | Retry logic with exponential backoff                 |
| `request-timeout.ts`        | Request timeout helpers                              |
| `sse-adapter.ts`            | SSE stream adapter helpers                            |
| `tokenizer.ts`              | Local token estimation for Messages `count_tokens`, Chat diagnostics, emulator `responses/input_tokens`, and packaged selfcheck probes; never used to manufacture generation response usage |
| `request-logger.ts`         | Structured request/response logging                  |
| `paths.ts`                  | Config/token file paths                              |
| `token.ts`                  | GitHub and Copilot token management                  |

Several modules formerly under `src/lib/` were relocated during the consolidation refactor:

- `state.ts` -> decomposed into `src/state/` singletons (no monolithic `AppState` object remains).
- `responses-emulator-state.ts` -> `src/state/responses-emulator-state.ts`.
- `upstream-request-queue.ts` -> `src/clients/upstream-queue.ts`; `api-config.ts` -> `src/clients/api-config.ts`; `ghe-domain.ts` -> `src/clients/ghe-domain.ts`.
- `validation/` -> `src/ingest/validation/`.
- `model-rewrite.ts`, `request-model-policy.ts` -> `src/transform/`.
- `function-schema.ts` -> `src/translator/responses/function-schema.ts`.
- `approval.ts` -> `src/guard/approval.ts`.
- `proxy.ts`, `shell.ts`, `startup-banner.ts` -> `src/cli/`.
- `async-iterable.ts` (and other small helpers) -> `src/util/`.
- `rate-limit.ts` -> rate limiting now lives in `src/state/rate-limiter.ts`.

### `src/observability/` -- Safe Runtime Projection

| File               | Purpose |
|--------------------|---------|
| `request-store.ts` | Bounded active/recent request lifecycle records, model traces, strategies, counted effects, and sanitized errors |
| `effects.ts`       | Stable IDs and labels for model, strategy, parameter, context, tool, and recovery effects |

`src/state/runtime.ts` owns the process-local `RuntimeStore` and its
`RequestActivityStore`. The projection intentionally stores no request bodies,
prompt content, tool arguments, headers, or raw error messages.

### `src/cli/` -- CLI Helpers

| File                  | Purpose                                              |
|-----------------------|------------------------------------------------------|
| `proxy.ts`            | Proxy configuration / dispatch helpers               |
| `shell.ts`            | Shell integration helpers                            |
| `startup-banner.ts`   | Startup banner rendering                             |

### `src/util/` -- Generic Utilities

| File                  | Purpose                                              |
|-----------------------|------------------------------------------------------|
| `async-iterable.ts`   | Streaming helpers                                    |
| `assert-never.ts`     | Exhaustiveness assertion helper                      |
| `duration.ts`         | Duration parsing/formatting                          |
| `sleep.ts`            | Async sleep helper                                   |
| `version.ts`          | Package version resolution                           |

### `src/types/` -- Type Definitions

| File            | Types                                                |
|-----------------|------------------------------------------------------|
| `copilot.ts`    | OpenAI-compatible types with Copilot extensions      |
| `responses.ts`  | OpenAI Responses API types                           |
| `github.ts`     | GitHub API types (auth, user)                        |

## Pipeline Layers

### Pipeline-Stage Directories

```text
src/
├── state/           # Decomposed state singletons (replaced the former global AppState)
├── pipeline/        # Pipeline runner (runPipeline)
├── ingest/          # Protocol registry (parse + validate per protocol)
├── transform/       # Model resolution + payload sanitizers
├── dispatch/        # Strategy registry
├── deliver/         # Response delivery + error utilities
├── guard/           # Request auth + rate limiting guard
└── observability/   # Safe operational projection for Dashboard/runtime logs
```

These layers co-exist with `src/lib/` and `src/routes/` and provide:

- **A generic pipeline runner** — `src/pipeline/runner.ts` exports `runPipeline()`, which wraps the three core stages (Ingest→Transform→Dispatch) with lifecycle hooks (`afterIngest`, `afterTransform`). Guard is applied separately as an Elysia plugin, and Deliver happens after `runPipeline()` returns. Route handlers call `runPipeline()` instead of orchestrating each stage manually.
- **Composable alternatives to inline handler logic** — logic that was previously duplicated across route handlers is extracted into named, testable pipeline steps.
- **Registries instead of hardcoded switch/if-else** — `src/ingest/` and `src/dispatch/` use registry patterns so new protocols and strategies can be added without touching existing handler code.
- **Decomposed state instead of the global AppState object** — `src/state/` splits the former monolithic `AppState` into focused singleton stores (`authStore`, `configStore`, `modelCache`, `rateLimiter`, `runtimeStore`, `responsesEmulatorState`), each with a single responsibility, all re-exported from `~/state`. No `AppState` interface remains in the codebase. `RuntimeStore` owns request activity; `ConfigStore` exposes typed semantic queries such as `isEmulatorEnabled()`, `isContextManagementEnabled()`, and `getReasoningEffort()`.

## Test Coverage Layout

The suite is organized by behavior rather than mirroring every source file.
Representative coverage includes:

- `tests/contract-smoke.test.ts` for public API compatibility.
- `tests/validation.test.ts` for ingress schemas.
- `tests/messages-routing.test.ts`, Responses suites, and adapter/translator suites for strategy and protocol behavior.
- `tests/pipeline-internals.test.ts` and queue/recovery suites for shared dispatch behavior.
- Dashboard and request-store suites for safe projections, dynamic route classification, and access checks.
- `scripts/smoke/packaged-cli.ts` for bundled CLI probes under both Bun and Node.

See `tests/AGENTS.md` for current helper and fixture conventions instead of
assuming a single shared helper owns every suite.
