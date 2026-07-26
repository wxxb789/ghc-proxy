# TODO

Known gaps that are real but deliberately not fixed yet, with enough background
to pick them up cold. Each entry states why it was left, not just what is left.

---

## 1. `/v1/responses` passthrough applies no effort clamping

**Status:** DONE. Resolved as a managed boundary — see below for why that came
out differently than the entry originally guessed.

### What

Every other path clamps `reasoning.effort` to what the resolved model advertises
in `capabilities.supports.reasoning_effort`:

- native `/v1/messages` → `sanitizeOutputConfig` → `normalizeOutputConfigEffort`
- Anthropic → Responses → `resolveResponsesReasoningEffort` → `clampResponsesEffort`
- chat-completions fallback → `resolveRequestEffort` in the CAPI profiles

The `/v1/responses` route did not. A client sending
`reasoning: { effort: 'max' }` to a model that does not advertise `max` got the
upstream 400 rather than a clamped-and-served request.

### How it was resolved

The entry framed this as passthrough-vs-managed and said a decision was needed.
Reading `afterTransform` settled it: the route was **already** a managed
boundary. `applyResponsesParameterFilters` strips `temperature`/`top_p` for
reasoning models, and `clampResponsesOutputTokens` raises a below-minimum
`max_output_tokens`. Effort was not an intact passthrough — it was the one
parameter where the proxy knew the request would 400 and forwarded it anyway.

`clampResponsesReasoningEffort` (`src/transform/parameter-filter.ts`) now runs
alongside them. `none` and `minimal` pass through unranked, matching the
Anthropic-to-Responses path: they are Responses-only levels rather than rungs on
the ladder, and clamping `none` upward would invert the caller's intent.

The lesson worth keeping is about the framing, not the fix: "is this route a
passthrough?" was answerable from the code, not a matter of taste. The question
had been left open on an assumption about the route's character that one file
read disproved.

---

## 2. The native `/v1/messages` `max_tokens` ceiling is not clamped

**Status:** DONE. Fixed on the branch that opened this entry — kept here for the
background, since the reasoning about *why* clamping down is not obviously right
outlives the fix.

### What

Probed 2026-07-26 (`scripts/probes/effort-and-tokens.ts`, results in
`docs/research/sampling-parameters.md`): the two boundaries treat the output-token
ceiling differently.

| Boundary | Ceiling | Behavior |
|---|---|---|
| `/responses` (`max_output_tokens`) | advisory | `limits.max_output_tokens + 1` was accepted by all 9 models |
| `/v1/messages` (`max_tokens`) | **hard** | `max_tokens: 64001 > 64000, which is the maximum allowed number of output tokens for claude` |

The proxy clamped only the `/responses` **floor**
(`clampResponsesOutputTokens`, raising below-16 values to Copilot's minimum of
16). The native `/v1/messages` ceiling was forwarded as sent, so a client asking
for more than the model's `capabilities.limits.max_output_tokens` received an
upstream 400 the proxy had every input needed to prevent — the limit is in the
cached model record.

### How it was resolved

`clampMessagesOutputTokens` (`src/transform/parameter-filter.ts`) lowers an
over-ceiling `max_tokens` to the advertised value, wired into the native path in
`src/routes/messages/strategy-registry.ts` alongside the other sanitizers.

Two decisions worth keeping:

1. **It warns rather than logging at debug level.** Unlike the `/responses`
   floor — where raising 0..15 to 16 costs the caller nothing — lowering
   `max_tokens` is a real semantic change: the caller receives less output than
   they asked for. That deserves a visible line, not a debug one.
2. **No advertised ceiling means no clamp.** An unknown bound is not a reason to
   guess one, so a model record without `limits.max_output_tokens` forwards the
   request untouched.

Still not established: whether every model enforces its advertised ceiling. The
`/responses` side already proved an advertised ceiling can be advisory rather
than enforced, so this is a per-boundary fact, not a general one.
