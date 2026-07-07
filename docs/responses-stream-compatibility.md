# Responses Stream Compatibility

This document captures the current `/v1/responses` streaming compatibility contract at the proxy boundary.

In the spirit of “重新审视那份研究文档，将其与我们当前的代码库对齐，并融入到我们的 docs 文件夹下”, this note replaces the earlier investigation log with a current-state contract description tied to the code that actually ships.

## Why This Exists

GitHub Copilot's upstream `/responses` stream is close to the OpenAI Responses surface, but not identical enough to expose raw passthrough safely.

The most important known gap is stream identity stability:

- upstream can emit unstable `response.id` values across lifecycle events
- upstream can emit unstable `item_id` values across child events for the same logical `output_index`
- some clients assume a stable item identity and will break when that assumption is violated

The proxy therefore applies a small compatibility shim on the native `/v1/responses` passthrough path.

## Current Boundary Contract

### Stable `response.id`

At the proxy boundary, `response.id` is stabilized to the first observed value. Later lifecycle events such as:

- `response.completed`
- `response.incomplete`
- `response.failed`

are rewritten back to that stable ID when upstream drifts.

Implementation:

- [strategy.ts](../src/routes/responses/strategy.ts)

### Stable `item_id` Per `output_index`

At the proxy boundary, every event that carries both:

- `output_index`
- `item_id`

is normalized structurally rather than by an event-name whitelist.

That means the proxy now rewrites observed and future child events consistently as long as they reference a known `output_index`.

This includes events such as:

- `response.output_text.delta`
- `response.output_text.done`
- `response.function_call_arguments.delta`
- `response.function_call_arguments.done`
- `response.reasoning_summary_text.delta`
- `response.reasoning_summary_text.done`
- `response.reasoning_summary_part.added`
- `response.reasoning_summary_part.done`
- `response.content_part.added`
- `response.content_part.done`
- unknown future events that still carry `output_index` and `item_id`

### First-Seen Output Item Identity Wins

Stable output-item identity is tracked by `output_index`.

The current rules are:

- `response.output_item.added` seeds the stable item ID when first seen
- `response.output_item.done` seeds it only if no stable ID exists yet
- `response.output_item.done` does not overwrite a previously established stable ID
- if upstream drifts on `response.output_item.done.item.id`, the proxy rewrites it back to the stable ID

This keeps late upstream drift from corrupting the tracker state used by child events.

## Type Coverage

The local Responses stream type model now includes the currently observed part events that matter for compatibility:

- `response.reasoning_summary_part.added`
- `response.reasoning_summary_part.done`
- `response.content_part.added`
- `response.content_part.done`

Implementation:

- [responses.ts](../src/types/responses.ts)

## Verification Coverage

The contract above is covered by focused route-level tests rather than only unit tests on helper functions.

Relevant suites:

- [responses-stream-translator.test.ts](../tests/responses-stream-translator.test.ts)
- [responses-routing.test.ts](../tests/responses-routing.test.ts)

Current checks include:

- per-`output_index` child-event normalization
- `response.reasoning_summary_part.*`
- `response.content_part.*`
- unknown future event normalization by shape
- `response.output_item.done` seeding without overwrite
- stable `response.id` on lifecycle events
- malformed JSON passthrough

## Scope and Non-Goals

This compatibility layer does not try to make Copilot byte-for-byte identical to OpenAI.

It only aims to preserve the wire-level invariants that real OpenAI Responses clients depend on:

- valid SSE framing
- stable logical item identity
- coherent lifecycle IDs
- tolerance for future event additions

This is also intentionally separate from the broader upstream support gaps documented in:

- [responses-upstream-notes.md](responses-upstream-notes.md)

Those notes cover resource-surface issues such as `previous_response_id`, retrieve, delete, and `input_tokens`, which are different from the streaming identity problem described here.

## Background

This document originated from a debugging investigation triggered by a third-party client crash caused by unstable reasoning event IDs. That earlier incident report was useful for local debugging, but the durable value for the repository is the current compatibility contract described above.
