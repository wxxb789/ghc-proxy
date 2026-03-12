# Architecture Overview

This document describes the high-level architecture of ghc-proxy.

## What ghc-proxy Does

ghc-proxy is a reverse-engineered API translation proxy that converts GitHub Copilot's API into OpenAI and Anthropic compatible formats. It enables tools like Claude Code, Cursor, and any OpenAI/Anthropic-speaking client to use a GitHub Copilot subscription.

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
|         Model Policy & Routing            |
|  (resolve model, smart rerouting,         |
|   compact/warmup detection)               |
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

## Design Principles

1. **Explicitness over silence** -- Unsupported fields fail with 400 instead of being silently dropped. Translation issues are tracked and surfaced.

2. **Strategy pattern for routing** -- Each execution path (native, responses, chat-completions) is an `ExecutionStrategy` implementation, sharing the same response handling logic.

3. **Normalization via IR** -- Protocol translation goes through an intermediate representation (IR) that decouples source format parsing from target format generation.

4. **Minimal mutation** -- The native messages path passes through with as few changes as possible. Translation only happens when necessary.

5. **Streaming-first** -- All endpoints support both streaming and non-streaming responses. Streaming errors become protocol-level error events rather than broken TCP connections.

6. **Favor direct implementation** -- No unnecessary abstractions. Each route handler is self-contained.

## Token Usage

Token usage follows a **passthrough architecture**: Copilot's upstream API returns real usage data, and the proxy translates it into the client's expected format without synthesizing or estimating values.

| Execution Path | Upstream Format | Translation | Streaming Behavior |
|---|---|---|---|
| Chat Completions | OpenAI `usage` | `mapOpenAIUsageToAnthropic()` | Opt-in via `stream_options.include_usage` |
| Responses API | Responses `usage` | `mapResponsesUsage()` | Included in `response.created` event |
| Native Messages | Anthropic `usage` | None (passthrough) | Included natively |

The `gpt-tokenizer` library is used **only** for the `count_tokens` endpoint, which provides local pre-flight estimation. It applies model-specific correction factors (1.15x for Claude) because GPT tokenizers produce different counts than Claude's tokenizer. See [Copilot Token Usage](../research/copilot-token-usage.md) for full details.
