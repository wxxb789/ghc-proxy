# Messages Routing and Translation

This document describes how `ghc-proxy` handles Anthropic Messages requests now that GitHub Copilot models can expose different upstream endpoints.

## Routing Order

Incoming `POST /v1/messages` requests pass through the common pipeline:

1. Parse and validate the Anthropic payload.
2. Apply configured model rewrites, dash/dot correction, and optional compact
   routing, then look up the resulting model exactly.
3. Select one of three execution strategies from the model metadata **and the
   payload**.
4. Apply strategy-specific transforms, dispatch upstream, and translate the
   result when the selected boundary is not Anthropic-native.

The strategy priority is:

1. Native Copilot `POST /v1/messages`
2. Copilot `POST /responses` through the Anthropic <-> Responses translators
3. Copilot `POST /chat/completions` through the existing Anthropic adapter pipeline

Native Messages wins when the model exposes it and the payload can be
preserved there. Structured output is payload-aware: a model that advertises
native structured output can receive a format containing `type`, `schema`, and
an optional `name` (the label is removed upstream), but a format containing
`description` or `strict` routes through Responses because native Copilot
rejects those fields and dropping them would change semantics. If Responses is
unavailable, the Chat Completions strategy returns `400` rather than dropping
the format.

The configured Claude family fallbacks are not part of this strategy
selection. They run later, and only if the Chat Completions adapter (or the
Messages token-count adapter) builds a CAPI plan. See
[Model Resolution and Routing](design/model-routing.md).

## Native Messages Path

When a model supports Copilot `POST /v1/messages`, the proxy forwards the Anthropic payload with minimal mutation:

- Existing assistant thinking blocks that only contain placeholder or encoded Responses state are filtered before passthrough.
- `output_config` is stripped for models that reject it (see `MODELS_REJECTING_OUTPUT_CONFIG` in `model-cache.ts`). For models that accept it, unknown keys are preserved, a null/no-op effort is removed, and an unsupported effort is replaced with the highest-ranked effort the model advertises. Structured `format` stays native only under the payload-aware rule above; native reduction removes `name` but never silently removes `description` or `strict`.
- `cache_control` fields on system blocks, messages, content blocks, and tools are normalized to `{ type: "ephemeral" }` — extra sub-fields like `scope` are stripped because the upstream Copilot API does not yet accept them. This is a temporary workaround; when Copilot supports `scope`, the filter (`sanitizeCacheControl` in `strategy-registry.ts`) should be removed. The `smoke-cache-control` script includes a direct upstream probe that will fail when `scope` becomes accepted, signalling the filter is no longer needed.
- `thinking.type: "enabled"` (classic budget-based thinking) is converted to `thinking.type: "adaptive"` for models that advertise `capabilities.supports.adaptive_thinking` (e.g. `claude-sonnet-5`, `claude-opus-5`), whose upstream `/v1/messages` endpoint rejects the classic shape with a `400`. Unless the caller supplied an effort, `budget_tokens` maps to `high` at `>=24000`, `medium` at `>=8000`, and `low` below that. The conversion runs before output-config sanitization, so every derived or explicit tier is normalized against the model's advertised list. Models without `adaptive_thinking` keep the classic `enabled` shape. See `convertEnabledThinkingToAdaptive` in `sanitize.ts`.
- If both `temperature` and `top_p` are present, the native sanitizer keeps `temperature` and removes `top_p`. Copilot rejects the pair on non-reasoning Messages models, and this rule is applied consistently on the native boundary.
- `max_tokens` above `capabilities.limits.max_output_tokens` is lowered to the advertised ceiling. No ceiling is guessed when model metadata omits it.
- Standard function tools retain their function semantics, including typed
  `custom` tools and nullable `type` values when `name` plus `input_schema` are
  present. Anthropic-defined built-ins and client toolsets use a non-null `type`
  other than `custom`; they remain typed built-ins/toolsets even if a caller
  adds an `input_schema`, and a toolset may omit `name`. Those shapes are
  accepted at ingress and forwarded only on this native path. Whether a
  particular built-in runs is still
  model/upstream-specific; local acceptance does not imply upstream support.
