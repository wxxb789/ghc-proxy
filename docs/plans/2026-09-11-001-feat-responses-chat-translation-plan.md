---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan
title: "feat: bridge Responses clients through Copilot Chat Completions"
date: 2026-09-11
type: feat
depth: comprehensive
---

# feat: bridge Responses clients through Copilot Chat Completions

> **Status: implementation authorized.** This document records the approved
> implementation boundary and future acceptance criteria. It does not claim
> that implementation or verification is complete; live Copilot probes,
> commits, pushes, PRs, and releases remain outside this plan.

## Feasibility Decision

**Recommendation: proceed with a bounded compatibility bridge; do not promise full Responses equivalence.** Request mapping and ordinary text/function output have a clear implementation path in the existing CAPI pipeline. Reliable Codex tool execution is a larger task because complete output items, custom tool restoration, stream termination, and conversation replay must agree. Protocol compatibility alone does not establish Gemini's coding quality or the installed application's compatibility.

The intended delivery has three layers: a request translator, a JSON/SSE output translator, and a native-first strategy integration. It adds no model call to an ordinary successful request. Hosted tools, opaque reasoning continuity, strict schema guarantees without backend evidence, and remote compaction are outside the initial contract.

### Interpretation of Supplied Metadata

- The user-supplied Gemini records advertise Chat Completions, text/tool/vision/streaming capabilities, and reasoning effort. This establishes the routing eligibility for this plan, not a newly measured upstream verdict. No live Gemini probe was performed for this plan.
- `structured no` means strict response-schema support must not be advertised. `output_config yes` is not equivalent to JSON Schema enforcement. JSON mode, strict function arguments, and strict response schemas need separate policies.
- `filters temperature,top_p` is a proxy compatibility projection. The baseline `src/transform/parameter-filter.ts` applies those default filters to the native Responses path; it is not evidence that raw Gemini Chat rejects sampling parameters.
- The stated context/prompt/output limits remain model-specific. Translation wrappers add tokens, and the emulator's local token estimate is not proof of Gemini's exact tokenizer or reasoning-budget accounting.
- The supplied `gpt-6-astra` record advertises native Responses and should remain on that path. Routing must follow endpoint capabilities rather than hardcoded Gemini or GPT names.
- The official Codex configuration reference, checked September 11, 2026, lists `responses` as the only `wire_api` value. This supports the need for a bridge for that client, but does not establish arbitrary ChatGPT app integrations or the installed Codex version's complete request profile.

## Goal Capsule

- **Objective:** A client using the OpenAI Responses contract can call a model that exposes only Copilot `/chat/completions` (especially Gemini) and receive a truthful Responses-compatible JSON or SSE result, while models with native `/responses` support continue to use the native path.
- **Means:** Add an opt-in `responsesChatCompletionsFallback` route strategy (default `false`) with a narrow Responses-to-CAPI request translator and CAPI-to-Responses JSON/SSE translator. Reuse the existing CAPI plan builder, then add the Responses-only fields that the internal CAPI plan currently cannot express. Keep emulator state, account routing, queue/recovery, and delivery ownership in the existing pipeline.
- **Authority:** The public Responses compatibility contract, the user's explicit scope in this request, and the existing account/emulator/runtime boundaries govern behavior. A provider capability advertisement is evidence of eligibility, not proof that the proxy supports the full hosted Responses API.
- **Execution profile:** Implement with local mocks, deterministic fixtures, snapshots, and packaged runtime checks. Do not call `matrix:live`, Copilot, or any live provider probe. Unknown actual Gemini execution remains residual evidence, not a reason to invent behavior or block the bounded implementation.
- **Stop condition:** Stop at the bridge boundary if a field cannot be represented without inventing hosted state, encrypted model state, tool execution, or structured-output semantics. Return a clear client-facing `400` for unsupported request intent; return a protocol-shaped terminal error for malformed or failed upstream streams.
- **Tail ownership:** The root agent owns route, pipeline, config, emulator, Dashboard, documentation integration, and final verification. The request worker owns the request translator and its focused tests. The output worker owns the output translator, Responses output unions, and its focused tests. This plan authorizes local implementation only; it does not authorize shipping.

## Product Contract

### Summary

Copilot model metadata can advertise `/chat/completions` without advertising `/responses`. The current `/v1/responses` route rejects such a model before strategy selection, which makes a Responses client unusable even when the same model can complete the equivalent OpenAI Chat request. This feature adds a deliberately opt-in compatibility bridge. It must remain visibly different from native Responses support and must not turn Chat Completions into a fictional hosted Responses implementation.

### Problem Frame

The existing Responses strategy is a native passthrough. Its handler applies native-only input, state, compaction, remote-image, and parameter policies before dispatch, and the pipeline's capability checks require the native `/responses` endpoint. The existing Chat adapter and CAPI plan builder already cover ordinary Chat messages and function calls, but they do not preserve all Responses semantics: `parallel_tool_calls`, tool `strict`, reasoning fields, prompt-cache hints, namespaces, custom text tools, or Responses output/SSE lifecycle events. The existing Chat response sanitizer also intentionally removes opaque CAPI fields and therefore cannot be used as the bridge's reverse mapper.

The planning baseline is `origin/main` at `a4bd808` on September 11, 2026. Any concurrent worktree edits are not treated as evidence that implementation is complete or verified.

### Requirements

#### Routing and capability truth

- **R1. Native first:** If the selected model advertises `/responses`, the existing native Responses strategy wins even when the fallback flag is enabled. The bridge must not change native behavior.
- **R2. Explicit opt-in:** `responsesChatCompletionsFallback` is a boolean configuration field whose default is `false`. With the flag disabled, a model without `/responses` continues to receive the existing clear unsupported-endpoint error and no Chat upstream call.
- **R3. Chat eligibility:** With the flag enabled, a model without `/responses` may use the bridge only when it advertises `/chat/completions`. A model lacking both endpoints is rejected before upstream dispatch.
- **R4. Recomputed attempts:** Overload fallback and model rewrites must re-run bridge eligibility and request translation for the effective target model. A target that only supports native Responses may use the native strategy; a target that only supports Chat may use the bridge. The target's tool, parallel-tool, vision, streaming, reasoning, and structured-output capabilities remain authoritative.
- **R5. Dashboard distinction:** Existing `responsesAvailable` and `upstream.endpoints` retain their native/upstream meaning. Add an explicit effective strategy/capability projection (for example `nativeResponsesAvailable` and `defaultResponsesStrategy`) and expose the fallback configuration separately. The Dashboard must never label Chat fallback as native Responses support.

