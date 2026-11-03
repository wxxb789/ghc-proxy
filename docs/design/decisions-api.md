# Decisions API

`POST /decisions` and `POST /v1/decisions` expose the supported subset of the
OpenAI Decisions API and translate it to Copilot's System One endpoint,
`POST /v1/systemone`. The route is a direct JSON path: it does not use
`ExecutionStrategy`, the chat planning pipeline, streaming, or model overload
fallback.

## Public Surface

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/decisions`, `/v1/decisions` | Validate a Decisions request, translate it to System One, call the admitted model, and return a Decisions response |

The route is available at the root and under `/v1` with the same behavior. It is
JSON-only; a `stream` field is not part of the public contract. Requests use the
existing guard, request correlation, account-scoped queue, Copilot authentication,
upstream deadline, and abort handling.

## Request Translation

The public envelope is validated before any catalog or upstream work. Its
objects are strict, so unknown fields are rejected rather than dropped. It
accepts 1–400 questions, 2–255 choices per choice question, and 2–10 levels per
score question. A valid request maps as follows:

| Public Decisions field | System One field | Notes |
| --- | --- | --- |
| `model` | `model` | Resolved through the shared model rewrite/resolution path before dispatch |
| `input` string | `state` string | Forwarded as the state |
| `input` message items | `state` message array | Roles and text/JSON content are preserved |
| `questions[]` | `questions` object | Keyed `q{index}` in request order |
| predicate question | `{ type: "noul" }` | Optional public `name` is retained only in the request-local mapping |
| choice question | `{ type: "choice", criteria }` | String choices use their own value as the key when all are non-empty and unique; otherwise keys are `c{index}` |
| score question | `{ type: "score", criteria }` | Level labels become criteria strings; response probabilities map back by level index |
| question `instructions` | `instructions` | String or text/JSON parts are joined; images are rejected |
| `name` | not sent | Retained in the mapping and restored on the response |

Messages support the roles `user`, `developer`, `system`, and `assistant`.
Assistant content is restricted to `output_text`; tool calls, tool outputs,
assistant refusals, message phases, and `input_image` parts are rejected before
dispatch. JSON input parts are supported only on user messages.

The following public fields are rejected because they cannot be preserved
losslessly:

- `safety_identifier`
- `prompt_cache_key`
- `prompt_cache_options`
- `prompt_cache_breakpoint` on input parts
- image input and image question instructions
- function/custom tool calls and their outputs
- assistant refusal evidence and message `phase`

Rejection returns `400` before the model catalog is loaded, so an invalid
request performs no upstream call of any kind.

## Model Admission

The cached model must advertise the exact upstream endpoint `/v1/systemone`.
When the model catalog is empty, the handler loads it once through the normal
Copilot client and then resolves the requested model with the shared resolver
(compact-routing policy disabled). An unknown model, or a cached model without
`/v1/systemone`, returns `400` with `param: "model"` and makes no inference call.
There is no strategy registry, model fallback, or overload fallback for this
route.

## Response Translation

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

The System One call uses the existing Copilot client and queue. It uses
capacity-only retry: `429` and `529` may be replayed within the shared budget.
Ambiguous `408`/`5xx` responses, malformed success bodies, and translation
failures are not retried. The route does not select a fallback target.

Non-2xx responses run through a Decisions-specific normalizer before the shared
upstream logger sees the body. It preserves the upstream status and
`Retry-After`, maps internal `questions[qN]` paths to public indexes, bounds
messages and details, and drops raw evidence such as `detail.input`. A `400`,
`422`, `429`, or `529` therefore reaches the client as a bounded OpenAI-style
error envelope rather than a raw upstream body.

## Cancellation and Observability

The caller signal is linked to the upstream request. An abort before dispatch,
during queue wait, or during the upstream body read stops the work and releases
the queue lease. An already-aborted caller enters the shared tagged client-abort
path, which records the request as aborted rather than failed or timed out.

Both paths are classified in the request store, and the handler records the
original and effective model mapping for the access log and Dashboard request
history. The Dashboard model row shape and DTO are unchanged.

## Verification Status

Hermetic tests cover request validation and translation, response and error
translation, route admission, lazy catalog loading, transport retry and abort
behavior, contract smoke, and the real-listener error envelope. The live
System One contract was not exercised by automated CI and is **unverified** in
this change; the documented behavior is the proxy's supported subset, not a
claim of full upstream compatibility.

## Non-Goals

- Streaming Decisions results
- Image or tool-call evidence
- System One passthrough from the public boundary
- M365-specific behavior
