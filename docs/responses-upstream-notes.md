# Responses Upstream Compatibility Notes

Observations from live upstream testing against the Copilot API.

## Vision Gaps (March 11, 2026)

Live upstream verification matters here. On March 11, 2026, a full local scan across every Copilot model that advertised `/responses` support still showed two stable vision gaps:

- External image URLs were rejected uniformly enough that the proxy now rejects them locally with a clearer capability error.
- The current 1x1 PNG data URL probe was rejected upstream as invalid image data even though the fixture itself decodes as a valid PNG locally.

The proxy does not currently disable Responses vision wholesale because the same models still advertise vision capability in Copilot model metadata. Treat Responses vision as upstream-contract-sensitive and verify it with `matrix:live` before relying on it.

## Stateful Routes (March 11, 2026)

On March 11, 2026, `POST /responses` succeeded against the current enterprise Copilot endpoint, but `POST /responses/input_tokens`, `GET /responses/{id}`, `GET /responses/{id}/input_items`, and `DELETE /responses/{id}` all returned upstream `404`. The proxy exposes those routes because they are part of the official Responses surface, but current Copilot upstream support is not there yet. The same live matrix also showed `previous_response_id` returning upstream `400 previous_response_id is not supported` on the tested model.

Re-verified April 30, 2026 with `gpt-5.5` — same results: `input_tokens` and resource routes still return `404`, `previous_response_id` still rejected.

## Input Sanitization Policies

The proxy applies several input mutations before forwarding `/v1/responses` requests to Copilot. These are implemented in `applyResponsesInputPolicies()` in `src/routes/responses/handler.ts`:

### `store=false`

Every outgoing Responses request has `store` forced to `false`. Copilot cannot resolve opaque item IDs from `store=true` sessions on subsequent requests (→ 404), so the proxy disables server-side storage unconditionally.

### `item_reference` and orphaned `function_call_output` stripping

Input items of type `item_reference` are removed because they reference server-side stored IDs that Copilot cannot resolve. Additionally, `function_call_output` items whose `call_id` has no matching `function_call` in the same input array are stripped as orphaned outputs.

### `phase` field stripping

The `phase` field on input message items is an output annotation that some models reject when sent back as input. The proxy strips it from all input message items before forwarding.

### Remote image URL rejection

External `input_image.image_url` values that point at remote HTTP(S) URLs are rejected with `400` because Copilot's Responses endpoint does not support them.

## Parameter Filters

Reasoning models (the `gpt-5` family, o-series, codex) reject sampling parameters on `/responses`, e.g. `400 Unsupported parameter: 'temperature' is not supported with this model.` for `gpt-5.4-mini`. The proxy strips these on the Responses boundary rather than leaking the incompatibility to the client.

Implemented in `applyResponsesParameterFilters()` (`src/transform/parameter-filter.ts`) and invoked from both Responses dispatch paths — the native handler (`src/routes/responses/handler.ts` `afterTransform`) and the `/v1/messages` → Responses strategy (`src/routes/messages/strategy-registry.ts`):

- **Default rule:** any model advertising `reasoning_effort` has `temperature` and `top_p` stripped. Detection is capability-based (`isReasoningModel`), so new reasoning variants are covered without a hardcoded ID list.
- **User rules (`responsesApiParameterFilters`):** `{ models: glob[], params: string[] }` entries whose model glob matches the resolved model add their params to the strip set (union with the default).
- **`responsesApiParameterFiltersReplaceDefault`:** disables the default rule so only user rules apply.

Keys are deleted entirely (never sent as `null`) because upstream rejects the presence of the key, not just non-null values. Matching is against the **resolved** model (post model-rewrite).