#### Request translation

- **R6. Text and instructions:** Translate `input` strings and message items with `system`, `developer`, `user`, and `assistant` roles to CAPI Chat messages while preserving order and text. Map `instructions` to a system message without silently dropping it.
- **R7. Images:** Translate `input_image` HTTP(S) URLs and `data:` URLs to Chat `image_url` parts, preserving supported `detail` values. Use model vision capability for eligibility. Unsupported file attachments, unsupported image forms, or unsupported detail values fail explicitly; do not apply the native Responses remote-URL rejection to the Chat bridge.
- **R8. Function history:** Translate Responses `function_call` items and `function_call_output` items into assistant `tool_calls` and tool messages. Preserve native PR82 permissive ingress unchanged: object-form means the tool-result item, whose `output` remains a string or content array, not an arbitrary JSON object. The bridge requires a resolvable `call_id`; unresolved or missing IDs are rejected. Preserve call IDs and argument text. Chat JSON cannot reconstruct arbitrary interleaving chronology, so use a deterministic canonical order with tool-lane identity and document any representation change. Multiple calls emitted in one assistant turn remain parallel calls; sequential calls remain separate turns. Historical tools can be replayed but must not become eligible for new output calls unless currently declared and allowed.
- **R9. Function tools and choice:** Translate ordinary Responses function tools and function tool choice. Preserve descriptions, parameter schemas, and explicit `strict` state when the CAPI wire type can represent them; treat function-tool schema strictness separately from response-format structured-output capability. Unsupported tool-choice shapes such as hosted-tool selection or unrestricted `allowed_tools` fail clearly.
- **R10. Custom text tools:** Translate an ordinary Responses `custom` tool into a collision-safe Chat function alias with a reversible JSON input wrapper, conventionally `{ "input": "<freeform text>" }`. The reverse translator restores a Responses `custom_tool_call` with the original tool name, namespace, and freeform input. Custom tool outputs remain separate from function outputs.
- **R11. Namespaces:** Preserve a tool namespace when present. If Chat requires a flat name, use a bounded deterministic alias within the upstream name limit plus a request-local reverse map; the alias need not be self-decodable. Carry historical tool name/type/namespace metadata with the call so later turns restore it, and reject unresolved collisions or unrepresentable namespaces rather than flattening them irreversibly.
- **R12. `apply_patch` shim:** Honor the existing `useFunctionApplyPatch` gate. The Codex `apply_patch` custom tool may be lowered to the string-input function shim only for an exact pinned client grammar fixture allowlist under that gate; recognizing that grammar is new bounded work, not an existing general validator. Unknown grammar is rejected conservatively. The bridge must record a lossy translation issue/effect and restore the custom call shape on output. Do not parse arbitrary grammars, rewrite patch commands, or silently lower other custom tools through this shim.
- **R13. Options and hints:** Preserve `temperature`, `top_p`, `max_output_tokens` using the existing model-specific Chat token spelling, `stream`, `parallel_tool_calls`, `user`, `phase`, and an advisory `prompt_cache_key` as a lossy accepted value/effect; do not invent a new CAPI field or claim typed upstream support. `parallel_tool_calls: false` must not be lost through truthiness checks. Treat `metadata`, privacy identifiers, prompt-cache retention/options, `text.verbosity`, reasoning summary hints, and `include` explicitly: echo safe metadata only where the Responses envelope requires it, never log sensitive metadata, and mark lossy non-semantic hints or reject fields with no safe equivalent. No unsupported field may disappear silently.
- **R14. Reasoning:** Map `reasoning.effort` to the CAPI `reasoning_effort` field when the target advertises the requested capability, including explicit `none`/`minimal` handling where the CAPI wire type permits it. Summary-generation hints may be reported as lossy when the provider does not expose an equivalent. Never synthesize, decrypt, validate, or replay `encrypted_content`; replayable reasoning and compaction history are rejected unless a future exact state contract is added.
- **R15. Structured formats:** Treat `text.format: { type: "json_object" }` as Chat JSON mode, distinct from `structured_outputs`; preserve the request mapping but do not claim that the model will produce valid JSON solely because the request was accepted. A `json_schema` format is allowed only when target metadata and the internal CAPI wire type preserve the schema and its strictness; otherwise, especially for unsupported strict response formats, return a clear `400` rather than downgrading to ordinary text. Function-tool `strict` is a separate policy and must not be inferred from response-format metadata.

#### Unsupported hosted Responses semantics

- **R16. Hosted tools:** Reject built-in/hosted tool types that the bridge cannot execute or represent (`web_search`, `file_search`, `code_interpreter`, `computer_use_preview`, `image_generation`, `mcp`, `shell`, unknown future hosted types, and hosted tool choices). Do not relabel a hosted tool as an ordinary function tool. This is an allowlist of bridge semantics, not a claim that every Copilot model globally rejects those tools.
- **R17. State and continuation:** `conversation`, `previous_response_id`, and `store` state are supported only through the existing proxy-owned local emulator and its account-scoped state. Without the emulator, state-bearing continuation is rejected; the bridge never sends a fake continuation request to Chat. Emulator expansion, persistence, TTL, and account isolation remain owned by existing emulator code.
- **R18. Compaction/truncation:** Reject Responses `compaction` input/history and automatic context-management injection on the bridge. Keep `truncation: disabled` as an explicit bridge-no-truncation policy and let upstream overflow errors remain visible; do not trim silently. Reject `truncation: auto` because the bridge cannot preserve its semantics. Do not translate compaction into ordinary text or create synthetic encrypted compaction state.
- **R19. Other unsupported fields:** Reject or explicitly classify `background`, `prompt` templates, `max_tool_calls`, unsupported `service_tier`, unsupported file inputs, and unsupported `include` requests before any Chat call. Preserve the existing native path's policies; these bridge decisions are not shared native normalizers.

#### Responses output and streaming

