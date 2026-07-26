# Prompt caching (probed)

Which caching controls Copilot accepts, per model, and what its `usage` reports.

**Probe:** `scripts/probes/prompt-caching.ts` — re-run when models change.
**Date:** 2026-07-26. **Method:** ~2.5k-token prefix, unique per model *and*
per variant per run, sent twice: call 1 cold (can write), call 2 warm (can
read). A fixed prefix is served from a previous run's cache and never shows a
write — that mistake cost one full probe cycle.

## The dividing line is gpt-5.6

| Field | gpt-5.3-codex · 5.4-mini · 5.4 · 5.5 | **gpt-5.6-luna · sol · terra** |
| --- | --- | --- |
| `prompt_cache_key` | accepted | accepted |
| `prompt_cache_retention` (legacy) | accepted | accepted |
| `prompt_cache_options` | **400** | accepted |
| `prompt_cache_breakpoint` | **400** | accepted |
| `usage.cache_write_tokens > 0` | **never** | on every cold call |

```
prompt_cache_options is not supported on this model
prompt_cache_breakpoint is not supported on this model
```

Note the wording — *"not supported on this model"*, not "unknown field".
Copilot recognizes both parameters and gates them per model.

## `cache_write_tokens` is the load-bearing difference

Cold vs warm, same request shape:

| Model | cold | warm |
| --- | --- | --- |
| `gpt-5.5` | `cached=0 write=0` | `cached=1792 write=0` |
| `gpt-5.6-terra` | `cached=0 **write=2246**` | `cached=2244 write=0` |

Both expose `cache_write_tokens` in `input_tokens_details`, but only gpt-5.6
ever reports a non-zero value. That makes cache writes **observable and
billable** on 5.6 in a way they were not before.

`write ≈ input_tokens - 3`: what gets cached is the prefix, minus the few
tokens of the varying user message.

## `explicit` mode does what the docs say

On gpt-5.6:

| Variant | cold | warm |
| --- | --- | --- |
| `mode: implicit` | `write=2246` | `cached=2244` |
| `mode: explicit`, no breakpoint | `write=0` | `cached=0` |
| `mode: explicit` + breakpoint | `write=2241` | `cached=2239` |

Explicit mode caches **only** what the caller marks. Requesting it without a
breakpoint disables caching entirely.

## `ttl` accepts exactly one value

```
Invalid value: '1h'. Supported values are: '30m'.
```

Returned by **every** model, including those that reject
`prompt_cache_options` outright — so `ttl` is validated before the
supported-on-this-model check.

## `prompt_cache_key` matters more on older models

| Model | baseline warm | with `prompt_cache_key` warm |
| --- | --- | --- |
| `gpt-5.5` | `cached=0` | `cached=1792` |
| `gpt-5.6-terra` | `cached=2244` | `cached=2244` |

On gpt-5.5, implicit caching did **not** engage without a key. gpt-5.6 hit the
cache either way. This runs opposite to the usual framing that newer models
are the ones that need the key.

Cache-hit granularity differs too: gpt-5.5's `cached` values are multiples of
256; gpt-5.6's are not, suggesting finer-grained prefix matching.

## This is unrelated to the Claude caching path

Two independent mechanisms, easily conflated:

| | `copilot_cache_control` | `prompt_cache_*` |
| --- | --- | --- |
| Lineage | Anthropic | OpenAI |
| Boundary | CAPI (`/chat/completions`) | Responses |
| Shape | `{type:'ephemeral'}` on messages/tools | request-level options + per-content-block breakpoints |
| Set by | the proxy (`plan-builder.ts`, 3 checkpoints) | the caller |

## Resulting proxy behavior

- `prompt_cache_options` and `prompt_cache_breakpoint` are modelled explicitly
  and forwarded. `ttl` is constrained to `30m`, and an unknown `mode` is
  rejected locally rather than costing an upstream round-trip.
- `usage.cache_write_tokens` maps to Anthropic
  `cache_creation_input_tokens` on the Responses→Anthropic path, so clients
  see cache-write cost. A zero write is **omitted**, not reported as `0` —
  reporting `0` would imply a write happened and was free.
- The proxy does **not** translate between the two caching mechanisms. An
  Anthropic caller's `cache_control` does not become a breakpoint, and vice
  versa; the semantics differ enough that a mapping would need its own design.

## Not covered

- Whether Copilot honours `prompt_cache_retention: '24h'` — accepted on every
  model, but retention beyond the probe window was not measured.
- The documented 4-writes-per-request ceiling and the 50-breakpoint read
  window. Only single-breakpoint requests were probed.
- Streaming requests. All probes were non-streaming.
