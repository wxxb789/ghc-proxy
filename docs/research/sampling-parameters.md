# Sampling parameter support (probed)

Which of `temperature` / `top_p` / `top_k` Copilot actually accepts, per
upstream boundary and per model.

**Probe:** `scripts/probes/sampling-params.ts` — re-run it when models change.
**Date:** 2026-07-26. **Method:** minimal non-streaming request per variant,
sent directly to the upstream endpoint (no proxy in the path).

## Summary

| Boundary | `temperature` | `top_p` | `top_k` | Constraint |
| --- | --- | --- | --- | --- |
| `/v1/messages` | accepted | accepted | **accepted** | non-reasoning Claude reject the **pair** `temperature`+`top_p` |
| `/chat/completions` | accepted | accepted | **accepted** | — |
| `/responses` | **rejected** | rejected (except codex) | **accepted** | reasoning-only model set |

`top_k` was accepted by **every model that could be reached** — 8 on
`/v1/messages`, 12 on `/chat/completions`, 9 on `/responses`. The two remaining
`/chat/completions` models failed their *baseline* request for unrelated reasons
(see that section below), so no `top_k` verdict exists for them either way.

## What this corrected

Three long-standing assumptions turned out to be wrong:

1. **`top_k` was treated as unsupported everywhere.** It was dropped on the
   chat-completions fallback (`unsupported_top_k`) and rejected with a hard 400
   on the Responses path. Both behaviors dated to the original translator
   (#5/#6) and had never been probed. `top_k` is also absent from the upstream
   payload types in `src/types/` — which only ever proved that the proxy had
   not modelled it.

2. **The reasoning-model filter was over-broad.** `parameter-filter` stripped
   `temperature` *and* `top_p` for every reasoning model on the Responses
   boundary. `gpt-5.3-codex` accepts `top_p`.

3. **`temperature`/`top_p` mutual exclusion was not modelled at all.** It is a
   real upstream 400 that clients hit by sending both, which they do routinely.

## Per-model results

### `/v1/messages` — 8 models

All 8 accepted `temperature`, `top_p`, and `top_k` individually.

Two **non-reasoning** models reject the pair:

```
claude-sonnet-4.5   temperature+top_p -> 400
claude-haiku-4.5    temperature+top_p -> 400

  `temperature` and `top_p` cannot both be specified for this model.
  Please use only one.
```

All six reasoning models (`claude-opus-4.6/4.7/4.8/5`, `claude-sonnet-4.6/5`)
accepted every combination including all three at once.

### `/chat/completions` — 14 models

`temperature`, `top_p`, `top_k` all accepted, in every combination, by the 12
reachable models (claude ×8, gemini ×3, `gpt-5-mini`).

Two models failed for reasons unrelated to sampling — **both fail on the
baseline request**, so no sampling conclusion can be drawn for them:

| Model | Error |
| --- | --- |
| `gpt-5.4` | `Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.` |
| `trajectory-compaction` | `The requested model is not supported.` |

### `/responses` — 9 models

Every model here advertises `reasoning_effort`. All 9 accepted `top_k`.

| Model | `temperature` | `top_p` |
| --- | --- | --- |
| `gpt-5.3-codex` | rejected | **accepted** |
| `gpt-5.4-mini` | rejected | rejected |
| `gpt-5.4` | rejected | rejected |
| `gpt-5.5` | rejected | rejected |
| `gpt-5.6-luna` | rejected | rejected |
| `gpt-5.6-sol` | rejected | rejected |
| `gpt-5.6-terra` | rejected | rejected |
| `mai-code-1-flash-picker` | rejected | rejected |
| `gpt-5-mini` | rejected | rejected |

```
Unsupported parameter: 'temperature' is not supported with this model.
Unsupported parameter: 'top_p' is not supported with this model.
```

## Why the codex exemption is a glob list

`capabilities.supports` is **byte-identical** across `gpt-5.3-codex`,
`gpt-5.4` and `gpt-5.4-mini`:

```json
{
  "parallel_tool_calls": true,
  "reasoning_effort": ["low", "medium", "high", "xhigh"],
  "streaming": true,
  "structured_outputs": true,
  "tool_calls": true,
  "vision": true
}
```

Copilot advertises no per-parameter support information, so the exemption
cannot be derived from the model record. `REASONING_PARAM_EXEMPTIONS` in
`src/transform/parameter-filter.ts` carries it as an evidence-backed glob
instead — the same trade-off `MODELS_REJECTING_OUTPUT_CONFIG` already makes in
`src/state/model-cache.ts`.

## Resulting proxy behavior

| Path | `temperature` | `top_p` | `top_k` |
| --- | --- | --- | --- |
| Native `/v1/messages` | forwarded | dropped when `temperature` is also set | forwarded |
| Chat Completions fallback | forwarded | forwarded | forwarded as a Copilot extension |
| Responses | stripped for reasoning models | stripped for reasoning models except codex | forwarded as a Copilot extension |

`top_k` reaches upstream as a non-standard field on both
`CapiChatCompletionsPayload` and `ResponsesPayload`. It is only ever populated
from an Anthropic caller's `top_k` — the OpenAI- and Responses-facing request
schemas do not accept it, so the proxy boundary stays faithful to the protocols
it advertises.

## Not covered

- `service_tier` — still rejected with 400 on the Responses path. Not probed.
- Streaming requests. All probes were non-streaming.
- Whether `top_k` measurably changes output. Probes assert acceptance, not
  effect.

---

## Reasoning effort and output-token parameters (probed)

**Probe:** `scripts/probes/effort-and-tokens.ts`. **Date:** 2026-07-26.

### Reasoning effort

**The advertised list is authoritative.** For every model on every boundary,
`capabilities.supports.reasoning_effort` matched actual behavior exactly — a
model accepts precisely the levels it advertises and returns 400 for the rest.
Clamp against that list rather than a static union.

#### `max`

| Boundary | Accepts `max` | Rejects `max` |
| --- | --- | --- |
| `/v1/messages` | all 6 reasoning Claude models | — |
| `/chat/completions` | all 6 reasoning Claude models | gemini ×3 |
| `/responses` | **gpt-5.6-luna / sol / terra** | gpt-5.3-codex, 5.4, 5.4-mini, 5.5, gpt-5-mini, mai-code-1 |

```
Invalid value: 'max'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', ...
```

`claude-opus-4.6` and `claude-sonnet-4.6` are instructive: they advertise
`max` but **not** `xhigh`, and reject `xhigh` while accepting `max`. The levels
are not a simple ordered ladder every model implements a prefix of.

Before this was probed, the Responses translator downgraded `max` to `xhigh`
unconditionally — correct for every model that existed at the time, and a
silent capability loss once gpt-5.6 shipped.

### Output-token parameters

| Boundary | Parameter | Notes |
| --- | --- | --- |
| `/v1/messages` | `max_tokens` | **required**; `max_completion_tokens` yields `max_tokens: Field required` |
| `/chat/completions` | both accepted | except `gpt-5.4`, which rejects `max_tokens` |
| `/responses` | `max_output_tokens` | floor of **16**, enforced |

```
Unsupported parameter: 'max_tokens' is not supported with this model.
Use 'max_completion_tokens' instead.

Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16
```

#### The two spellings are not synonyms

On gemini models both are accepted but behave differently: `max_tokens=16`
returned `finish_reason: length` (truncated), while `max_completion_tokens=16`
returned `stop`. For reasoning models `max_tokens` counts thinking tokens
against the budget; `max_completion_tokens` bounds visible output only.

#### Bounds

The floor is enforced; the **ceiling is not**. Passing
`limits.max_output_tokens + 1` was accepted by all 9 `/responses` models, so
the advertised ceiling is advisory. Only the floor is clamped by the proxy.

### Resulting proxy behavior

- `max` is preserved when the resolved model advertises it, and clamped to
  `xhigh` otherwise (`AnthropicToResponsesOptions.supportedEfforts`).
- `max_tokens` is renamed to `max_completion_tokens` on `/chat/completions`
  for models that reject it; extend the list via
  `chatCompletionsUseMaxCompletionTokens`.
- `max_output_tokens` below 16 is raised to 16 rather than leaking a 400. The
  client-facing schema still accepts 0..15, since those are valid OpenAI input.

### Not covered

- Whether `max` measurably changes output quality. Probes assert acceptance.
- `prompt_cache_breakpoint` / `prompt_cache_options` (GPT-5.6 explicit prompt
  caching). Not probed against Copilot yet.