- **R20. JSON result:** Translate a single CAPI Chat completion into a Responses result with truthful `id`, `created_at`, `model`, `output`, `output_text`, `status`, `usage`, tool-choice/tool metadata, and terminal error/incomplete details. Preserve message text and function/custom calls in representable deterministic canonical order; do not claim arbitrary interleaved chronology that Chat JSON did not carry.
- **R21. Custom output types:** Extend the local Responses type model with the narrow `custom_tool_call` output and matching input/output history forms required for round trips. Keep existing `function_call_output.output` string/content-array forms and PR82's optional/nullable item fields intact.
- **R22. SSE lifecycle:** Emit a coherent Responses event sequence including `response.created`, `response.in_progress`, monotonically increasing `sequence_number` values, created output items, text deltas/done, function/custom argument deltas/done, and complete `response.output_item.done` events (including Codex-shaped output items) only after the corresponding lane and wrapper are complete and validated. Custom streams use the typed `response.custom_tool_call_input.delta` and `response.custom_tool_call_input.done` events with `item_id`, `output_index`, and `sequence_number`. Emit exactly one terminal `response.completed`, `response.incomplete`, or `response.failed` event. Completion requires an observed finish reason; clean EOF may complete only when that finish reason was already observed, while early EOF without a finish reason fails. Consume usage-only tail chunks after finish before closing. Never emit executable `output_item.done` merely to close a truncated or unvalidated custom/tool lane. Use stable proxy-generated response/item IDs; preserve upstream `call_id` separately without treating virtual IDs as hosted state.
- **R23. SSE errors:** Convert malformed Chat chunks, malformed tool arguments, upstream error frames, stream exceptions, and early EOF without a finish reason into Responses `error` plus one `response.failed` event with a truthful message. Do not emit a false success terminal event. Client cancellation is a delivery outcome: stop cleanly, preserve cancellation observability, and do not fabricate an error terminal.
- **R24. Existing hooks:** Invoke existing `decorateResponse`, `onTerminalResponse`, `onStreamEndWithoutTerminal`, request error observation, emulator persistence, account routing, queue ownership, and recovery correlation exactly once at the bridge boundary. No bridge-local state store may bypass those hooks.

### Acceptance Examples

- **AE1.** A Gemini-like model with only `['/chat/completions']` returns `400` and makes zero upstream calls when the flag is absent; the same request succeeds through Chat when the flag is `true`.
- **AE2.** A model advertising both endpoints uses native `/responses` even when the flag is `true`, including for a hosted tool that the bridge would reject.
- **AE3.** A request containing instructions, developer/user/assistant history, a data URL image, and an HTTP image produces ordered Chat messages with text/image parts and no native-only remote-image rejection.
- **AE4.** Two parallel function calls with namespaced aliases and tool results arriving in reverse order round-trip through Chat and restore the original names, namespaces, IDs, and deterministic canonical output order. A later sequential tool turn remains a separate assistant/tool exchange.
- **AE5.** A freeform custom tool input and output round-trip through the JSON wrapper. The `apply_patch` grammar path is accepted only under its existing gate, is marked lossy, and restores a custom output item; arbitrary custom grammar is rejected.
- **AE6.** `parallel_tool_calls: false`, `strict: false`, `reasoning.effort: minimal`, advisory `prompt_cache_key` handling, and JSON mode survive explicit bridge policy. A strict JSON schema without a preserving CAPI capability returns a field-specific `400` rather than plain text.
- **AE7.** A request with `previous_response_id` fails without the emulator, succeeds through the existing emulator when the response belongs to the current account, and cannot resolve state from another account. Compaction history and synthetic encrypted state are rejected on the bridge.
- **AE8.** A streamed response emits snapshots for text plus parallel function/custom calls and one terminal event. Malformed JSON, upstream error, EOF-before-terminal, and client abort each follow the distinct error/cancellation contract.
- **AE9.** A source Chat model returning `529` can use one configured overload target after re-running bridge capability checks and translation; a target that lacks the required tool/vision/parallel/streaming capability is not selected.
- **AE10.** Dashboard model JSON keeps `responsesAvailable: false` for a Chat-only model while reporting `defaultResponsesStrategy: "responses-chat-completions"` only when the flag is enabled. The UI labels this as translated/effective behavior, not native support.

### Scope Boundaries

This work covers only the create operation at `POST /responses`. The existing `/responses/input_tokens`, retrieve, input-items, and delete routes retain their current native/emulator behavior; enabling this bridge does not make those operations work against Chat-only upstream models. No new `/responses/compact` endpoint or WebSocket route is added, and the bridge must not advertise WebSocket or remote compaction support. The emulator's input-token result remains a local estimate, not an exact Gemini tokenizer result.

This feature does not implement a second hosted Responses backend, server-side tool execution, prompt/template resolution, remote file retrieval, conversation storage, `previous_response_id` outside the existing emulator, automatic compaction, arbitrary grammar parsing, schema repair, or provider-specific encrypted-state decryption. It does not replace or refactor the Conversation IR globally, change the public Chat Completions route, change native Responses input policies, or broaden `OpenAIChatAdapter` sanitization. It does not use synthetic response IDs as a substitute for missing provider state or claim that a model supports Responses merely because the bridge can translate one request.

The compatibility target is the Codex protocol surface, not model coding quality. Any later end-to-end claim must pin an exact Codex app version and a sanitized request fixture, then state which create/stream/tool/continuation flows were exercised. Enabling the bridge alone is not evidence that a complete Codex long-session workflow is supported.

### Actors and Key Flow

```text
Responses client
  -> ingest/resolve model
  -> native /responses capability? --yes--> existing native transforms -> native strategy
                                   --no + opt-in + /chat/completions--> bridge intent validation
                                                                       -> buildCapiExecutionPlan
                                                                       -> explicit CAPI fields + tool alias map
                                                                       -> Chat Completions strategy
                                                                       -> JSON or stateful SSE translator
                                                                       -> Responses client

Existing emulator/account runtime wraps the same flow:
  request account -> emulator expansion/persistence callbacks -> bridge/native dispatch
```

The bridge branch is selected early in the Responses handler. Native-only transforms such as native remote-image rejection, orphan filtering, native parameter filters, and native context-management injection remain behind the native branch. The bridge performs its own intent validation and must not reuse a normalizer that silently drops fields.

## Planning Contract

### Key Technical Decisions

