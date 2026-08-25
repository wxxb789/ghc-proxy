# Architecture Overview

This document describes the high-level architecture of ghc-proxy.

## What ghc-proxy Does

ghc-proxy is a reverse-engineered API translation proxy that converts GitHub Copilot's API into OpenAI and Anthropic compatible formats. It enables tools like Claude Code, Cursor, and any OpenAI/Anthropic-speaking client to use a GitHub Copilot subscription. Public routes stay schema-compatible with the official surface they present; Copilot-specific differences are handled inside the proxy.

## Technology Stack

| Component       | Technology                      |
|-----------------|---------------------------------|
| Runtime         | Bun >= 1.3 (first-class), Node.js >= 24 LTS via `@elysiajs/node` |
| Language        | TypeScript (ESNext, strict)     |
| HTTP Framework  | Elysia (`@elysiajs/node` adapter for Node.js) |
| CLI Framework   | citty                           |
| Validation      | Zod                             |
| Token Counting  | gpt-tokenizer                   |
| SSE Streaming   | fetch-event-stream              |
| Build Tool      | tsdown                          |
| Linting         | ESLint (@antfu/eslint-config)   |
| Published As    | `ghc-proxy` npm package          |

## High-Level Model Request Flow

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
|       Response Mapping / Passthrough       |
|  (strip CAPI extensions or translate back) |
+-------------------------------------------+
    |
    v
