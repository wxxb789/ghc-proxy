# Architecture Overview

This document describes the high-level architecture of ghc-proxy.

## What ghc-proxy Does

ghc-proxy is a reverse-engineered API translation proxy that converts GitHub Copilot's API into OpenAI and Anthropic compatible formats. It enables tools like Claude Code, Cursor, and any OpenAI/Anthropic-speaking client to use a GitHub Copilot subscription. Public routes stay schema-compatible with the official surface they present; Copilot-specific differences are handled inside the proxy.

## Technology Stack

| Component       | Technology                      |
|-----------------|---------------------------------|
| Runtime         | Bun >= 1.2 (first-class), Node.js compatible |
| Language        | TypeScript (ESNext, strict)     |
| HTTP Framework  | Elysia (`@elysiajs/node` adapter for Node.js) |
| CLI Framework   | citty                           |
| Validation      | Zod                             |
| Token Counting  | gpt-tokenizer                   |
| SSE Streaming   | fetch-event-stream              |
| Build Tool      | tsdown                          |
| Linting         | ESLint (@antfu/eslint-config)   |
| Published As    | `ghc-proxy` npm package          |

## High-Level Request Flow

```text
Client Request (OpenAI / Anthropic format)
    |
    v
+-------------------------------------------+
|             Elysia Router                 |
|  /chat/completions  /v1/messages  /v1/responses  /models  ...
+-------------------------------------------+
    |
    v
+-------------------------------------------+
|          Request Validation (Zod)         |
+-------------------------------------------+
    |
    v
+-------------------------------------------+
|   Request Context Normalization           |
|  (header aliases, subagent markers,       |
|   initiator/session overrides)            |
+-------------------------------------------+
    |
    v
+-------------------------------------------+
|         Model Policy & Routing            |
|  (resolve model, smart rerouting,         |
|   compact detection)                     |
+-------------------------------------------+
    |
    v
+-------------------------------------------+
|      Execution Strategy Selection         |
|  (per-model, based on endpoint support)   |
+-------------------------------------------+
    |                    |                    |
    v                    v                    v
+-----------+    +-------------+    +------------------+
| Native    |    | Responses   |    | Chat Completions |
| Messages  |    | Translation |    | Fallback         |
| Passthru  |    | Path        |    | Path             |
+-----------+    +-------------+    +------------------+
    |                    |                    |
    v                    v                    v
+-------------------------------------------+
|           Copilot Client                  |
|  (HTTP fetch, auth, headers, streaming)   |
+-------------------------------------------+
    |
    v
+-------------------------------------------+
|      GitHub Copilot Upstream API          |
+-------------------------------------------+
    |
    v
+-------------------------------------------+
|        Response Translation               |
|  (reverse mapping back to client format)  |
+-------------------------------------------+
    |
    v
Client Response (OpenAI / Anthropic format)
```

## Exposed Endpoints

| Endpoint                   | Format     | Purpose                                |
|----------------------------|------------|----------------------------------------|
| `POST /chat/completions`  | OpenAI     | Chat completions (direct proxy)        |
| `POST /v1/messages`       | Anthropic  | Anthropic Messages API                 |
| `POST /v1/responses`      | OpenAI     | OpenAI Responses API                   |
| `POST /v1/embeddings`     | OpenAI     | Embeddings                             |
| `GET  /v1/models`         | OpenAI     | List available models                  |
| `GET  /models`            | OpenAI     | List available models (alias)          |
| `POST /token`             | Internal   | Token management                       |
| `GET  /usage`             | Internal   | Copilot usage statistics               |
| `GET  /health`            | Internal   | Health check (`status`, `copilotToken`, `modelsLoaded`, `version`) |

## Pipeline Runner

Route handlers delegate to `runPipeline()` (`src/pipeline/runner.ts`), a generic orchestrator that wraps the three core pipeline stages (Ingest → Transform → Dispatch) into a single call. Guard is applied separately as an Elysia plugin at the route level, and Deliver (response serialization) happens after `runPipeline()` returns its result. Instead of each route manually invoking every stage, `runPipeline()` accepts a `PipelineConfig` that declaratively describes:

- **Protocol, transform chain, and strategy registry** — which protocol to parse, which model transforms to apply, and which execution strategies to select from.
- **Lifecycle hooks** — `afterIngest()` runs immediately after protocol parsing and validation (e.g., to extract beta headers, or to swap in a replacement payload by returning one), and `afterTransform()` runs after the model transform chain (e.g., to apply tool/input policies and context management on the final payload).
- **Strategy context builder** — a `buildStrategyContext()` callback that constructs the strategy-specific context from the parsed payload, resolved model, Copilot client, and upstream signal.