- **KTD1. Capability selection is native-first and centralized.** Add/retain one `resolveResponsesStrategyName(model)` decision used by handler, strategy registry, overload validation, and Dashboard projection. Native `/responses` wins; only an opt-in Chat endpoint can bridge. This prevents route-level support, fallback validation, and UI claims from drifting. Governs R1-R5.
- **KTD2. Use `buildCapiExecutionPlan` as the base, then patch explicit outbound fields.** Build a normal `ConversationRequest` for reusable text/image/function serialization, then add Responses-only fields to the CAPI plan and payload in a narrow bridge helper. Do not redesign `ConversationRequest` for every Responses field and do not call `OpenAIChatAdapter.fromCapiResponse()` because its sanitizer drops opaque/Copilot metadata needed for a truthful bridge. Governs R6-R15.
- **KTD3. Keep the shared bridge contract small and request-local.** `ResponsesChatRequest` carries the CAPI plan, a read-only alias/tool map, and `TranslationIssue[]`; output options carry the existing response decoration/terminal callbacks. The root-owned bridge types file is the only cross-worker contract. No global alias registry or persisted translation state. Governs R10-R12 and R24.
- **KTD4. Aliases are bounded and collision-safe, with an explicit reverse map.** Encode namespace plus original name into a deterministic reserved Chat function alias under the upstream length limit, resolve collisions against caller tool names and aliases, and retain the exact request-local reverse map. The alias need not be decodable without that map; historical call metadata must travel with the call so later turns can restore the original name/type/namespace. Governs R9-R11.
- **KTD5. Custom text uses a buffered JSON wrapper, not a grammar parser.** A custom call's freeform string becomes one JSON string property in a Chat function call. The output translator buffers the complete argument JSON before unwrapping; it never executes or restores a partial invalid wrapper, including a partial `apply_patch` command. The apply-patch shim is a separate, explicitly lossy compatibility path controlled by `useFunctionApplyPatch`; other grammar declarations are rejected. Governs R10-R12 and R22-R23.
- **KTD6. Preserve explicit fields at the CAPI wire boundary.** Extend internal CAPI types only for fields needed by this bridge (`parallel_tool_calls`, tool `strict`, phase/opaque metadata, reasoning fields, and custom tool-call response metadata). Treat `prompt_cache_key` as advisory lossy input/effect until a typed field is proven; do not invent an outbound extension. Keep public OpenAI Chat validation unchanged unless a field is already an internal CAPI extension. Mirror `parallel_tool_calls: false` and strict's absent/false/true distinction deliberately. Governs R8-R15.
- **KTD7. JSON mode and strict response schemas are separate.** JSON mode maps to CAPI `response_format: { type: "json_object" }`, but acceptance is not proof of valid JSON generation. JSON Schema is forwarded only if the target metadata and CAPI type can preserve the schema and strictness; otherwise the bridge returns `unsupported_structured_output`. Function-tool `strict` is validated independently. Governs R9, R15, and R19.
- **KTD8. State belongs to the existing proxy-owned local emulator.** The bridge consumes the emulator's already-expanded request and sends no conversation/state fields to Chat. Without emulator preparation, state-bearing intent is a translation error. Persistence and retrieval use existing callbacks and account-scoped state; bridge code adds only custom output conversion needed by continuation. Governs R17-R18 and R24.
- **KTD9. Lossy behavior is explicit and observable.** Use `TranslationIssue` for semantic hints that can be omitted without changing the requested model operation, record a bridge translation effect, and log only bounded issue kinds/messages. Unsupported behavior is a `TranslationFailure` with status 400 and a stable kind. Sensitive metadata values and prompt contents never enter debug logs. Governs R13-R19 and Dashboard observability.
- **KTD10. SSE is a state machine, not JSON passthrough.** The output translator owns stable proxy-generated response/item IDs, per-tool-call accumulation, content block closure, terminal selection, and error conversion. `runStrategy()` remains responsible for signal cleanup and client-cancellation behavior. A terminal translation failure closes the upstream iterator immediately. No duplicate terminal events are emitted. Governs R20-R24.
- **KTD11. Upstream failure is not protocol fallback.** A Chat HTTP/stream failure is translated through the existing error/stream hooks; the bridge does not retry the same request through native Responses. The pipeline's existing one-shot overload fallback may select another model only after validating its effective strategy and capabilities. Governs R4, R23, and R24.
- **KTD12. Unknown provider support stays unknown.** Do not add live probes or broad claims about Gemini/hosted tool behavior in this change. Use current model metadata for eligibility and reject bridge semantics that the local contract cannot represent. Document that Chat-only support is an effective proxy capability, not upstream Responses support. Codex protocol compatibility is a separate target from model coding quality: a future success claim must name the exact Codex app version and request fixture used. Governs R3, R5, R16, and Scope Boundaries.

### Current CAPI Plan Gaps and Practical Fix

The existing internal plan is intentionally Chat-shaped and therefore has four gaps relevant to this bridge:

| Gap | Current shape | Narrow bridge solution | Deliberately out of scope |
| --- | --- | --- | --- |
| Parallel calls | `ConversationRequest`/CAPI plan does not carry `parallel_tool_calls` | Add an optional internal CAPI payload field and assign it after `buildCapiExecutionPlan`, preserving explicit `false` | Redesigning all conversation IRs |
| Tool strictness | Public Chat `Tool` has no `strict` field; Responses function tools do | Extend internal CAPI function-tool type and preserve absent/false/true; reject when target cannot preserve requested semantics | Rewriting schemas or forcing `strict: true` |
| Reasoning | `outputEffort` excludes some Responses effort values and summaries/encrypted state are not Chat fields | Map supported `reasoning.effort` explicitly to CAPI `reasoning_effort`; classify summaries/include as lossy or reject replayable state; never invent encrypted content | A new cross-protocol reasoning IR |
| Types/opaque fields | `OpenAIChatAdapter` sanitizer removes Copilot metadata; Responses output unions lack custom calls | Let the bridge own direct CAPI-to-Responses mapping; add narrow Responses input/output/event unions and CAPI metadata fields | Broad sanitizer or public Chat schema refactor |

This is a reusable bridge seam, not permission for a broad refactor. Every new field must have a request/response test and a stated exact/lossy/unsupported policy.

### Alternatives and Trade-offs

- **Preferred: direct two-way translation around the existing CAPI plan.** This keeps one queue/timeout/account boundary, makes loss points visible, and reuses tested message/image/function serialization. It requires a stateful output mapper and narrow internal type additions.
- **Rejected: an internal HTTP self-proxy.** It would add another queue, timeout, auth, and observability boundary, making cancellation and overload recovery harder to reason about without adding protocol fidelity.
- **Rejected: Responses -> Anthropic -> Chat.** A double translation would compound loss around tool namespaces, custom text, reasoning, metadata, and terminal events, while making the Responses client depend on unrelated Anthropic semantics.
- **Known trade-offs:** JSON wrappers enlarge tool schemas and custom-input buffering delays custom argument deltas until the complete JSON wrapper is valid. The plan intentionally does not invent latency metrics; future measurement must use a pinned fixture. The bridge adds no model request or hidden completion call.

