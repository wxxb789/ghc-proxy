# Responses and Routing Implementation Record

## Status

This file replaces the earlier exploratory porting plan.

- Scope implemented: `F2` `/v1/responses`, `F3` Responses compatibility policies, `F4` compact and warmup small-model routing
- Scope intentionally not implemented: API-key auth, usage viewer UI, file logging, subagent marker, unrelated utility ports
- Current role of this document: design record plus post-review correction log

## Final Architecture

The final design keeps `ghc-proxy`'s original strength: a stable shared core for the chat-completions path, with new capability-specific paths added beside it instead of polluting it.

### Execution Paths

1. `POST /v1/chat/completions`
   - OpenAI Chat payload
   - validated and normalized into the shared planning pipeline
   - executed through Copilot `/chat/completions`

2. `POST /v1/responses`
   - OpenAI Responses payload
   - validated with a dedicated Responses schema
   - executed through Copilot `/responses`
   - proxy-side compatibility policies stay in the Responses route layer

3. `POST /v1/messages`
   - Anthropic Messages payload
   - routed per selected model:
     - native Copilot `/v1/messages`
     - Anthropic <-> Responses translation path
     - Anthropic adapter -> chat-completions fallback

This preserves the existing adapter/core design instead of turning the repository into one large route-level compatibility handler.

## Design Decisions

### 1. Responses support is native, not tunneled through the chat IR

The Responses endpoint has protocol features that do not map cleanly onto the shared chat-planning IR:

- flat `input` item lists instead of conversation turns
- reasoning items with encrypted content
- compaction carriers
- event-type-based streaming

Trying to force these semantics into the existing chat IR would create a leaky abstraction. The chosen design therefore keeps:

- the existing chat pipeline unchanged
- a native Responses handler for `/v1/responses`
- a dedicated Anthropic <-> Responses translator for `/v1/messages`

### 2. Capability boundaries are explicit

The implementation now prefers explicit failure over silent downgrade for critical protocol features.

Examples:

- unsupported builtin Responses tools such as `web_search` return `400`
- Anthropic `stop_sequences`, `top_k`, and `service_tier` are rejected on the Responses execution path
- Responses requests are validated before any proxy-side mutation

### 3. Small-model routing is conservative

Compact and warmup rerouting are opt-in and constrained by capability checks.

The proxy only reroutes when:

- `smallModel` exists
- the target model preserves the original model's declared upstream endpoints
- tool or thinking requests are not sent to a model that lacks those capabilities

Warmup routing is intentionally narrow and requires explicit warmup/probe-style signaling.

## Implemented Files

### New route and translator surface

- `src/routes/responses/handler.ts`
- `src/routes/responses/route.ts`
- `src/routes/responses/context-management.ts`
- `src/routes/responses/tool-transforms.ts`
- `src/routes/responses/stream-id-sync.ts`
- `src/translator/responses/anthropic-to-responses.ts`
- `src/translator/responses/responses-to-anthropic.ts`
- `src/translator/responses/responses-stream-translator.ts`
- `src/translator/responses/types.ts`
- `src/types/responses.ts`

### Core integration points

- `src/routes/messages/handler.ts`
- `src/clients/copilot-client.ts`
- `src/lib/config.ts`
- `src/lib/request-model-policy.ts`
- `src/lib/validation.ts`
- `src/server.ts`
- `src/types/copilot.ts`

## Post-Review Corrections

After the first implementation pass, a deeper protocol review identified several places where the code was functional but not aligned with the repository's long-term design standards. Those issues were corrected in the current version.

### Corrected

1. Responses payloads are now validated before mutation.
2. Unsupported builtin tools are rejected explicitly instead of being silently removed.
3. Anthropic -> Responses translation now preserves `temperature`, `top_p`, and `max_tokens` instead of rewriting them aggressively.
4. Unsupported Anthropic fields on the Responses path now fail explicitly.
5. Native `/v1/messages` no longer overwrites caller-supplied `thinking` or `output_config`.
6. Responses streaming failures now emit Anthropic `error` events instead of tearing down the stream abruptly.
7. The Responses stream translator no longer reopens completed blocks with the same Anthropic index.
8. Function-call whitespace guarding now counts ordinary spaces as intended.
9. Small-model warmup routing is now narrower and gated by capability preservation checks.
10. Documentation now matches the actual public API and routing behavior.
11. Responses now reject external image URLs locally instead of paying an upstream round trip for a known-stable failure.
12. Responses `input_file` content is now modeled and validated explicitly.
13. Runtime Copilot API base now follows `endpoints.api` from the token response when GitHub provides it.
14. Responses resource routes now follow the official surface more closely (`input_tokens` / `retrieve` / `input_items` / `delete`) instead of exposing a non-official `GET /responses` list route.
15. The live matrix harness now distinguishes proxy-side 5xx measurement failures from actual upstream capability gaps.