- `search_result` content blocks are forwarded when Copilot accepts the shape. A live upstream probe on April 17, 2026 against `claude-opus-4.6` confirmed that Copilot accepts top-level user `search_result` blocks and pure `tool_result.content[]` arrays of `search_result` blocks. The same probe showed two important native-path sanitizers are still required: top-level `citations` is stripped because Copilot rejects it, and mixed `tool_result.content[]` arrays containing both `search_result` and non-`search_result` blocks are flattened to a single text block because Copilot requires all blocks in that tool result to be `search_result` when any are.
- Anthropic beta headers that Copilot does not support, such as `context-*` and `mid-conversation-system-*`, are stripped before upstream forwarding. Context betas can still trigger configured context-upgrade routing before they are removed.
- Other fields are passed through as-is to the upstream endpoint unless a documented sanitizer above handles a known Copilot incompatibility.

`POST /v1/messages/count_tokens` accepts the same function/built-in/toolset
union. Function tools use the existing Chat-shaped estimator. Known browser and
computer toolsets use conservative documented token costs; other typed
definitions are counted from their serialized Anthropic shape rather than being
relabeled as executable Chat functions.

Run `bun run scripts/probes/messages/search-results.ts --json` to refresh the current Copilot `search_result` support snapshot.

## Responses Translation Path

When a model supports `/responses` but not native `/v1/messages`, the proxy translates Anthropic Messages into Responses input items, executes the request, and translates the result back into Anthropic shape.

The request-side sequence is: Anthropic -> Responses translation, optional
context-management injection, optional compaction slicing, removal of
translator-generated assistant `phase`, per-model Responses parameter
filtering, and the Copilot `max_output_tokens >= 16` floor. JSON responses use
the stateless Responses -> Anthropic mapper; SSE uses a stateful transducer that
tracks content blocks, function-call lanes, terminal state, and protocol-level
errors. This is separate from the native `POST /v1/responses` handler, even
though both paths share several request transforms.

### Exact or Near-Exact Mappings

| Anthropic input | Responses input | Notes |
| --- | --- | --- |
| `system` | `instructions` | Preserved as text. |
| User text | `message` with `input_text` | Preserved in order. |
| User image | `message` with `input_image` | Preserved as data URL input. |
| User `tool_result` | `function_call_output` | Preserved by `tool_use_id` / `call_id`; `is_error: true` maps to `status: incomplete`. |
| User `search_result` | `message` with `input_text` | Flattened to text containing title, source, and content. Citation metadata is not preserved. |
| `tool_result` `search_result` content | `function_call_output` | Flattened to text containing title, source, and content. |
| Assistant text | `message` with `output_text` | Preserved as assistant history. |
| Assistant `tool_use` | `function_call` | Preserved as call ID, name, and JSON arguments. |
| Assistant reasoning with proxy replay signature | `reasoning` | A proxy-private carrier is decoded back into the Responses item ID and encrypted content. Missing or malformed replay IDs are not emitted as reasoning input. |
| Proxy compaction carrier | `compaction` | The proxy's `cm1#...` carrier restores the opaque item ID and encrypted content; it is not a general Anthropic signature decoder. |
| Anthropic function tools | Responses function tools | The caller's `required` and `additionalProperties` semantics are preserved, while JSON Schema/OpenAPI annotations rejected by the compatibility normalizer (for example `$schema`, `title`, `format`, `default`, and examples) are recursively removed. No `strict` key is invented. See [research/responses-tool-strict.md](research/responses-tool-strict.md). |

### Intentional Policy Decisions

| Feature | Behavior | Reason |
| --- | --- | --- |
| `thinking: disabled` | Maps to `reasoning.effort = none` | Preserves explicit disable intent; `none` is not clamped upward. |
| `thinking: adaptive` with no explicit effort | Candidate `reasoning.effort = medium` | The candidate is then normalized against the resolved model's advertised efforts. |
| `thinking: enabled` with no explicit effort | Configured model effort, defaulting to `medium` | The candidate is normalized against the same advertised list. |
| `output_config.effort` | Maps to Responses reasoning effort | Preserves explicit caller intent when supported. An unsupported ranked tier is replaced by the highest-ranked advertised tier; `none`/`minimal` are Responses-only values and are not clamp targets. The canonical order is `low < medium < high < xhigh < max`, but a model need not advertise a prefix (`claude-opus-4.6` advertises `max` but not `xhigh`). See [research/sampling-parameters.md](research/sampling-parameters.md). |
| `output_config.format` | Maps JSON Schema structured output to Responses `text.format` | Preserves schema-constrained output when native `/v1/messages` cannot safely carry the field. |
| `apply_patch` custom tool | Optional shim to function tool | Controlled by `useFunctionApplyPatch`. |
| Responses context compaction | Optional policy | Disabled by default. Requires `responsesApiAutoContextManagement: true` and a model match in `responsesApiContextManagementModels`. |