### Field Policy Matrix

| Responses input | Chat/CAPI mapping | Policy |
| --- | --- | --- |
| `input` string/message text | user/system/developer/assistant message content | exact |
| `input_image` HTTP/data URL | `image_url.url` plus supported detail | exact when target vision is advertised |
| `input_file`, `file_id`, `file_url` | none | unsupported, `400` |
| function tool/schema | function tool | exact where CAPI type supports fields |
| custom text tool | aliased function with `{input:string}` | reversible/lossy wrapper |
| `apply_patch` custom grammar | gated string-input function shim | explicit lossy grammar, gate required |
| `parallel_tool_calls` | internal CAPI extension | preserve explicit boolean |
| `reasoning.effort` | `reasoning_effort` | capability-gated |
| `reasoning.summary` / `generate_summary` | none | warning/lossy; no fake state |
| `text.format.text` | no format field | exact no-op |
| `text.format.json_object` | `response_format.json_object` | supported JSON mode |
| `text.format.json_schema` | internal CAPI schema field only when exact | otherwise `400` |
| `metadata` | no model input | response/emulator echo; never log/forward blindly |
| `user` | CAPI `user` | exact |
| `prompt_cache_key` | no proven CAPI field | advisory lossy accepted value/effect; never invent an outbound extension |
| `prompt_cache_options`/retention | none | unsupported, `400` |
| `conversation`/`previous_response_id`/store state | emulator-expanded input only | emulator-only; otherwise `400` |
| `compaction`/`context_management` | none | unsupported on bridge, `400` |
| hosted tools and hosted choices | none | unsupported, `400` |

For usage, map Chat `prompt_tokens` to Responses `input_tokens` without subtracting cached tokens; the Responses count is the total input count. Map `completion_tokens` to `output_tokens` and preserve `total_tokens`. If upstream omits usage, keep it `null`/unknown rather than inventing zeroes. Model `phase`, namespace, and metadata fields may be serialized at the wire level, but serialization alone is not a claim that the model gives them exact semantics.

### SSE State and Error Contract

The output translator should maintain one stream state object containing the stable response ID, the accumulated output items, a message content block state, and one function/custom call state per upstream tool-call index. The required behavior is:

1. The first valid Chat chunk emits `response.created`, followed by `response.in_progress`, with the first upstream ID, request-derived envelope metadata, and monotonic `sequence_number` values.
2. Text deltas open one message/output-text item, emit `response.output_item.added`, `response.content_part.added`, then `response.output_text.delta` events. Close with `response.output_text.done`, `response.content_part.done`, and `response.output_item.done` before the terminal event.
3. Tool deltas open one function or custom output item per tool-call index, emit argument/input deltas, accumulate raw argument text, and emit the corresponding done/output-item events exactly once only after the lane is complete and validated, including complete Codex output items. Custom wrappers are buffered and unwrapped only after the complete JSON argument is available; no partial invalid patch is executed or surfaced as a completed call.
4. A normal `[DONE]` after a known finish reason emits `response.completed` or `response.incomplete`, with final usage and output. A length/content-filter finish maps to `response.incomplete` with the matching `incomplete_details` reason. A usage-only tail after finish is consumed before the terminal event; clean EOF with a known finish reason may complete.
5. A malformed chunk, malformed custom/function wrapper, explicit upstream error, stream exception, or early EOF without a finish reason emits a Responses `error` event and one `response.failed` event. The partial response may be included, but it must not be marked completed.
6. Client abort emits no synthetic error/terminal frame. `runStrategy()` still cleans up the linked upstream signal and the existing request store records cancellation.

### Implementation Ownership

| Owner | Files/area | Responsibility |
| --- | --- | --- |
| Request worker | `src/translator/responses/responses-to-chat.ts`, `tests/responses-to-chat.test.ts`; narrow internal CAPI type extensions only as required | Validate bridge intent, build the base CAPI plan, patch explicit fields, build reversible aliases/tool map, preserve PR82 output forms, and report issues/errors |
| Output worker | `src/translator/responses/chat-to-responses.ts`, `tests/chat-to-responses.test.ts`, `src/types/responses.ts` output/input union additions | Convert CAPI JSON and SSE into Responses items/events, restore aliases/custom text/namespaces, map usage/terminal/error state, and preserve opaque values without inventing state |
| Root/integration owner | `src/translator/responses/chat-bridge-types.ts`, `src/routes/responses/{capabilities,handler,strategy-registry,chat-completions}.ts`, `src/pipeline/runner.ts`, `src/state/config-store.ts`, `src/lib/config.ts`, emulator/account/Dashboard/docs, integration tests | Native-first strategy selection, config default, early branch, overload/recovery integration, callbacks, observability, emulator/account preservation, Dashboard distinction, docs, and final gates |

The workers must not modify each other's translator or test files. The root agent resolves shared-type conflicts and owns the final integration diff.

### Risks and Dependencies

- Copilot model metadata can change independently of this proxy. Capability checks are necessary but not sufficient evidence of semantics; the bridge must keep unsupported behavior explicit and avoid live assumptions.
- Chat streaming chunks can omit fields, split JSON arguments across chunks, or terminate without `[DONE]`. Fixtures must cover partial and malformed sequences; no parser should assume one chunk equals one tool call.
- Responses output IDs and emulator state are client-visible. A bridge response ID is an upstream completion identity only; it is not a retrievable hosted Responses resource. Emulator decoration may add local state, but the bridge must not manufacture encrypted state.
- `responsesChatCompletionsFallback` must be kept synchronized across the config, routing, Dashboard, and strategy-registry integration points; current worktree edits are not completion evidence.
- The native handler currently owns native-only mutations. Moving them into a shared pre-translation normalizer would risk silently dropping bridge fields; preserve the early branch and add bridge-specific validation instead.

### Resolved Boundary Decisions

The former OQ1-OQ4 choices are settled for implementation. OQ5-OQ9 are conservative policies rather than blockers; the exact Codex app fixture and actual Gemini execution remain residual evidence.

