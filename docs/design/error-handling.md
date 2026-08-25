# Error Handling and Validation

This document describes the error handling strategy and validation architecture.

## Error Classification

### Routing and Request-Shape Errors (404 / 400 / 422)

Raised by Elysia before or around a route handler, and mapped by
`handleRouteError` (`src/server.ts`):

| Condition | Elysia `code` | Status | Client `type` |
|---|---|---|---|
| No route matches the path | `NOT_FOUND` | 404 | `not_found_error` |
| Request body is not parseable | `PARSE` | 400 | `invalid_request_error` |
| A route's own schema rejects the body | `VALIDATION` | 422 | `invalid_request_error` |

`handleRouteError` reads the `status` the thrown error declares rather than
mapping Elysia's `code`: every built-in Elysia error class carries `status` as a
public class contract, so the property covers these cases and whatever Elysia
adds later. The read is guarded to an integer in 400-599, so a thrown value can
never report success or a nonsense status; anything else falls back to 500.

The same read means an in-repo error carrying its own status keeps it —
`TranslationFailure` (`status: 400 | 502`) surfaces 502 on the response-direction
path instead of being flattened to 500.

The `type` is derived from the resolved status rather than hardcoded, for the
reason `upstreamErrorType` already states: a non-standard `type` at the proxy
boundary breaks client error handling. Elysia's own `NOT_FOUND` message is an
internal token and is replaced with a client-facing sentence.

No route in this repo declares an Elysia/TypeBox body schema today — ingest
validates with Zod and throws `HTTPError(400)` — so the 422 row is reachable only
if a schema-bearing route is added later.

### Validation Errors (400)

Caught at request ingress via Zod schemas:

- Missing required fields
- Type mismatches (string where number expected, etc.)
- Invalid enum values
- Referential integrity (e.g., `tool_choice.name` references a declared tool)
- Positive `thinking.budget_tokens`
- Object-shaped tool schemas
- Image block source discriminator, supported media type, and non-empty data
- `tool_result` content structure

### Translation Errors (400 / 502)

Caught during protocol translation:

- **Strict mode**: Lossy translations that would lose semantics (e.g., thinking history omission)
- **Always**: Explicitly unsupported fields (for example, `service_tier` on either translated Messages path and `stop_sequences` on the Responses path)

Request-direction failures use status 400; response-direction failures use
502. At the intended route wrapper, `withTranslationErrors()` converts either
to `error.type: "translation_error"`, with the translation issue kind in
`error.code` when one is available. They are not reported as
`invalid_request_error`. An unwrapped `TranslationFailure` reaching the generic
server error hook still preserves its declared status, but uses the generic
local error envelope.

### Upstream Errors (Pass-through)

Errors from GitHub Copilot's API are forwarded to the client with the upstream status code and body:

```typescript
class HTTPError extends Error {
  status: number // HTTP status code
  body: HTTPErrorBody // Structured error payload
}
```

Before a transient Copilot status reaches this helper, `UpstreamRequestQueue` may perform bounded pre-`Response` recovery. Generation requests replay only `429`/`529`; effect-free requests retain `408`, `429`, `500`, `502`, `503`, `504`, and `529`. Both may retry only the measured DNS/refusal connection-establishment allowlist. Timeouts, aborts, resets, TLS/configuration failures, unknown fetch errors, and body/stream failures are not connection-retried. See [Upstream Request Queue](upstream-request-queue.md).

The upstream error helper (`throwUpstreamError`) extracts the response body and status code. Structured upstream error bodies are forwarded as-is. Plain-text upstream bodies become the client-facing message, with HTTP `429` classified as `rate_limit_error` and `529` as `overloaded_error`. Final capacity errors preserve the standard `Retry-After` header. If the upstream body is empty, the client gets the fallback proxy message while logs retain bounded status/body metadata.

Capacity scope is separate from error shape: `429` installs an account cooldown, `529` with a final effective model installs a model cooldown, and model-less `529` remains request-only. A valid `Retry-After` is the full shared cooldown deadline and a lower bound for automatic retry; the computed-backoff maximum never shortens it.

