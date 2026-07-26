# Upstream Request Queue

## Problem

Copilot can return HTTP 429 for service-wide, account-wide, or model-family limits, and 529 when the upstream is overloaded. The `/v1/messages` upstream currently does not expose a stable public quota that ghc-proxy can encode as a fixed local rate. Some 429 responses are plain text (`too many requests`) and may not include a precise reset time.

Returning the first transient failure directly makes the proxy available only when Copilot has spare capacity at the exact request instant. For agent clients, that breaks long-running workflows even when a short wait would have succeeded.

## Design Goals

- Keep protocol routes focused on validation, routing, and translation.
- Centralize upstream back-pressure in the Copilot transport boundary.
- Prefer delayed success over immediate 429 when the upstream limit is temporary.
- Preserve correct final errors when retries are exhausted.
- Avoid unbounded retries, unbounded concurrency, or hidden per-route behavior.

## Architecture

`UpstreamRequestQueue` lives in `src/clients/upstream-queue.ts` and is injected into `CopilotClient` by `createCopilotClient()`.

```text
Route Handler
  -> Strategy / Adapter / Translator
    -> CopilotClient
      -> UpstreamRequestQueue
        -> fetch(api.githubcopilot.com / api.enterprise.githubcopilot.com)
```

The queue is below all public API protocol logic. This keeps Anthropic, OpenAI, and Responses compatibility independent from Copilot's transient capacity behavior.

## Runtime Behavior

1. Requests acquire a global upstream queue slot before calling Copilot.
2. The default queue concurrency is `10`, so up to 10 upstream requests can occupy queue slots at the same time.
3. If upstream returns a non-transient response, the response is handed back to `CopilotClient`.
4. If upstream returns a status this request may replay (see Retry scope below) and retry budget remains:
   - The response body is discarded.
   - A retry delay is selected from `Retry-After` when present.
   - Otherwise exponential backoff is used.
   - For capacity limits (`429`, `529`) the global queue enters cooldown so other queued requests do not immediately hit the same limit.
   - The same request is retried after the delay.
5. If retry budget is exhausted, the final response is passed to normal upstream error handling.

### Retry scope vs. cooldown scope

These are two different decisions and the queue treats them separately.

Which statuses may be replayed depends on what a duplicate would cost, declared
per call site as `UpstreamRequestContext.retryable`:

| Request | `retryable` | Replays |
|---------|-------------|---------|
| Completions (`/v1/messages`, `/chat/completions`, `/responses`) | `'capacity'` | `429`, `529` |
| Effect-free reads and `/embeddings` | `true` | `408`, `429`, `500`, `502`, `503`, `504`, `529` |
| `DELETE /responses/{id}` | omitted | none |

A completion request bills a generation, and an upstream 5xx does **not** mean
the request was refused — it may have been fully processed before failing. No
HTTP status proves otherwise: a proxy stream-idle timeout surfaces as `408`, and
Envoy maps upstream connection termination to `503`. Replaying one can therefore
spend quota twice for a single client request, so completions replay only the
two statuses where the upstream declined to serve rather than failed while
serving. That is a lower prior on duplicated work, not a guarantee.

Retrying a non-idempotent 5xx is a decision about whether a duplicate is
acceptable, which the client owns — the Anthropic and OpenAI SDKs and Claude
Code all retry 5xx at their own boundary.

Cooldown scope is a separate axis and unchanged:

| Status | Global cooldown |
|--------|-----------------|
| `429`, `529` | Yes — the limit is account- or service-wide |
| `408`, `500`, `502`, `503`, `504` | No — request-scoped fault |
| everything else | No |

A request-scoped 5xx says one request failed, not that the account is out of capacity. Applying a queue-wide cooldown there would let a single bad gateway hop stall every other in-flight request.

**Streaming is safe by construction.** `dispatch` returns the response only once
no retry will follow (`upstream-queue.ts`, the single `return` inside the loop),
so a replay can never happen after bytes have reached the client.

Queue concurrency counts active upstream occupancy, not just the moment a request is started. For non-streaming responses, the slot is released after the response body is parsed. For streaming responses, the slot is released only when the returned upstream stream is consumed or closed. This prevents the proxy from starting another expensive upstream request while one stream is still active.

## Defaults

| Setting | Default | Reason |
|---------|---------|--------|
| `concurrency` | `10` | Allows moderate parallelism while still applying global back-pressure |
| `maxRetries` | `5` | Avoid immediate failure while keeping retry duration bounded |
| `baseDelayMs` | `2000` | Fast first recovery when upstream omits `Retry-After` |
| `maxDelayMs` | `60000` | Avoid runaway sleep on malformed or excessive headers |

Worst-case backoff without `Retry-After` is about a minute before returning the final 429. This is intentionally below the default upstream timeout.

## Configuration

These settings are configurable through the `start` command:

| CLI Flag | Unit | Default |
|----------|------|---------|
| `--upstream-queue-concurrency` | requests | `10` |
| `--upstream-queue-retries` | retries | `5` |
| `--upstream-queue-base-delay` | seconds | `2` |
| `--upstream-queue-max-delay` | seconds | `60` |

Raising concurrency improves throughput only when upstream capacity allows it. When the active limit is model-family or account-wide, higher concurrency can amplify 429s.

The same settings can be persisted in `~/.local/share/ghc-proxy/config.json`:

```json
{
  "upstreamQueueConcurrency": 10,
  "upstreamQueueMaxRetries": 5,
  "upstreamQueueBaseDelaySeconds": 2,
  "upstreamQueueMaxDelaySeconds": 60
}
```

CLI flags override config file values for the current process.

## Error Handling

The queue classifies transient upstream statuses with `isTransientUpstreamStatus()` in `src/lib/error.ts` — the same predicate the Copilot token refresh uses, where retrying is unconditionally safe — and narrows to `isCapacityLimitStatus()` for requests that bill a generation. Other statuses (`400`, `401`, `404`, ...) are returned immediately; retrying a request that can never succeed only multiplies it.

The final exhausted response is still processed by `throwUpstreamError`, which:

- forwards structured upstream error bodies as-is,
- returns plain-text upstream bodies as the client-facing message,
- classifies HTTP 429 as `rate_limit_error`.

This means better error messages are a fallback, not the first mitigation.