- **D1. JSON formats:** Support `text.format.type: json_object` as Chat JSON mode, distinct from `structured_outputs`; request acceptance is not a guarantee of valid JSON generation. Support `json_schema` only when the internal CAPI mapping preserves name/schema/description/strictness and the target advertises structured output. Reject unsupported Gemini/other targets with a stable `400`; do not downgrade to plain text.
- **D2. Custom wire forms and identity:** Use the standard Responses `custom_tool_call`, `custom_tool_call_output`, `response.custom_tool_call_input.delta`, and `response.custom_tool_call_input.done` shapes and fields from the Sources section. The bridge requires a resolvable `call_id` for function/custom history; missing or unresolved IDs are rejected. Keep PR82 permissive ingress unchanged. Tool-result item objects retain string/content-array `output`; arbitrary JSON object output is not added to the public schema.
- **D3. Function strictness:** `strict: true` on a function tool is accepted only for a structured-capable Chat target and only when the internal CAPI type preserves it. Absent strict is an explicit lossy policy/effect because Responses and Chat differ; `strict: false` is preserved where typed support exists or rejected rather than erased.
- **D4. Reasoning/state:** Map supported `reasoning.effort`; omit plain provider reasoning without an exact replay format and record a bounded lossy issue. Reject replayable reasoning/compaction state. Never synthesize, decrypt, or validate `encrypted_content`.
- **D5. Apply-patch grammar:** Under the existing `useFunctionApplyPatch` gate, allow only an exact pinned client grammar fixture/allowlist. Unknown grammar is rejected; no arbitrary grammar parser or patch executor is introduced. The wrapper is marked lossy and restored as a custom call.
- **D6. Metadata/cache/privacy:** Echo only an allowlisted metadata projection in local Responses/emulator results and never log values. Treat `prompt_cache_key` as advisory lossy input/effect without inventing a CAPI field; reject cache retention/options and unsupported privacy identifiers.
- **D7. SSE completion:** Use exact SDK event names and monotonic `sequence_number`. Buffer custom JSON until valid, emit `output_item.done` only for a complete validated lane, consume usage-only tails, and fail early EOF/unfinished lanes truthfully. A pinned Codex fixture determines client-visible handling of `response.incomplete`.
- **D8. Runtime and residual evidence:** Run focused local tests plus Bun/Node packaged smoke; do not use live Copilot. Actual Gemini execution, tokenizer/coding quality, and full long-session Codex behavior require a later pinned app/version fixture and are residual evidence, not blockers for this bounded implementation.

## Implementation Units

### U1. Build Responses-to-Chat request translator

- **Goal:** Produce a validated `ResponsesChatRequest` for a Chat-capable model without mutating the caller payload.
- **Requirements:** R6-R19, plus the CAPI gap table and PR82 preservation constraint.
- **Files:** `src/translator/responses/responses-to-chat.ts`; `tests/responses-to-chat.test.ts`; narrow internal type additions under `src/core/capi/types.ts` or related CAPI type modules only when needed.
- **Approach:** Normalize `input` into `ConversationRequest` turns and images, use `buildCapiExecutionPlan`, then explicitly patch `parallel_tool_calls`, strict tool fields, reasoning effort, JSON mode/schema, phase, user, and only approved CAPI fields. Treat `prompt_cache_key` as advisory lossy metadata/effect rather than an invented outbound extension. Build aliases before serializing tool calls and history. Keep a reverse `toolMap`; include custom/apply-patch restore metadata in the root-owned shared type if the existing `{ type, name, namespace }` shape is insufficient. Validate unsupported state/compaction/hosted tools/strict formats before the first outbound call. Use `TranslationFailure` for unsupported intent and `TranslationIssue` for declared lossy hints.
- **Test scenarios:**
  - instructions plus system/developer/user/assistant text preserve order and the source payload remains unchanged;
  - plain input string becomes a user message;
  - HTTP and data-URL images preserve URL and detail, while file input and unsupported detail fail;
  - one function call, valid PR82 object-form output with a resolvable `call_id`, unresolved/missing `call_id` rejection, multiple parallel calls, sequential multi-turn calls, reversed tool-result order, orphan output, duplicate call ID, and historical namespaced calls;
  - ordinary custom text wrapper round-trip input shape, apply-patch gate/grammar, arbitrary grammar rejection, and collision-safe aliases under the Chat name limit;
  - explicit `parallel_tool_calls: false`, absent/false/true function-tool `strict` policy, reasoning effort including `minimal`, advisory prompt-cache effect, user, JSON mode, and JSON-schema capability gate;
  - metadata/privacy/hints are classified without sensitive-value logging;
  - state, compaction, `truncation: auto`, hosted tool, hosted choice, unsupported file, and unsupported prompt/service-tier intent fail before a Chat call; `truncation: disabled` remains no-truncation policy without silent trimming;
- **Verification:** Run `bun test tests/responses-to-chat.test.ts`; snapshot the final CAPI payload/tool map for representative text/image/parallel/custom cases. Not run in this planning turn; execution must report the result.

### U2. Build Chat-to-Responses JSON and SSE translator

- **Goal:** Convert CAPI Chat completion JSON/chunks into truthful Responses result objects and lifecycle events.
- **Requirements:** R20-R24.
- **Files:** `src/translator/responses/chat-to-responses.ts`, `tests/chat-to-responses.test.ts`, and the output/input union additions in `src/types/responses.ts`.
- **Approach:** Add narrow `custom_tool_call` and matching history/output types while retaining existing function-call output unions and PR82 object forms. Implement one JSON mapper and a stateful stream mapper sharing output-item/usage/terminal helpers. Restore aliases/namespaces from the request-local map; unwrap only the exact custom `{input:string}` wrapper; retain raw function argument text. Preserve actual CAPI opaque/reasoning values only when present and representable; never synthesize `encrypted_content`, signatures, citations, or compaction. Map finish reasons and usage without inventing measured zeroes. Emit stable IDs and the full Responses terminal/error event sequence described above.
- **Test scenarios:**
  - JSON text-only response, mixed text/function response, parallel function calls, custom tool output, namespaced restoration, usage/details, and incomplete/content-filter finish reasons;
  - CAPI reasoning/opaque fields are either represented from actual upstream values or explicitly omitted with a recorded lossy policy, never fabricated;
  - stream snapshots for `response.created`/`response.in_progress`, sequence numbers, message/text/function/custom output items, `response.custom_tool_call_input.delta`/`done`, complete `response.output_item.done` events, usage-only tails, and one terminal event;
  - malformed JSON, invalid custom wrapper, explicit error chunk, upstream stream exception, and EOF-before-terminal emit `error` plus `response.failed` exactly once;
  - truncated/unvalidated custom or function lanes do not emit executable `response.output_item.done`; a pinned Codex fixture checks `response.incomplete`/EOF handling as client-visible error behavior;
  - `[DONE]` and `onStreamDone` are idempotent, and client cancellation emits no fabricated terminal/error;
  - response decoration and terminal callbacks run once and receive the final response.