### Explicitly Unsupported on Translated Paths

The Responses translation path rejects these Anthropic fields with `400`:

- `stop_sequences`
- `service_tier`
- Anthropic built-in/toolset definitions (`unsupported_server_tool`)

The Chat Completions fallback likewise rejects `service_tier` and Anthropic
built-ins/toolsets, while it can represent `stop_sequences`. These fields are rejected
when the selected translation cannot preserve their semantics safely. Built-in
tools are not relabeled as ordinary function tools merely because a translated
endpoint supports functions. Rejection happens before any translated upstream
request is sent; the proxy does not silently drop or approximate the field.

`top_k` used to be rejected here too. Probing showed Copilot accepts it on every boundary, so it is now forwarded as a Copilot extension — see [research/sampling-parameters.md](research/sampling-parameters.md).

## Responses API Compatibility Policies

`POST /v1/responses` is handled as a native OpenAI-style endpoint, but the proxy still applies explicit compatibility rules:

- Requests are validated before mutation.
- Common official fields such as `conversation`, `previous_response_id`, `max_tool_calls`, `truncation`, `user`, `prompt`, and `text` are modeled explicitly.
- Official `text.format` options such as `text`, `json_object`, and `json_schema` are validated explicitly.
- `custom` `apply_patch` can be rewritten into a function tool when enabled.
- Automatic `context_management` injection is disabled by default and only applies when explicitly enabled in config.
- Automatic prompt slicing to the latest `compaction` item is disabled by default and only applies when explicitly enabled in config.
- Built-in web-search tools (`web_search`, `web_search_preview`, and their dated variants) are forwarded, not blocked. The 2026-08-04 acceptance sweep found `web_search` accepted by every reached `/responses` model and `web_search_preview` accepted in every measured cell; real search execution was verified on `gpt-5.6-sol` and `gpt-5.6-terra`. See [research/responses-web-search.md](research/responses-web-search.md).
- Function-tool `strict` is forwarded when the caller sends it and omitted entirely when they do not. The proxy previously defaulted it to `true` and rewrote each schema's `required` to every declared property plus `additionalProperties: false` to make that default survivable, which silently promoted optional parameters to required. Omission is measurably safer than `strict: false`: upstream runs a different validator when the key is present at all. See [research/responses-tool-strict.md](research/responses-tool-strict.md).
- Function-tool parameter schemas pass through the same recursive compatibility normalizer used by the Anthropic -> Responses translator. Structural constraints are preserved; unsupported descriptive annotations are removed. A caller-sent `strict: null` is normalized to omission.
- External `input_image.image_url` values that point at remote HTTP(S) URLs fail explicitly with `400`.
- `max_output_tokens` below Copilot's enforced minimum of 16 is raised to 16 rather than leaking a `400`. The client-facing schema still accepts `0..15` because those are valid OpenAI input; the floor is a Copilot quirk the proxy absorbs. See [research/sampling-parameters.md](research/sampling-parameters.md).
- Explicit prompt-caching controls (`prompt_cache_options`, and `prompt_cache_breakpoint` on content blocks) are modeled and forwarded. `ttl` is constrained to the single value upstream accepts (`30m`) and an unknown `mode` is rejected locally, turning a wasted round-trip into an immediate `400`. Only gpt-5.6 and later accept these — earlier models return `400 ... is not supported on this model` — so the proxy forwards rather than injects them. See [research/prompt-caching.md](research/prompt-caching.md).
- `store` is forced to `false` as a proxy-wide stateless policy. The Copilot GPT
  models re-verified on 2026-08-25 reject `store: true`; successful stateless
  responses still carry IDs, but upstream cannot retrieve or continue from
  them later. Without the optional emulator, a caller's `store: true` intent is
  therefore coerced rather than rejected at the proxy boundary.