Route handlers like messages and chat-completions supply their own config objects and call `runPipeline()`, keeping handler code focused on route-specific concerns rather than pipeline plumbing.

## Design Principles

1. **Explicitness over silence** -- Unsupported fields fail with 400 instead of being silently dropped. Translation issues are tracked and surfaced.

2. **Strategy pattern for routing** -- Each execution path (native, responses, chat-completions) is an `ExecutionStrategy` implementation, sharing the same response handling logic.

3. **Normalization via IR** -- Protocol translation goes through an intermediate representation (IR) that decouples source format parsing from target format generation.

4. **Minimal mutation** -- The native messages path passes through with as few changes as possible. Translation only happens when necessary.

5. **Streaming-first** -- All endpoints support both streaming and non-streaming responses. Streaming errors become protocol-level error events rather than broken TCP connections.

6. **Upstream quirks stay internal** -- If Copilot expects a slightly different shape than the official client-facing API, the proxy normalizes it internally instead of pushing the incompatibility onto clients.

7. **Favor direct implementation** -- No unnecessary abstractions. Each route handler is self-contained.

## Endpoint Compatibility Notes

`POST /v1/embeddings` remains OpenAI-compatible at the proxy boundary. When Copilot upstream expects a stricter request shape, the proxy normalizes internally before forwarding, for example converting a single string `input` into a one-element string array.

`POST /v1/responses` stays close to passthrough by default, but can optionally enable a local "official emulator" state layer. In that mode, the proxy still uses Copilot `/responses` for creation while keeping in-memory OpenAI-style state for `previous_response_id`, `conversation`, retrieve, input item listing, delete, and local `input_tokens` estimation. Emulator state is memory-only and expires by TTL.

For coding-agent clients, the proxy also recognizes a lightweight subagent contract before upstream execution:

- `x-session-id` is accepted as an alias for the root `clientSessionId`
- synthetic `<system-reminder>` blocks that carry `__SUBAGENT_MARKER__{...}` are removed from prompt text before forwarding
- detected subagent traffic is reclassified to `conversation-subagent`, and the upstream initiator is forced to `agent`

That keeps client plugin metadata out of the actual model prompt while preserving the root session identity in Copilot request headers.

## Token Usage

Token usage follows a **passthrough architecture**: Copilot's upstream API returns real usage data, and the proxy translates it into the client's expected format without synthesizing or estimating values.

| Execution Path | Upstream Format | Translation | Streaming Behavior |
|---|---|---|---|
| Chat Completions | OpenAI `usage` | `mapOpenAIUsageToAnthropic()` | Opt-in via `stream_options.include_usage` |
| Responses API | Responses `usage` | `mapResponsesUsage()` | Included in `response.created` event |
| Native Messages | Anthropic `usage` | None (passthrough) | Included natively |

The `gpt-tokenizer` library is used **only** for the `count_tokens` endpoint, which provides local pre-flight estimation. It applies model-specific correction factors (1.15x for Claude) because GPT tokenizers produce different counts than Claude's tokenizer. See [Copilot Token Usage](../research/copilot-token-usage.md) for full details.

## Operational Features

### Request Correlation ID

Every request is assigned an `x-request-id`. If the client supplies one in the request headers, the proxy preserves it; otherwise a random UUID is generated via `crypto.randomUUID()`. The ID is attached to the response headers and included in structured request logs.

### Graceful Shutdown

The server registers `SIGTERM` and `SIGINT` handlers (`src/start.ts`). On signal receipt the shutdown sequence stops the Copilot token refresh timer, calls `app.stop()` to drain in-flight connections, and exits cleanly.

### Resource Limits

- **Emulator memory cap** — The responses emulator store (`src/state/responses-emulator-state.ts`) enforces a hard cap of 10,000 total entries across all maps (responses, conversations, conversation heads, input items, deletion flags). When a write would exceed the cap, expired entries are pruned first; if still over capacity, the oldest entry in the largest map is evicted. A background sweep runs every 60 seconds to remove expired entries proactively.
- **Upstream queue depth** — The upstream request queue (`src/clients/upstream-queue.ts`) limits pending waiters to 1,000. When the queue is full, new requests are immediately rejected with a `503 overloaded_error` response rather than blocking indefinitely.
