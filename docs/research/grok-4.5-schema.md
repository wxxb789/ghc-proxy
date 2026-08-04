# grok-4.5 request schema (probed)

Which `/responses` request fields the one xAI model on Copilot accepts.

**Probe:** one-off, built on `scripts/lib/probe-harness.ts`; reproduction
recipe at the bottom. **Date:** 2026-08-04.
**Method:** a minimal accepted baseline (`model` + `input` +
`max_output_tokens` + `store: false`), one field added per request, retried up
to four times on capacity faults so a 503 is never recorded as a rejection.

`grok-4.5` advertises `/responses` **only** — no `/chat/completions`, no
`/v1/messages`. 500k context, 128k max output, `o200k_base` tokenizer, vision
limited to JPEG and PNG.

## The headline: its advertised effort list is incomplete

The model record says:

```json
{ "reasoning_effort": ["low", "medium", "high"] }
```

What it actually accepts:

| `reasoning.effort` | Result |
| --- | --- |
| `none` | **400** `This model does not support ...` |
| `minimal` | **200 — accepted, not advertised** |
| `low` | 200 |
| `medium` | 200 |
| `high` | 200 |
| `xhigh` | **200 — accepted, not advertised** |
| `max` | **400** `Invalid reasoning effort.` |

This matters beyond grok. `docs/solutions/conventions/upstream-types-are-not-contract-evidence.md`
records that "`reasoning_effort` support **is** derivable" — every model probed
on 2026-07-26 accepted exactly what it advertised. **grok-4.5 breaks that
rule**: it accepts two levels it does not advertise.

For the *ranked* levels the proxy is unaffected. `clampEffortToAdvertised`
clamps down to the advertised list, so a caller asking for `xhigh` gets `high`
— a capability loss, never an upstream 400. The derivation rule is now "the
advertised list is a safe floor", not "the advertised list is exact".

### `reasoning.effort: none` reaches upstream and 400s (open defect)

`none` and `minimal` are **not** clamped — `clampResponsesReasoningEffort`
(`src/transform/parameter-filter.ts`) returns early for both, on the stated
grounds that they are Responses-only levels rather than rungs on the ladder,
and that clamping `none` *upward* would invert the caller's intent. The comment
backing that early return says every `/responses` model advertises `none`
(probed 2026-07-26).

grok-4.5 disproves it. Verified end to end through the proxy on 2026-08-04:

```
POST /v1/responses  {"model":"grok-4.5","reasoning":{"effort":"none"}}
→ 400 This model does not support `reasoning_effort` value `none`.
```

The same request with `effort: max` returns 200 — it clamps to `high` and
succeeds. So the ranked path is healthy and only the unranked bypass leaks.

This is the exact failure the function's own docstring says it exists to
prevent: *"effort was the one parameter where the proxy knew the request would
400 and forwarded it anyway."* It is left unfixed here because it is outside
the change that surfaced it; the fix is not a simple clamp-up, since `none`
means "do not reason" and the nearest advertised level (`low`) is not the same
request. Tracked in [../TODO.md](../TODO.md).

Also note `none` was accepted by every `/responses` model in the 2026-07-26
run. That claim no longer holds for the whole boundary.

## Accepted

| Group | Fields |
| --- | --- |
| sampling | `temperature`, `top_p`, `top_k`, `temperature`+`top_p` together, `frequency_penalty`, `presence_penalty`, `seed` |
| reasoning | `reasoning.effort` (`minimal`…`xhigh`), `reasoning.summary=auto`, `include: ['reasoning.encrypted_content']` |
| structured output | `text.format` `text` / `json_object` / `json_schema` (strict), `text.verbosity` |
| caching | `prompt_cache_key`, `prompt_cache_retention`, `prompt_cache_options` |
| tools | `parallel_tool_calls`, `max_tool_calls`, `tool_choice: 'required'`, function `strict: true` |
| misc | `metadata`, `instructions`, `truncation`, `safety_identifier`, `user`, `stream: true`, `conversation` |

`temperature`+`top_p` together is worth flagging: non-reasoning Claude models on
`/v1/messages` reject that **pair** (`sampling-parameters.md`). grok does not.

`prompt_cache_options` is accepted — the gpt family gates it to 5.6-and-later
(`prompt-caching.md`). Acceptance of the field is not proof that caching
*happens*; no cold/warm measurement was run here.

## Rejected

| Field | Error |
| --- | --- |
| `store: true` | `store is not supported` |
| `previous_response_id` | `previous_response_id is not supported` |
| `background: true` | `background is not supported` |
| `service_tier` | `service_tier is not supported` |
| `reasoning.effort: none` | `This model does not support ...` |
| `reasoning.effort: max` | `Invalid reasoning effort.` |

The `store` / `previous_response_id` rejections match the Zero-Data-Retention
behaviour already documented for the rest of the `/responses` surface, so the
proxy's unconditional `store = false` is correct for this model too.

`conversation` is the odd one out — accepted here, while `previous_response_id`
is rejected. Both are statefulness fields, and a nonexistent conversation id was
accepted rather than 404'd, which suggests the field is parsed and ignored
rather than honoured. Treat as unverified.

## Tools

Covered in [builtin-tool-support.md](builtin-tool-support.md). Summary:
`web_search` is supported and runs; `code_interpreter`, `image_generation`,
`file_search`, `mcp`, `computer_use_preview` and `local_shell` are rejected with
`The requested tool <name> is not supported.`

Six cells — the other three web-search spellings, and both `custom` tools —
returned 503 on four consecutive attempts and are **unmeasured**, not
unsupported.

## Not covered

- Whether accepted fields have any *effect*. `seed`, `frequency_penalty`,
  `presence_penalty`, and `prompt_cache_options` were measured as accepted;
  none was measured as honoured.
- Vision. The model advertises JPEG/PNG support; no image request was sent.
- `tool_choice: { type: 'allowed_tools' }` — 503 on four attempts, unmeasured.
- Streaming beyond the fact that `stream: true` returns 200 and an SSE body.
- Long-context behaviour anywhere near the advertised 500k window.

## Reproducing

```bash
bun run ./src/main.ts start --port 4142
curl -s -X POST http://127.0.0.1:4142/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"grok-4.5",
       "input":[{"type":"message","role":"user","content":"Reply with the single word OK."}],
       "max_output_tokens":32,
       "reasoning":{"effort":"xhigh"},
       "store":false}'
```

Swap the field under test. Retry any 503 several times before recording it —
grok was under sustained capacity pressure during this run, and a single 503
looks exactly like a rejection if you only sample once.

## Related

- [builtin-tool-support.md](builtin-tool-support.md) — the tool surface.
- [sampling-parameters.md](sampling-parameters.md) — the effort-derivation rule
  this model is the first counterexample to.
- [../solutions/conventions/upstream-types-are-not-contract-evidence.md](../solutions/conventions/upstream-types-are-not-contract-evidence.md)
  — "advertised is exact" was itself a probe result, and it has now aged.