- Official `input_file` items are modeled and forwarded. `item_reference` items are modeled for boundary compatibility but removed before dispatch, as are orphaned `function_call_output` items whose `call_id` has no matching `function_call` in the same input array. This filtering intentionally trades unavailable cross-request state for a request Copilot can execute.
- Unknown fields are passed through when they do not interfere with proxy-side policies, so newer official fields can continue to flow to Copilot when the upstream endpoint supports them.

### Output, signatures, and usage

- Responses reasoning and compaction items are exposed as Anthropic `thinking`
  blocks with proxy-private replay signatures. The signatures carry opaque
  Responses state; they are transport encodings, not cryptographic validation
  of arbitrary Anthropic signatures. A reasoning carrier is
  `<encrypted_content>@<item_id>` (split at the final `@`); a compaction carrier
  is `cm1#<encrypted_content>@<item_id>`. Replay requires non-empty encrypted
  content and an item ID.
- When a non-streaming terminal Responses object omits `usage`, the Anthropic
  schema still requires token counts, so the translator supplies
  `input_tokens: 0` and `output_tokens: 0`. Those zeroes mean "upstream did not
  provide usage", not a measured zero-token request.
- Streaming `message_start` is provisional: `output_tokens` starts at zero and
  absent input/cache metrics also default to zero. The terminal
  `message_delta` carries the mapped final usage when upstream provides it.
- `cache_read_input_tokens` is subtracted from `input_tokens` to match
  Anthropic's split accounting. A positive `cache_write_tokens` becomes
  `cache_creation_input_tokens`; zero or absent writes are omitted.

### Current live upstream note

As of March 11, 2026, local end-to-end scans against every Copilot model that advertised `/responses` support showed a stable vision mismatch:

- external image URLs were rejected upstream with `400`
- the proxy now rejects external image URLs locally because that upstream rejection was stable across the full scanned `/responses` model set
- the current PNG data URL probe was also rejected upstream, despite the fixture decoding as a valid image locally

That means the proxy cannot currently promise end-to-end Responses vision support just from model metadata. Vision on the Responses path should be treated as a live-verified capability, not a static guarantee.

The same applies to the broader Responses resource surface. As of March 11, 2026, live probes showed:

- `POST /responses` works
- `POST /responses/input_tokens` returns upstream `404`
- `GET /responses/{id}` returns upstream `404`
- `GET /responses/{id}/input_items` returns upstream `404`
- `DELETE /responses/{id}` returns upstream `404`
- `previous_response_id` follow-up requests return upstream `400 previous_response_id is not supported`

Those routes are still exposed by the proxy because they belong to the official OpenAI Responses surface, but current Copilot upstream support is not there yet.

### Server-side tool support

As of April 30, 2026, the Copilot `/v1/messages` endpoint recognizes type-based (server-side) tools but support varies per model. A comprehensive probe across all Claude models showed:

| Tool type | Universally supported | Notes |
|-----------|----------------------|-------|
| Standard function tools (`input_schema`) | Yes | All models |
| `bash_20250124` | Yes | All models |
| `text_editor_20250728` | Yes | All models (name must be `str_replace_based_edit_tool`) |
| `custom` | Yes | All models |
| `memory_20250818` | Partial | Opus 4.6+, Opus 4.7, Sonnet 4.5, Haiku 4.5 |
| `tool_search_tool_*` | Partial | Opus 4.6+, Opus 4.7, Sonnet 4.5 |
| `code_execution_20250522` | Partial | Opus 4.7 only |
| `code_execution_20250825` | Partial | Opus 4.7 only |
| `code_execution_20260120` | Partial | Opus 4.7 only |
| `web_search_20250305` | No | Tag registered but policy-blocked on all models |
| `web_search_20260209` | No | Not registered on any model |
| `web_fetch_20250910` | No | Not registered on any model |
| `web_fetch_20260209` | No | Not registered on any model |
| `mcp_toolset` | No | Not registered on any model |
| `mcp-client-2025-11-20` | No | Not registered on any model |
| `text_editor_20250124/0429` | No | Deprecated; newer models reject them |
| `computer_20250124` | No | Tag not registered |

All Opus 4.7 variants (`claude-opus-4.7`, `claude-opus-4.7-high`, `claude-opus-4.7-xhigh`) have identical tool support. They gained `code_execution` (all three versions) and `tool_search_tool_bm25` compared to Opus 4.6.