Client Response (OpenAI / Anthropic format)
```

## Exposed Endpoints

Root OpenAI-compatible routes are mirrored under `/v1`. Anthropic Messages is
`/v1`-only, while proxy operations and the Dashboard are root-only.

| Endpoint | Format | Purpose |
|----------|--------|---------|
| `POST /chat/completions`, `POST /v1/chat/completions` | OpenAI | Chat Completions through the Conversation/CAPI adapter pipeline |
| `POST /v1/messages` | Anthropic | Messages API with native, Responses-translation, or Chat fallback execution |
| `POST /v1/messages/count_tokens` | Anthropic | Local pre-flight input-token estimate |
| `POST /responses`, `POST /v1/responses` | OpenAI | Responses create operation |
| `POST /responses/input_tokens`, `POST /v1/responses/input_tokens` | OpenAI | Upstream token count by default; local estimate in emulator mode |
| `GET /responses/:responseId`, `GET /v1/responses/:responseId` | OpenAI | Retrieve a response; supports the Responses `stream` query option |
| `GET /responses/:responseId/input_items`, `GET /v1/responses/:responseId/input_items` | OpenAI | List stored/upstream response input items |
| `DELETE /responses/:responseId`, `DELETE /v1/responses/:responseId` | OpenAI | Delete a stored/upstream response |
| `POST /embeddings`, `POST /v1/embeddings` | OpenAI | Embeddings |
| `GET /models`, `GET /v1/models` | OpenAI | List available models |
| `GET /token` | Proxy | Return the current Copilot token state |
| `GET /usage` | Proxy | Fetch Copilot quota/usage statistics |
| `GET /health` | Proxy | Health state (`status`, `copilotToken`, `modelsLoaded`, `version`) |
| `GET /dashboard` and `/dashboard/{styles.css,app.js}` | Proxy UI | Loopback-guarded operational Dashboard assets |
| `GET /dashboard/api/{overview,models,behavior,requests}` | Proxy UI | Sanitized Dashboard data projections |

`GET /` is a minimal liveness response. Dashboard routes do not run through the
model execution pipeline described below.

## Pipeline Runner

Route handlers delegate to `runPipeline()` (`src/pipeline/runner.ts`), a generic orchestrator that wraps the three core pipeline stages (Ingest → Transform → Dispatch) into a single call. Guard is applied separately as an Elysia plugin at the route level, and Deliver (response serialization) happens after `runPipeline()` returns its result. Instead of each route manually invoking every stage, `runPipeline()` accepts a `PipelineConfig` that declaratively describes:

- **Protocol, transform chain, and strategy registry** — which protocol to parse, which model transforms to apply, and which execution strategies to select from.
- **Lifecycle hooks** — `afterIngest()` runs immediately after protocol parsing and validation (e.g., to extract beta headers, or to swap in a replacement payload by returning one), and `afterTransform()` runs after the model transform chain (e.g., to apply tool/input policies and context management on the final payload).
- **Strategy context builder** — a `buildStrategyContext()` callback that constructs the strategy-specific context from the parsed payload, request metadata, resolved model, Copilot client, upstream signal, the full `ModelMappingInfo`, and the shared `UpstreamRecoveryRecord`. The recovery record carries correlation and recovery state across a source attempt and any overload fallback; it is not reduced to only a request ID.

Route handlers like messages and chat-completions supply their own config objects and call `runPipeline()`, keeping handler code focused on route-specific concerns rather than pipeline plumbing.

## Design Principles

1. **Explicitness over silence** -- Unsupported fields fail with 400 instead of being silently dropped. Translation issues are tracked and surfaced.

2. **Strategy pattern for routing** -- Each model execution path (native, Responses, Chat Completions) is an `ExecutionStrategy` implementation, sharing dispatch and stream lifecycle plumbing while retaining protocol-specific translation hooks.

3. **Use IR where it buys separation** -- OpenAI Chat and the Messages Chat fallback normalize through the Conversation/CAPI model. Anthropic↔Responses translation is a direct typed mapping, avoiding an unnecessary extra representation.

4. **Minimal mutation** -- The native messages path passes through with as few changes as possible. Translation only happens when necessary.

5. **Protocol-aware streaming** -- The generative routes honor their protocol's streaming shape. The two translated Messages strategies provide `onStreamError()` and can convert caught stream/parser failures into Anthropic `error` events. Native Messages, Chat Completions, and Responses passthrough streams preserve upstream events and currently have no synthetic protocol-error hook; failures are still recorded in request observability when the client did not cancel.

6. **Upstream quirks stay internal** -- If Copilot expects a slightly different shape than the official client-facing API, the proxy normalizes it internally instead of pushing the incompatibility onto clients.

7. **Favor direct implementation** -- No unnecessary abstractions. Each route handler is self-contained.

## Endpoint Compatibility Notes

`POST /embeddings` and `POST /v1/embeddings` remain OpenAI-compatible at the proxy boundary. When Copilot upstream expects a stricter request shape, the proxy normalizes internally before forwarding, for example converting a single string `input` into a one-element string array.

`POST /responses` and `POST /v1/responses` stay close to passthrough by default. Before dispatch, the handler applies the Responses input policy, tool-schema normalization, optional context management, per-model parameter filters, and output/reasoning clamps. The strategy then stabilizes stream IDs, forwards events, and observes terminal `response.completed`, `response.incomplete`, and `response.failed` events.

The optional "official emulator" state layer still uses Copilot `/responses` for creation while keeping in-memory OpenAI-style state for `previous_response_id`, `conversation`, retrieve, input item listing, delete, and local `input_tokens` estimation. Without emulator mode, those resource and token-count operations are forwarded to Copilot. Emulator state is memory-only and expires by TTL.

For coding-agent clients, the proxy also recognizes a lightweight subagent contract before upstream execution:

- `x-session-id` is accepted as an alias for the root `clientSessionId`
- synthetic `<system-reminder>` blocks that carry `__SUBAGENT_MARKER__{...}` are removed from prompt text before forwarding
- detected subagent traffic is reclassified to `conversation-subagent`, and the upstream initiator is forced to `agent`

That keeps client plugin metadata out of the actual model prompt while preserving the root session identity in Copilot request headers.

## Token Usage

Generation usage is upstream-derived. Translation changes the field names and
cache accounting expected by the client protocol; it does not run
`gpt-tokenizer` to invent response usage. Anthropic responses require a usage
object, so translated paths fill missing upstream counters with zero. Those
zeros are schema completion, not local token estimates.

| Execution Path | Usage behavior | Streaming behavior |
|---|---|---|
| OpenAI Chat Completions route | `OpenAIChatAdapter` preserves upstream OpenAI `usage` while removing CAPI-only response fields | CAPI profiles request usage-bearing streams; chunks remain OpenAI-shaped |
| Messages via Chat Completions | `mapOpenAIUsageToAnthropic()` maps prompt/completion/cache counters | Final usage-only upstream chunks are retained until `message_delta` |
| Messages via Responses | `mapResponsesUsage()` maps input/output/cache-read/cache-write counters | Initial counters come from `response.created`; terminal usage is emitted from `response.completed`/`response.incomplete` in `message_delta` |
| Native Messages | Anthropic `usage` is passed through | Upstream Anthropic events are forwarded |
| Responses route | Responses `usage` is passed through (plus optional emulator response decoration) | Upstream Responses events are forwarded |

`gpt-tokenizer` is used for local estimation by
`POST /v1/messages/count_tokens`, for best-effort Chat Completions diagnostic
logging, and by `POST /responses/input_tokens` only when the Responses emulator
is enabled. In the default mode, the Responses input-token route calls Copilot
upstream. Packaged `selfcheck` also loads every tokenizer chunk as a runtime
compatibility probe. See [Copilot Token Usage](../research/copilot-token-usage.md)
for details.

## Operational Features

### Dashboard and Request Observability

The Dashboard is served at `/dashboard` with four JSON projections under
`/dashboard/api/`. Its route guard checks the available socket peer address,
the request URL hostname, and same-origin `Origin` values for loopback access.

`RuntimeStore` owns a process-local `RequestActivityStore`. The server starts an
activity record for every non-Dashboard request (unknown paths are classified as
`unmatched`), then progressively records
the requested/effective model, model-transform trace, selected strategy,
counted proxy effects, sanitized error summary, lifecycle state, status, and
duration. It retains active requests and a fixed ring of the 256 most recent
completed requests. Request bodies, prompts, tool arguments, headers, and raw
upstream errors are not stored in this projection. Dashboard requests are
excluded so the UI does not observe itself.

The Dashboard also projects model capabilities/routing, configured behavior,
quota state, and the current upstream queue snapshot. All state is process-local
and resets on restart.

### Request Correlation ID

Every request is assigned an `x-request-id`. If the client supplies one in the request headers, the proxy preserves it; otherwise a random UUID is generated via `crypto.randomUUID()`. The ID is attached to the response headers and included in structured request logs.

### Graceful Shutdown

The server registers `SIGTERM` and `SIGINT` handlers (`src/start.ts`). On signal receipt the shutdown sequence stops the Copilot token refresh timer, calls `app.stop()` to drain in-flight connections, and exits cleanly.

### Resource Limits

- **Emulator memory cap** — The responses emulator store (`src/state/responses-emulator-state.ts`) enforces a hard cap of 10,000 total entries across all maps (responses, conversations, conversation heads, input items, deletion flags). When a write would exceed the cap, expired entries are pruned first; if still over capacity, the oldest entry in the largest map is evicted. A background sweep runs every 60 seconds to remove expired entries proactively.
- **Upstream queue depth** — The upstream request queue (`src/clients/upstream-queue.ts`) limits pending waiters to 1,000. When the queue is full, new requests are immediately rejected with a `503 overloaded_error` response rather than blocking indefinitely.