### Intentionally left out

The following ideas were reviewed and deliberately not pulled in from `copilot-api` because they would add surface area without matching `ghc-proxy`'s current architecture:

- file-based request logging
- subagent marker parsing
- usage dashboard UI
- unrelated utility ports

## Verification Record

The implementation was validated with the repository's standard checks:

```bash
bun run typecheck
bun test
bun run build
bun run lint:all
bun run matrix:live
```

Expected outcomes for the current state:

- TypeScript passes
- tests cover the new routing and Responses policy behavior
- build passes
- markdown lint no longer fails on this plan file
- `matrix:live` exercises representative real Copilot upstream paths

### Representative Live Matrix (March 11, 2026)

Representative models selected during the latest local run:

- `/v1/responses`: `gpt-5.2-codex`
- `/v1/messages` native path: `claude-opus-4.6-1m`
- `/v1/messages` Responses translation path: `gpt-5.2-codex`
- `/v1/messages` chat fallback: `gemini-3.1-pro-preview`

Observed outcomes:

- supported: Responses text non-stream
- supported: Responses text stream
- supported: Responses forced function tool
- supported: Responses `apply_patch` shim
- supported: Responses low-effort reasoning
- supported: Responses `text.format = text`
- supported: Responses `input_file.file_data`
- upstream-rejected: Responses `input_image` via data URL on the tested model
- upstream-rejected: Responses `input_image` via external URL on the tested model
- proxy-rejected: Responses `web_search`
- upstream-rejected: Responses `previous_response_id`
- upstream-rejected: Responses `POST /responses/input_tokens`
- upstream-rejected: Responses `GET /responses/{id}`
- upstream-rejected: Responses `GET /responses/{id}/input_items`
- upstream-rejected: Responses `DELETE /responses/{id}`
- supported: Anthropic Messages native non-stream and stream
- supported: Anthropic Messages -> Responses translation non-stream and stream
- supported: Anthropic Messages -> chat fallback non-stream

This matrix is intentionally representative, not exhaustive. The script is meant to be rerun as models and Copilot upstream behavior change.

One notable live discrepancy remains: the tested Responses-capable models advertise vision support in the model list, but the sampled image requests were still rejected upstream. The proxy currently treats that as an upstream compatibility gap, not as a local proof that vision should be disabled wholesale.

### Expanded Vision Scan (March 11, 2026)

The live matrix script now supports targeted scanning:

- `--json`
- `--vision-only`
- `--all-responses-models`
- `--model=<id>`

An expanded `--vision-only --all-responses-models` run was executed across all locally visible Copilot `/responses` models:

- `gpt-5.2-codex`
- `gpt-5.3-codex`
- `gpt-5.4`
- `gpt-5-mini`
- `gpt-5.1`
- `gpt-5.1-codex`
- `gpt-5.1-codex-mini`
- `gpt-5.1-codex-max`
- `gpt-5.2`

Observed result:

- every scanned model rejected external image URLs with `400 external image URLs are not supported`
- every scanned model rejected the current PNG data URL probe as invalid image data
- the PNG probe itself decodes locally as a valid 1x1 PNG, so the failure is not explained by a malformed fixture alone

This is stronger evidence than the earlier representative run. The Responses vision gap now appears systemic across the current visible Copilot `/responses` model set, even though the same model metadata advertises vision support.

Follow-up adjustment:

- remote HTTP(S) image URLs are now rejected locally with a structured capability error
- data URL image input is still forwarded, because the current evidence does not justify disabling all data URL image forms wholesale

### Stateful Responses Surface Probe (March 11, 2026)

Target runtime base discovered from the live token:

- `https://api.enterprise.githubcopilot.com`

Observed results:

- `POST /responses` succeeded
- `POST /responses/input_tokens` returned upstream `404 page not found`
- `GET /responses/{id}` returned upstream `404`
- `GET /responses/{id}/input_items` returned upstream `404`
- `DELETE /responses/{id}` returned upstream `404`
- `POST /responses` with `previous_response_id` returned upstream `400 previous_response_id is not supported`
- `POST /responses` with `text.format = { type: "text" }` succeeded
- `POST /responses` with `input_file.file_data` succeeded

Interpretation:

- the proxy now exposes the official Responses stateful surface for compatibility
- current Copilot upstream still appears to support only create on `/responses`
- `text.format` and `input_file.file_data` are real working capabilities and should no longer be treated as matrix flukes
- keeping the unsupported official routes exposed is still useful because it lets us track upstream capability changes without another router refactor

## Follow-up Work

The largest remaining long-term question is feature coverage depth for the official OpenAI Responses surface. The route and type system are now structured so that additional official fields can be supported incrementally without disturbing the chat pipeline or reintroducing silent downgrade behavior.