### Streaming Errors

Only the two `/v1/messages` translation strategies synthesize Anthropic
protocol errors for stream exceptions:

```json
{
  "type": "error",
  "error": {
    "type": "api_error",
    "message": "Malformed upstream JSON in chunk"
  }
}
```

Native Messages, public Chat Completions, and public Responses still record a
sanitized stream failure for the dashboard but do not synthesize a protocol
frame. Public Responses also records a clean EOF without a terminal response
as `response_stream_eof`; the translated Messages-via-Responses path both
records that failure and emits an Anthropic `error` event. See
[Streaming Architecture](streaming.md) for the full path matrix.

A successful upstream `Response` is already committed, so a later stream
failure -- including before the first downstream event -- never starts a retry
or overload fallback.

## Validation Architecture

### Zod Schemas (`src/ingest/validation/`)

All request payloads are validated at the route handler level:

| Schema                         | Endpoint                    |
|--------------------------------|-----------------------------|
| `ChatCompletionsPayload`      | `POST /chat/completions`   |
| `AnthropicMessagesPayload`    | `POST /v1/messages`        |
| `ResponsesPayload`           | `POST /v1/responses`       |
| `EmbeddingRequest`            | `POST /v1/embeddings`      |

Key validations:
- Tool schemas must be object-typed
- Tool choice references must match declared tools
- Thinking budget must be positive
- Image sources must declare `type: "base64"`, use a supported image media
  type, and provide a non-empty string. Ingress does not decode the string or
  prove that its bytes are valid base64.
- Message roles must follow protocol rules
- Embeddings accept the official OpenAI-facing `string | string[]` input shape
- Embedding-specific optional fields such as `dimensions`, `encoding_format`, and `user` are modeled explicitly

### Translation Policy (`src/translator/anthropic/translation-policy.ts`)

```typescript
interface TranslationPolicy {
  mode: 'best-effort' | 'strict'
}

class TranslationContext {
  record(issue: TranslationIssue, options?: { fatalInStrict?: boolean })
  getIssues(): TranslationIssue[]
}
```

**best-effort mode** (default): Lossy translations are recorded but allowed. The proxy does its best to preserve semantics.

**strict mode**: Lossy translations marked as `fatalInStrict` throw `TranslationFailure` with status 400. Used when the caller demands exact translation fidelity.

### Translation Issue Types

```typescript
interface TranslationIssue {
  kind: string // e.g., 'unsupported_stop_sequences'
  severity: 'info' | 'warning' | 'error'
  message: string // Human-readable description
}
```

Issue kinds used in the codebase:

| Kind                                    | Severity    | Description                                           |
|-----------------------------------------|-------------|-------------------------------------------------------|
| `lossy_thinking_omitted_from_prompt`   | warning     | Thinking history blocks removed from upstream prompt  |
| `lossy_interleaving_flattened`         | warning     | Text/tool_use interleaving flattened in assistant turn |
| `lossy_multiple_choices_ignored`       | warning     | Only choice[0] used from multi-choice response        |
| `unsupported_service_tier`             | error       | `service_tier` parameter cannot be translated         |
| `unsupported_stop_sequences`           | error       | `stop_sequences` cannot be forwarded on Responses path |

## Error Classes

### `HTTPError`

Elysia-native error class with `status` property and `toResponse()`. Elysia auto-handles this via `toResponse()` when thrown in route handlers:

```typescript
class HTTPError extends Error {
  status: number // HTTP status code
  body: HTTPErrorBody // Structured { error: { message, type, param?, code? } }
  headers: Headers // Safe response metadata such as Retry-After

  toResponse(): Response // Native Response with the stored status/body/headers
}
```

`HTTPError.toResponse()` is the protocol boundary. Recovery diagnostics stay in structured logs; they are not appended to the JSON body, emitted as non-standard SSE events, or exposed as custom retry headers.

### `TranslationFailure`

Thrown when a translation issue is fatal:

