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

**The advertised list is authoritative for rejection.** Re-probed 2026-07-26
after opus-5 / sonnet-5 / gpt-5.6 shipped: on every boundary a model rejects
every level it does not advertise. Clamp against that list rather than a static
union.

The converse does **not** hold. `gpt-5.3-codex` accepts `none` on `/responses`
while advertising `["low","medium","high","xhigh"]` — the one case where real
behavior is *wider* than the advertised list. That asymmetry is harmless for
clamping (clamping to an advertised level never produces a rejected value) but
it means the list is a floor on capability, not an exact description.

#### Per-model results

| Model | `/v1/messages` | `/chat/completions` | `/responses` | Advertised |
| --- | --- | --- | --- | --- |
| `claude-opus-5` | ✅ incl. `xhigh`+`max` | ✅ incl. `xhigh`+`max` | — | `low,medium,high,xhigh,max` |
| `claude-sonnet-5` | ✅ incl. `xhigh`+`max` | ✅ incl. `xhigh`+`max` | — | `low,medium,high,xhigh,max` |
| `claude-opus-4.8` / `4.7` | ✅ incl. `xhigh`+`max` | ✅ incl. `xhigh`+`max` | — | `low,medium,high,xhigh,max` |
| `claude-opus-4.6` | `max` ✅ / `xhigh` ❌ | `max` ✅ / `xhigh` ❌ | — | `low,medium,high,max` |
| `claude-sonnet-4.6` | `max` ✅ / `xhigh` ❌ | `max` ✅ / `xhigh` ❌ | — | `low,medium,high,max` |
| `gpt-5.6-luna` / `sol` / `terra` | — | — | ✅ incl. `max` | `none,low,medium,high,xhigh,max` |
| `gpt-5.5` / `5.4` / `5.4-mini` | — | — | `max` ❌ | `none,low,medium,high,xhigh` |
| `gpt-5.3-codex` | — | — | `max` ❌, `none` ✅ (unadvertised) | `low,medium,high,xhigh` |
| gemini ×3 | — | `max` ❌ | — | up to `high` |

`none` and `minimal` are rejected by every Claude model on both Claude-facing
boundaries — they exist only in the OpenAI vocabulary.

```
output_config.effort "xhigh" is not supported by model claude-opus-4.6;
supported values: [low medium high max]

Invalid value: 'max'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', ...
```

`claude-opus-4.6` and `claude-sonnet-4.6` are the load-bearing counterexample:
they advertise `max` but **not** `xhigh`, and behave that way. The levels are
not an ordered ladder every model implements a prefix of, so a clamp target must
be derived from the advertised list — a fixed fallback is wrong in both
directions, downgrading models that would have accepted the request and still
able to land on a level the model rejects.

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

On `/responses` the floor is enforced and the **ceiling is not**: passing
`limits.max_output_tokens + 1` was accepted by all 9 models, so the advertised
ceiling is advisory there.

`/v1/messages` is the opposite — its ceiling is hard:

```
max_tokens: 64001 > 64000, which is the maximum allowed number of output tokens for claude
```

The proxy clamps only the `/responses` floor today; the native `/v1/messages`
ceiling is still forwarded as sent and surfaces upstream as a 400.

### Resulting proxy behavior

- Effort is clamped to the model's **highest advertised level**
  (`clampEffortToAdvertised`, shared by the native and Responses paths). With no
  advertised list the effort passes through unchanged — with nothing to derive
  from, forwarding the caller's request beats guessing at a level that may be
  both a downgrade and still unsupported.
- `max_tokens` is renamed to `max_completion_tokens` on `/chat/completions`
  for models that reject it; extend the list via
  `chatCompletionsUseMaxCompletionTokens`.
- `max_output_tokens` below 16 is raised to 16 rather than leaking a 400. The
  client-facing schema still accepts 0..15, since those are valid OpenAI input.

### Not covered

- Whether `max` measurably changes output quality. Probes assert acceptance.
- The native `/v1/messages` `max_tokens` ceiling is not clamped (see Bounds).
- Whether other models also accept unadvertised levels the way `gpt-5.3-codex`
  accepts `none`. Only the advertised set plus `none`/`minimal` were probed.
