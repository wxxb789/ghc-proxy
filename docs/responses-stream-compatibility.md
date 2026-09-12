# Responses Stream Compatibility

This document captures the current `/v1/responses` streaming compatibility
contract at the proxy boundary for both native passthrough and the opt-in
Responses-to-Chat create bridge.

In the spirit of “重新审视那份研究文档，将其与我们当前的代码库对齐，并融入到我们的 docs 文件夹下”, this note replaces the earlier investigation log with a current-state contract description tied to the code that actually ships.

## Why This Exists

GitHub Copilot's upstream `/responses` stream is close to the OpenAI Responses surface, but not identical enough to expose raw passthrough safely.

The most important known gap is stream identity stability:

- upstream can emit unstable `response.id` values across lifecycle events
- upstream can emit unstable `item_id` values across child events for the same logical `output_index`
- some clients assume a stable item identity and will break when that assumption is violated

The proxy therefore applies a small compatibility shim on the native
`/v1/responses` passthrough path. When
`responsesChatCompletionsFallback` is enabled for a Chat-only model, a separate
stateful translator converts Chat chunks into the Responses event contract;
that path is documented below and is not upstream native Responses support.

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

## Bridge Stream Contract

The `responses-chat-completions` strategy uses
`src/translator/responses/chat-to-responses.ts` for both non-streaming results
and Chat SSE chunks. The translator treats the stream as a state machine rather
than passing JSON through:

1. The first valid Chat chunk emits `response.created` and
   `response.in_progress` with monotonically increasing `sequence_number`
   values.
2. Text opens one message/content lane and emits `response.output_text.delta`
   events. Function calls accumulate raw argument fragments by Chat tool-call
   index; custom calls buffer the complete JSON wrapper before restoring the
   freeform `input` value.
3. Validated lanes close with the matching `*.done` event and a complete
   `response.output_item.done`. An incomplete or unvalidated function/custom
   lane is not presented as an executable completed tool call.
4. `stop` and `tool_calls` map to `response.completed`; `length` and
   `content_filter` map to `response.incomplete`; unsupported or error finish
   reasons map to `response.failed`.
5. A usage-only tail after a finish reason is consumed before the terminal
   event. EOF before a finish reason is a failure, not a successful completion.

Custom lanes use the typed
`response.custom_tool_call_input.delta` and
`response.custom_tool_call_input.done` events with `item_id`, `output_index`,
and `sequence_number`. Function lanes use
`response.function_call_arguments.delta` and
`response.function_call_arguments.done`. Bridge response and output-item IDs
are proxy-generated and remain stable within the translated response; they are
not retrievable hosted Responses resource IDs.

The bridge checks returned tool calls against the current declarations and
`tool_choice`; historical-only tools are not eligible for new calls. Required
or forced choices cannot complete successfully without a matching call.

Buffered output is bounded across text, refusal, tool identities, and argument
lanes. The character budget uses 16 UTF-16 code units per effective output
token, with a 16,384-unit floor and a 2,000,000-unit safety ceiling; an unknown
token budget uses that ceiling. At most 1,024 tool-call lanes are retained.
Exceeding either safety limit fails with `upstream_output_too_large`, never
silent truncation. These are memory guards, not exact tokenizer accounting or
hosted `max_tool_calls` semantics.

### Bridge Error and Cancellation Rules

Malformed Chat chunks, malformed function/custom arguments, unknown tool
aliases, upstream error frames, stream exceptions, and early EOF produce a
Responses `error` event followed by exactly one `response.failed` event. The
translator does not emit a false success terminal event or an executable
`output_item.done` for a truncated tool lane. Client cancellation is owned by
`runStrategy()`: it cleans up the linked signal and does not synthesize a
Responses error or terminal frame.

A terminal translation failure also stops upstream iteration immediately.
Usage-only tail chunks remain readable after an ordinary finish reason because
that finish reason alone does not terminalize the translator.

The bridge preserves existing `decorateResponse`, terminal-response, emulator
persistence, request-error observation, queue, and account-runtime callbacks.
It does not add a bridge-local state store, resource-route support, remote
compaction, WebSocket support, hosted tool execution, or synthetic encrypted
reasoning state. This contract describes the proxy boundary; it is not a live
Copilot capability or model-quality claim.

## Type Coverage

The local Responses stream type model now includes the currently observed part events that matter for compatibility:

- `response.reasoning_summary_part.added`
- `response.reasoning_summary_part.done`
- `response.content_part.added`
- `response.content_part.done`
- `response.custom_tool_call_input.delta`
- `response.custom_tool_call_input.done`

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