```typescript
class TranslationFailure extends Error {
  status: 400 | 502 // HTTP status code
  kind: string // Issue kind (e.g., 'unsupported_stop_sequences')
}
```

`withTranslationErrors()` converts this internal error into an `HTTPError`
whose wire type is `translation_error` and whose optional wire code is
`kind`.

### `throwInvalidRequestError()`

Convenience for Anthropic-format validation errors:

```typescript
function throwInvalidRequestError(
  message: string,
  param: string,
  code?: string
): never
```

Throws an `HTTPError` that Elysia converts to:
```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "...",
    "param": "..."
  }
}
```

## Error Flow

```text
Request arrives
    |
    v
[Route match] ──no match──> 404 { type: not_found_error }
    |
    v (matched)
[Body parse] ──fail──> 400 { type: invalid_request_error }
    |
    v (parsed)
[Zod Validation] ──fail──> 400 { type: invalid_request_error }
    |
    v (valid)
[Translation Policy Check] ──unsupported──> 400 { type: translation_error }
    |
    v (ok)
[Upstream Request]
    |
    +── HTTP error ──> forward upstream status + body
    |
    +── Unclassified network/fetch error ──> 500
    |
    +── Timeout ──> 504
    |
    v (success)
[Response Translation]
    |
    +── Non-streaming error ──> 502
    |
    +── Streaming error ──> path-specific observer and optional SSE error event
    |
    v
Client Response
```

Any error escaping the above with its own plausible status (400-599) keeps that
status; everything else becomes 500.

## Health Check

`GET /health` returns a lightweight status object for operational monitoring:

```json
{
  "status": "ok",
  "copilotToken": true,
  "modelsLoaded": true,
  "version": "<package version>"
}
```

`copilotToken` and `modelsLoaded` are booleans indicating whether the proxy has a valid Copilot token and a cached model list, respectively.

## Resource Limit Protections

### Upstream Queue Depth

`UpstreamRequestQueue` enforces a maximum queue depth of **1,000 pending waiters** internally. A cooled-model waiter does not consume an otherwise free active slot: the oldest eligible waiter may bypass it. When every global slot is occupied and global pending depth is full, new requests are rejected with HTTP 503:

```json
{
  "error": { "message": "Upstream queue full", "type": "overloaded_error" }
}
```

This prevents unbounded memory growth under sustained load. See [Upstream Request Queue](upstream-request-queue.md) for the full back-pressure design.

### Emulator Memory Cap

The Responses emulator state store enforces a hard cap of **10,000 total entries** (across responses, conversations, conversation heads, input items, and deletion flags). The cap is enforced at the write layer: every new-key write calls `enforceCapOnWrite()`, which first prunes expired entries, then evicts the oldest entry from the largest map until the count drops below the limit. A background prune interval (60 s) garbage-collects expired entries; it is started lazily on the first write (`writeMap`/`putDeletionFlag`) rather than at construction, re-arms after `clear()`, and is `unref()`'d so it never keeps the process alive.

## Signal and Resource Cleanup

### AbortSignal Cleanup on Strategy Errors

`runStrategy()` in `src/lib/execution-strategy.ts` ensures the abort signal is cleaned up when `execute()` throws. If the strategy's `execute()` call fails, `signal.cleanup()` is called before re-throwing, preventing signal leaks on error paths. For non-streaming results, cleanup happens immediately after translation. For streaming results, cleanup is deferred to the `finally` block of the SSE generator so the signal remains live for the duration of the stream.

### Graceful Shutdown

The server registers `SIGTERM` and `SIGINT` handlers in `src/start.ts`. On either signal, the shutdown sequence:

1. Calls `tokenCleanup()` to stop the Copilot token refresh interval
2. Calls `app.stop()` to close the HTTP server
3. Exits with code 0

This ensures no orphaned timers or dangling connections survive a clean shutdown.

## Compatibility Normalization

Validation and request shaping also preserve the public API contract when Copilot upstream differs from the exposed schema. Example: `POST /v1/embeddings` accepts OpenAI-compatible single-string input, then normalizes it to a one-element array before the upstream call.
