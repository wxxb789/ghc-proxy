# Error Handling and Validation

This document describes the error handling strategy and validation architecture.

## Error Classification

### Validation Errors (400)

Caught at request ingress via Zod schemas:

- Missing required fields
- Type mismatches (string where number expected, etc.)
- Invalid enum values
- Referential integrity (e.g., `tool_choice.name` references a declared tool)
- Positive `thinking.budget_tokens`
- Object-shaped tool schemas
- Image block base64 source shape
- `tool_result` content structure

### Translation Errors (400)

Caught during protocol translation:

- **Strict mode**: Lossy translations that would lose semantics (e.g., thinking history omission)
- **Always**: Explicitly unsupported fields (e.g., `top_k`, `service_tier` on Responses path, `stop_sequences` on Responses path)

### Upstream Errors (Pass-through)

Errors from GitHub Copilot's API are forwarded to the client as-is:

```typescript
class HTTPError extends Error {
  response: Response // Original upstream response
}
```

The `forwardError()` utility extracts the upstream response body and status code, forwarding them directly.

### Streaming Errors

During streaming, errors become protocol-level events:

```json
{
  "type": "error",
  "error": {
    "type": "api_error",
    "message": "Malformed upstream JSON in chunk"
  }
}
```

This preserves the SSE connection and gives the client structured error information.

## Validation Architecture

### Zod Schemas (`src/lib/validation.ts`)

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
- Image sources must have valid base64 data
- Message roles must follow protocol rules

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
  kind: 'exact' | 'lossy' | 'unsupported'
  code: string // e.g., 'lossy_thinking_omitted_from_prompt'
  message: string // Human-readable description
}
```

Issue codes used in the codebase:

| Code                                    | Kind        | Description                                           |
|-----------------------------------------|-------------|-------------------------------------------------------|
| `lossy_thinking_omitted_from_prompt`   | lossy       | Thinking history blocks removed from upstream prompt  |
| `lossy_interleaving_flattened`         | lossy       | Text/tool_use interleaving flattened in assistant turn |
| `lossy_multiple_choices_ignored`       | lossy       | Only choice[0] used from multi-choice response        |
| `unsupported_top_k`                    | unsupported | `top_k` parameter cannot be translated                |
| `unsupported_service_tier`             | unsupported | `service_tier` parameter cannot be translated         |

## Error Classes

### `HTTPError`

Wraps an upstream HTTP response that indicates failure:

```typescript
class HTTPError extends Error {
  response: Response
}
```

### `TranslationFailure`

Thrown when a translation issue is fatal:

```typescript
class TranslationFailure extends Error {
  status: number // HTTP status code (usually 400)
  kind: string // Issue kind
}
```

### `throwInvalidRequestError()`

Convenience for Anthropic-format validation errors:

```typescript
function throwInvalidRequestError(
  message: string,
  param?: string,
  code?: string
): never
```

Throws an error that the route handler converts to:
```json
{
  "type": "error",
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
[Zod Validation] ──fail──> 400 { type: invalid_request_error }
    |
    v (valid)
[Translation Policy Check] ──unsupported──> 400 { type: invalid_request_error }
    |
    v (ok)
[Upstream Request]
    |
    +── HTTP error ──> forward upstream status + body
    |
    +── Network error ──> 502
    |
    +── Timeout ──> 504
    |
    v (success)
[Response Translation]
    |
    +── Non-streaming error ──> 502
    |
    +── Streaming error ──> SSE error event (not TCP break)
    |
    v
Client Response
```