**2026-07-25 update (`claude-opus-5`, `claude-sonnet-5`):** both re-probed with an identical surface — 12 supported / 9 rejected. Supported: standard function, `bash_20250124`, `text_editor_20250728`, `memory_20250818`, `custom`, `tool_search_tool_bm25`(+`_20251119`), `tool_search_tool_regex`(+`_20251119`), `code_execution_20250522`/`20250825`/`20260120`. Rejected: older `text_editor` dates, `web_search_*`, `web_fetch_*`, `mcp_*`, `computer_*`. Two shifts from the April-30 baseline: `code_execution` is no longer Opus-4.7-only (both v5 models accept all three versions), and `claude-sonnet-5` accepts `tool_search_tool_bm25` — unlike Bedrock-served `claude-sonnet-4.6`, which rejects bm25 — indicating v5 Sonnet runs on Anthropic-native infra.

On the `/responses` endpoint (GPT models including `gpt-5.5`), `web_search_preview` and custom tools (`apply_patch`, `shell`) are accepted. `file_search`, `code_interpreter`, `computer_use_preview`, `image_generation`, and `mcp` are rejected. `gpt-5.5` has identical tool support to `gpt-5.4`.

**2026-08-04 update (web search on `/responses`):** the Codex/ChatGPT built-in
`web_search` type was probed for the first time and is accepted by **every**
`/responses` model — `gpt-5-mini`, `gpt-5.3-codex`, `gpt-5.4`(`-mini`),
`gpt-5.5`, all three `gpt-5.6-*`, `grok-4.5`, `mai-code-1-flash-picker` — as is
`web_search_preview`. Acceptance is not the whole finding: `gpt-5.6-sol` and
`gpt-5.6-terra` emit real `web_search_call` items with `url_citation`
annotations, so the tool executes rather than being tolerated. `tool_choice` is
narrower than `tools` — the dated spellings
(`web_search_preview_2025_03_11`, `web_search_2025_08_26`) work inside `tools`
but return `400 Missing required parameter: 'tool_choice.tools'` when forced
via `tool_choice`. The `/v1/messages` boundary is unaffected and still returns
`The use of the web search tool is not supported.` for `claude-opus-5` and
`claude-sonnet-5`. Full results and method: [research/responses-web-search.md](research/responses-web-search.md).

### Prompt caching

As of April 30, 2026, prompt caching via `cache_control: { type: "ephemeral" }` is supported across all tested models on both `/v1/messages` and `/responses` paths. One notable exception:

- `claude-opus-4.7-xhigh` has a higher minimum cache threshold (~8K tokens vs the standard ~4K for other Opus models). The `cache_control` field is accepted without error, but caching only activates when the cacheable content exceeds approximately 8192 tokens.

**2026-07-25 update:** `claude-opus-5` cache-hits at every probed size down to ~1024 tokens — a lower threshold than the ~8192 measured on `claude-opus-4.6` in June.

Run `bun scripts/probes/cache-threshold.ts --model=<id>` to probe a specific model's cache threshold.

Run `bun scripts/probes/tool-support.ts --json` to get a current snapshot. Weekly diffs detect backend changes. Latest results: [research/builtin-tool-support.md](research/builtin-tool-support.md).

## Streaming Guarantees

The Responses streaming translator is stateful and emits Anthropic stream events with protocol-level error frames when translation fails. Current guarantees:

- `response.id` is stabilized across lifecycle events on the native `/v1/responses` passthrough boundary
- child events that carry `item_id` are normalized structurally by `output_index` instead of relying on a fixed event-name whitelist
- malformed upstream JSON becomes an Anthropic `error` event instead of a broken TCP stream
- completed function-call blocks are not reopened
- excessive whitespace-only function-call argument streams are rejected with an Anthropic `error` event
- unfinished streams emit a terminal Anthropic `error` event instead of silently ending

For the current `/v1/responses` stream identity contract, see [responses-stream-compatibility.md](responses-stream-compatibility.md).

## Small-Model Routing

Compact routing only applies to `POST /v1/messages`, and it is disabled by default.

The reroute is allowed only when all of the following are true:

- `smallModel` is configured
- the target model exists in Copilot's model list
- the target model preserves the original model's declared endpoint support
- tool, thinking, or vision requests are not rerouted to a model that lacks the required capabilities

Additional trigger rules:

- `compactUseSmallModel`: matches the known Claude Code / OpenCode compact summarization system prompt
