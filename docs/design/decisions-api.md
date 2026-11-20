# Decisions API

`POST /decisions` and `POST /v1/decisions` expose the OpenAI Decisions API for
two kinds of Copilot decision model, chosen per model at admission:

- **Native Decisions models** (for example `gpt-6-luna-decisions`) advertise
  `/v1/decisions`. Copilot serves the public OpenAI Decisions contract there, so
  the proxy passes the request and response through.
- **System One models** (for example `microsoft-decision-1`) advertise
  `/v1/systemone`. The proxy translates the supported Decisions subset to
  System One and back.

The route is a direct JSON path: it does not use `ExecutionStrategy`, the chat
planning pipeline, streaming, or model overload fallback.

## Public Surface

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/decisions`, `/v1/decisions` | Validate a Decisions request, admit the model, then pass it through to `/v1/decisions` or translate it to `/v1/systemone`, and return a Decisions response |
| `POST` | `/systemone`, `/v1/systemone` | Send a keyed System One request to a model advertising `/v1/systemone` and return a keyed System One response |

The route is available at the root and under `/v1` with the same behavior. It is
JSON-only; a `stream` field is not part of the public contract. Requests use the
existing guard, request correlation, account-scoped queue, Copilot authentication,
upstream deadline, and abort handling.

## Request Validation

The public envelope is validated before any catalog or upstream work. Its
objects are strict, so unknown fields (including `stream`) are rejected rather
than dropped. It accepts 1–400 questions, 2–255 choices per choice question,
and 2–10 levels per score question. Path-specific checks run after model
admission, so they may load an empty catalog but never make an inference call.

## Native Decisions Path

The validated public body is forwarded to Copilot `POST /v1/decisions` with the
resolved model id. Images, tool-call items, assistant refusals, message
`phase`, `safety_identifier`, and prompt-cache fields all pass through.

The one adaptation is question names. The Copilot gateway answers an opaque
`text/plain` `400 Bad Request` when any question has no name, an empty name, or
a name another question already uses, although the public contract allows all
three. The proxy gives each such question a unique placeholder (`q{index}`,
prefixed with `_` until unique) and restores the original name (`null` when
absent) in the matching answer. Requests whose names are already unique and
non-empty are forwarded unchanged.

The proxy validates the native response envelope, answer count and types, and
token counts before returning it. Apart from restored placeholder names, it
preserves Copilot's response fields, including the served model family (for
example `gpt-6-luna` for `gpt-6-luna-decisions`) and `usage.*_details`. Upstream errors use
the shared upstream error path: Copilot's OpenAI-style envelopes, with public
`param` paths such as `questions[0].choices[1].value`, pass through unchanged,
and a plain-text gateway rejection is wrapped in an error envelope.

Gateway limit observed on 2026-11-06 that the public schema allows:
`prompt_cache_options` is accepted only as `{ mode: "explicit", ttl: "30m" }`;
other variants return the opaque `400 Bad Request`.

## Native System One Path

Use `POST /systemone` or `POST /v1/systemone` to send System One JSON directly:

```json
{
  "model": "microsoft-decision-1",
  "state": "The customer asked for a refund.",
  "questions": {
    "refund": { "type": "noul", "instructions": "Did the customer ask for a refund?" }
  }
}
```

`state` accepts a string, a JSON object, or a JSON array with bounded nesting
and value count. `questions` has 1–255 caller-chosen keys. Each question accepts
optional `instructions`. For `noul`, `criteria` can be omitted, `null`, or an
object containing optional `true` and `false` strings. For `choice`, supply a
non-empty object of string or null criteria; for `score`, a non-empty array of
strings. Unknown envelope and question fields are rejected, including `input`
and `stream` at the top level.

The resolved model must advertise `/v1/systemone`. A Decisions-only model such
as `gpt-6-luna-decisions` gets a `400` before inference; use `/v1/decisions` for
that model. Neither System One alias is served on M365 targets.

The response contains a keyed `answers` object with exactly the submitted keys
and a `usage` object. The proxy preserves extra upstream fields and the upstream
model name (for example `microsoft-decision-1.1`). Non-JSON or invalid success
responses return `502` with `invalid_upstream_systemone_response`. Upstream
validation errors retain System One paths such as `questions.refund` or
`state`, but omit rejected input evidence.

## System One Translation

A valid request maps as follows:

| Public Decisions field | System One field | Notes |
| --- | --- | --- |
| `model` | `model` | Resolved through the shared model rewrite/resolution path before dispatch |
| `input` string | `state` string | Forwarded as the state |
| `input` message items | `state` message array | Roles and text/JSON content are preserved |
| `questions[]` | `questions` object | Keyed `q{index}` in request order |
| predicate question | `{ type: "noul" }` | Optional public `name` is retained only in the request-local mapping |
| choice question | `{ type: "choice", criteria }` | Choices are always keyed `c{index}`; each criterion is the value (strings JSON-quoted, booleans bare), followed by `: description` when present |
| score question | `{ type: "score", criteria }` | Level labels become criteria strings; response probabilities map back by level index |
| question `instructions` | `instructions` | String or text/JSON parts are joined; images are rejected |
| `name` | not sent | Retained in the mapping and restored on the response |

Messages support the roles `user`, `developer`, `system`, and `assistant`.
Assistant content is restricted to `output_text`; tool calls, tool outputs,
assistant refusals, message phases, and `input_image` parts are rejected before
dispatch. JSON input parts are supported only on user messages.

The following public fields are rejected for System One models because they
cannot be preserved losslessly:

- `safety_identifier`
- `prompt_cache_key`
- `prompt_cache_options`
- `prompt_cache_breakpoint` on input parts
- image input and image question instructions
- function/custom tool calls and their outputs
- assistant refusal evidence and message `phase`
- duplicate typed choice values
- more than 255 questions (System One's own limit)

Rejection returns `400` `translation_error` before any inference call.

## Model Admission

When the model catalog is empty, the handler loads it once through the normal
Copilot client and then resolves the requested model with the shared resolver
(compact-routing policy disabled). A model advertising `/v1/decisions` takes the
native path; otherwise a model advertising `/v1/systemone` takes the System One
path. An unknown model, or a cached model with neither endpoint, returns `400`
with `param: "model"` and makes no inference call. There is no strategy
registry, model fallback, or overload fallback for this route.

## System One Response Translation

A successful System One response is validated before any public answer is
assembled:

- Every submitted question key must have exactly one answer, and no extra keys
  are allowed.
- A predicate requires a `noul` answer; a choice requires a known key with the
  complete probability set; a score requires the complete index set.
- An explicit upstream refusal maps to a public refusal; a missing answer never
  becomes a refusal.
- Probabilities and confidence must be finite and in `[0, 1]`; core usage counts
  must be finite non-negative integers.
- `total_tokens` is computed as `input_tokens + output_tokens`. Unreported
  cached/cache-write/reasoning detail counters are reported as `0`.
- The upstream `model` value is returned in the public response.

Malformed success bodies and failures during translation return `502`
`translation_error` with code `invalid_upstream_decisions_response`; no partial
answer array is emitted.

## Upstream Errors and Retry

Both paths use the existing Copilot client and queue with capacity-only retry: `429` and `529` may be replayed within the shared budget.
Ambiguous `408`/`5xx` responses, malformed success bodies, and translation
failures are not retried. The route does not select a fallback target.

Non-2xx System One responses run through a Decisions-specific normalizer before
the shared upstream logger sees the body. It preserves the upstream status and
`Retry-After`, maps internal `questions[qN]` paths, including the question key
named in a plain `detail` string, to public indexes, bounds messages and
details, and drops raw evidence such as `detail.input`. A `400`,
`422`, `429`, or `529` therefore reaches the client as a bounded OpenAI-style
error envelope rather than a raw upstream body.

## Cancellation and Observability

The caller signal is linked to the upstream request. An abort before dispatch,
during queue wait, or during the upstream body read stops the work and releases
the queue lease. An already-aborted caller enters the shared tagged client-abort
path, which records the request as aborted rather than failed or timed out.

Both aliases for each API are classified in the request store. The handlers
record the requested and effective model mapping for Dashboard request history;
the Dashboard model row shape and DTO are unchanged.

## Verification Status

Hermetic tests cover request validation and translation, response and error
translation, route admission for both paths, native name placeholders, lazy
catalog loading, transport retry and abort behavior, contract smoke, and the
real-listener error envelope. Live behavior was checked manually against a
GitHub Copilot individual account on 2026-11-06 (`microsoft-decision-1` on
`/v1/systemone`, `gpt-6-luna-decisions` on `/v1/decisions`); CI does not
exercise the live contracts. System One refusals and live 429/529 replay were
not observed.

## Non-Goals

- Streaming Decisions results
- Image or tool-call evidence for System One models