- **Verification:** Run `bun test tests/chat-to-responses.test.ts`; keep snapshots deterministic by using fixed upstream IDs/timestamps and normalize only intentionally dynamic fields. Not run in this planning turn; execution must report the result.

### U3. Integrate native-first strategy and pipeline behavior

- **Goal:** Route eligible Responses requests through the bridge while preserving native strategy, overload recovery, queue ownership, and existing hooks.
- **Requirements:** R1-R5, R17-R19, R24.
- **Files:** Root-owned `src/routes/responses/capabilities.ts`, `src/routes/responses/handler.ts`, `src/routes/responses/strategy-registry.ts`, `src/routes/responses/chat-completions.ts`, `src/pipeline/runner.ts`, and `src/translator/responses/chat-bridge-types.ts`.
- **Approach:** Resolve native vs bridge before native-only transforms. Prepare `chatRequest` during `afterTransform` for preflight validation, then let the strategy registry select `responses-chat-completions`. Dispatch the CAPI plan with the existing `CopilotClient.createChatCompletions()` request context and linked upstream signal. Keep native transforms and native passthrough unchanged behind the early branch. Make overload validation call the same strategy resolver and recompute the request on the fallback target. Keep `buildCapiRequestContext`, initiator, account runtime, request ID, effects, and model disclosure aligned with the existing pipeline.
- **Test scenarios:**
  - fallback disabled, fallback enabled, native dual-endpoint precedence, missing endpoints, vision/tool/parallel/streaming/reasoning/structured capability rejection;
  - source native -> Chat target and source Chat -> Chat target overload fallback with target payload rebuilt and effective model disclosed;
  - source/target preflight rejection preserves the original upstream status and does not issue a second incompatible call;
  - client abort, upstream timeout, queue/recovery errors, and stream error observer behavior stay aligned with existing routes.
- **Verification:** Run focused route tests plus `bun test tests/responses-routing.test.ts tests/pipeline-internals.test.ts`. No integration result is claimed here; execution must report the result.

### U4. Integrate config, emulator, account scoping, and observability

- **Goal:** Keep the bridge opt-in, account-local, emulator-compatible, and observable without leaking sensitive request data.
- **Requirements:** R2, R13, R17, R24.
- **Files:** Root-owned `src/lib/config.ts`, `src/state/config-store.ts`, `src/routes/responses/emulator.ts` only for custom output continuation compatibility, `src/observability/effects.ts`, account-runtime integration if a test exposes a gap, and related tests.
- **Approach:** Add the boolean config schema/getter with default `false`. Leave emulator preparation/persistence and TTL/account state in the existing state store; extend output-to-input continuation for custom tool calls and preserve namespace/object-form tool outputs. Record a distinct bridge strategy effect and a bounded lossy-translation effect. Do not add a second state store or log metadata values.
- **Test scenarios:**
  - config default and explicit `true`/`false` parsing;
  - emulator non-stream and stream persistence through a custom call, later continuation, and delete/TTL behavior;
  - two account runtimes cannot resolve each other's response/conversation/tool state;
  - translation effects and terminal error metadata are recorded once without request-body/metadata leakage.
- **Verification:** Run `bun test tests/config-state.test.ts tests/responses-emulator.test.ts tests/account-routing-runtime.test.ts tests/dashboard-runtime.test.ts`. Not run in this planning turn; execution must report the result.

### U5. Add Dashboard capability distinction and documentation

- **Goal:** Operators can distinguish upstream native Responses from effective Chat translation and understand its opt-in/limitations.
- **Requirements:** R5, R16-R19, R24.
- **Files:** Root-owned `src/routes/dashboard/handler.ts`, `src/routes/dashboard/assets.ts`, `tests/dashboard-introspection.test.ts`, `tests/dashboard-assets.test.ts`, `README.md`, `docs/design/model-routing.md`, `docs/design/translation-pipeline.md`, `docs/design/dashboard-observability.md` if projection contract changes, and the relevant Responses compatibility/upstream notes.
- **Approach:** Preserve `upstream.endpoints` and `responsesAvailable` as native facts. Add effective strategy/config fields and label the UI as translated Chat behavior. Document field policy, emulator-only state, no hosted-tool execution, no synthetic encrypted state, native-first selection, and the absence of live capability guarantees. Keep docs aligned with the actual route/registry names.
- **Test scenarios:**
  - Chat-only model with flag off/on has `responsesAvailable: false` but effective strategy changes only when enabled;
  - dual-endpoint model remains native;
  - Dashboard behavior/model HTML/API projections expose the distinction and do not include sensitive metadata;
  - README/config and design docs describe the default and unsupported boundary.
- **Verification:** Run `bun test tests/dashboard-introspection.test.ts tests/dashboard-assets.test.ts` and review docs against `resolveResponsesStrategyName` and registry ordering. This plan does not claim validation of those surfaces.

### U6. Exercise integrated JSON/SSE, fallback, cancellation, and packaged runtimes

- **Goal:** Prove the bridge end to end with deterministic mocks under Bun and the package's Node compatibility path.
- **Requirements:** R1-R24.
- **Files:** Root-owned integration additions such as `tests/responses-chat-routing.test.ts`, existing response resilience/contract suites, and only the smallest packaged selfcheck fixture if the current smoke does not exercise the new bridge.
- **Approach:** Mock `CopilotClient.createChatCompletions` and `createResponses`; never use live Copilot. Add JSON and SSE snapshots, stream cancellation, malformed/error/EOF cases, overload fallback, emulator persistence, account isolation, and native precedence. Run the repo's normal full gate and packaged smoke so route code is built and exercised under Bun and Node. Use stable test IDs and clean all temporary state.
- **Test scenarios:**
  - the acceptance examples AE1-AE10 as route-level tests;
  - contract smoke still passes for native Responses and emulator resources;
  - stream output is valid SSE and never duplicates a terminal event;
  - `bun run smoke:packaged` passes both Bun and Node launcher/selfcheck paths without importing Bun-only APIs from route/translator code.
- **Verification:** See the Verification Contract below; no `matrix:live` invocation is authorized by this proposal.

## Verification Contract

### Focused gates

Run these after the relevant units are integrated. They are required gates; results are not claimed in this planning artifact:

```text
bun test tests/responses-to-chat.test.ts
bun test tests/chat-to-responses.test.ts
bun test tests/responses-chat-routing.test.ts
bun test tests/responses-routing.test.ts tests/responses-emulator.test.ts tests/responses-resilience-probe.test.ts
bun test tests/config-state.test.ts tests/dashboard-introspection.test.ts tests/dashboard-assets.test.ts
```

The focused tests must use local mocks and deterministic snapshots. They must not invoke `bun run matrix:live` or any real Copilot account. No focused tests were run in this planning turn.

### Runtime and full gates

Implementation is complete only when all of the following pass from a clean final worktree apart from the approved change:

```text
bun run lint:all
bun run typecheck
bun test --path-ignore-patterns='**/token-file-removal.test.ts' --path-ignore-patterns='**/token-refresh-retry.test.ts'
bun test tests/token-file-removal.test.ts tests/token-refresh-retry.test.ts
bun run build
bun run smoke:packaged
```

`smoke:packaged` is the Bun+Node package gate. If the current packaged selfcheck does not load/execute a bridge fixture, add the smallest local fixture necessary to prove the built import graph and route translator under both runtimes; do not add a live upstream call. This gate has not been run in this planning turn.

### Review checks

- Verify `git diff --check` and formatter/lint output; no generated `dist/` edits are hand-maintained.
- Inspect JSON/SSE snapshots for accidental metadata, prompt, token, or encrypted-state leakage.
- Confirm all unsupported fields have either a stable `400` kind/message or a recorded lossy issue/effect; no silent drops.
- Confirm `responsesAvailable` remains native-only in Dashboard/API projections and `defaultResponsesStrategy` is the effective behavior.
- Confirm client cancellation is distinct from upstream timeout/error and no background process, live probe, or temporary file remains.

## Definition of Done

- `responsesChatCompletionsFallback` validates as a boolean, defaults to `false`, and is displayed separately from native Responses capability.
- Native `/responses` models retain the existing strategy and transforms; Chat-only models bridge only when explicitly enabled and Chat-capable.
- Request and output translators implement the field policy and unsupported boundary in this plan, including text/images, function calls, parallel/sequential history, custom text, namespaces, gated apply-patch, JSON mode/schema handling, reasoning policy, metadata/privacy treatment, and PR82 object-form tool outputs.
- JSON and SSE outputs are Responses-compatible, have stable IDs and truthful usage/terminal/error events, and never invent encrypted/decrypted model state or hosted tool execution.
- Existing emulator, account routing, queue/recovery, overload fallback, request effects, terminal callbacks, and cancellation semantics remain intact and are covered by tests.
- Dashboard API/UI and design/README documentation distinguish upstream native support from effective translated support and state the limitations plainly.
- Focused snapshots, route/error/cancel/fallback tests, full lint/typecheck/test/build gates, and Bun+Node packaged smoke all pass without live Copilot calls.
- The final diff contains no abandoned experimental translator, duplicate alias registry, broad IR refactor, generated build output, unrelated cleanup, or untracked scratch artifact.

## Appendix

### Stable error kinds to keep machine-readable

The exact naming may follow the repository's existing error conventions, but the bridge must retain stable field-specific categories for at least:

```text
unsupported_responses_chat_endpoint
unsupported_hosted_tool
unsupported_tool_choice
unsupported_input_file
unsupported_image_detail
unsupported_namespace
unsupported_apply_patch_grammar
unsupported_responses_state
unsupported_responses_compaction
unsupported_truncation
unsupported_prompt
unsupported_safety_identifier
unsupported_prompt_cache_options
unsupported_service_tier
unsupported_structured_output
invalid_function_call_history
invalid_custom_tool_call
```

Upstream/stream failures use the existing HTTP/translation error mapping plus a Responses SSE `error`/`response.failed` terminal pair. These categories describe the proxy boundary and must not be presented as a complete inventory of what Copilot supports upstream.

### Sources

Primary protocol references read on September 11, 2026, to re-check during implementation:

- `https://developers.openai.com/codex/config-reference`
- `https://developers.openai.com/api/docs/guides/migrate-to-responses`
- `https://developers.openai.com/api/docs/guides/function-calling`
- `https://developers.openai.com/api/docs/guides/streaming-responses`
- `https://developers.openai.com/api/docs/guides/reasoning`
- `https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_in_progress_event.py`
- `https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_custom_tool_call_input_delta_event.py`
- `https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_custom_tool_call_input_done_event.py`
- `https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs`

The SDK sources settle the typed fields for `response.in_progress` and custom
tool input delta/done events, including `item_id`, `output_index`, and
`sequence_number`. The Codex SSE parser source is the client-compatibility
reference for output-item completion, incomplete/error handling, and EOF
behavior; it does not prove Copilot upstream support. A future implementation
must pin the installed Codex app/fixture before claiming end-to-end success.

### Research breadcrumbs

- `src/routes/responses/handler.ts` — current native-only after-transform policies and emulator callbacks; the bridge must branch before those policies.
- `src/routes/responses/strategy.ts` — existing native Responses ID stabilization, terminal observation, and EOF behavior to preserve conceptually.
- `src/routes/responses/strategy-registry.ts` and `src/pipeline/runner.ts` — strategy selection, overload recovery, and capability validation ownership.
- `src/core/capi/plan-builder.ts` and `src/core/capi/types.ts` — reusable CAPI plan construction and the internal wire-type gaps listed above.
- `src/adapters/openai-chat-adapter.ts` — reusable Chat-to-Conversation shape, but its response sanitizer is intentionally not suitable for this bridge.
- `src/translator/responses/anthropic-to-responses.ts`, `src/translator/responses/response-items.ts`, and `src/translator/responses/responses-to-anthropic.ts` — existing Responses item conventions, signature/state boundaries, and the explicit precedent for rejecting unsupported translated semantics.
- `src/routes/responses/emulator.ts` and `src/state/responses-emulator-state.ts` — existing continuation, persistence, TTL, and account-runtime ownership.
- `src/routes/dashboard/handler.ts` and `src/routes/dashboard/assets.ts` — current upstream/effective model projection and operator-visible compatibility text.
- `docs/design/execution-strategy.md`, `docs/design/model-routing.md`, `docs/design/translation-pipeline.md`, and `docs/responses-stream-compatibility.md` — pipeline/strategy/translation/SSE contracts that the new bridge must extend without changing native behavior.
