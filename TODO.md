# TODO

Known gaps that are real but deliberately not fixed yet, with enough background
to pick them up cold. Each entry states why it was left, not just what is left.

---

## 1. `/v1/responses` passthrough applies no effort clamping

**Status:** open. Defensible as-is — this is a consistency question, not a bug.

### What

Every other path clamps `reasoning.effort` to what the resolved model advertises
in `capabilities.supports.reasoning_effort`:

- native `/v1/messages` → `sanitizeOutputConfig` → `normalizeOutputConfigEffort`
- Anthropic → Responses → `resolveResponsesReasoningEffort` → `clampResponsesEffort`
- chat-completions fallback → `resolveRequestEffort` in the CAPI profiles

The `/v1/responses` passthrough route does not. A client sending
`reasoning: { effort: 'max' }` to a model that does not advertise `max` gets the
upstream 400 rather than a clamped-and-served request.

### Why it was left

The argument for leaving it is real: on this route the client named both the
model and the effort level explicitly, in the upstream's own vocabulary. The
proxy is a passthrough here, and silently rewriting a value the caller chose
deliberately is arguably worse than surfacing upstream's answer. The
`/v1/messages` paths clamp because they are *translating* — the caller expressed
intent in Anthropic terms and the proxy picks the OpenAI-side representation, so
choosing a valid level is part of the translation.

The argument against is consistency: the same client-visible outcome (a 400 the
proxy could have avoided) depends on which route was used.

### What would settle it

A decision about whether `/v1/responses` is a passthrough or a managed boundary.
If passthrough, document the asymmetry in
`docs/messages-routing-and-translation.md` so the inconsistency is intentional
rather than accidental. If managed, apply `clampEffortToAdvertised` in
`afterTransform` (`src/routes/responses/handler.ts`) alongside the existing
`applyResponsesParameterFilters` and `clampResponsesOutputTokens`.

---

## 2. The native `/v1/messages` `max_tokens` ceiling is not clamped

**Status:** open. This one is a real leak, same shape as the bug that started
the reasoning-effort work.

### What

Probed 2026-07-26 (`scripts/probes/effort-and-tokens.ts`, results in
`docs/research/sampling-parameters.md`): the two boundaries treat the output-token
ceiling differently.

| Boundary | Ceiling | Behavior |
|---|---|---|
| `/responses` (`max_output_tokens`) | advisory | `limits.max_output_tokens + 1` was accepted by all 9 models |
| `/v1/messages` (`max_tokens`) | **hard** | `max_tokens: 64001 > 64000, which is the maximum allowed number of output tokens for claude` |

The proxy clamps only the `/responses` **floor** (`clampResponsesOutputTokens`,
raising below-16 values to Copilot's minimum of 16). The native `/v1/messages`
ceiling is forwarded as sent, so a client asking for more than the model's
`capabilities.limits.max_output_tokens` receives an upstream 400 the proxy had
every input needed to prevent — the limit is in the cached model record.

### Why it was left

Scope. It surfaced while probing effort levels, and PR #67 was already carrying
five distinct fixes; adding a sixth unrelated one would have made it harder to
review and harder to revert. It is recorded in
`docs/research/sampling-parameters.md` under both "Bounds" and "Not covered" so
the evidence does not go stale in someone's head.

### Why it matters

This is the same failure shape as the bug that opened this whole thread: a
client-visible 400 the proxy could have absorbed, on a value the proxy already
knows the correct bound for. See
`docs/solutions/conventions/duplicated-semantic-rules-diverge-silently.md` —
clamping is a rule that already exists in this codebase, and the ceiling is one
more place it is not applied.

### What to do

Clamp `max_tokens` down to `model.capabilities.limits.max_output_tokens` on the
native path, mirroring how the floor is handled on `/responses`. Two cautions:

1. **Clamping down is not obviously right.** Silently reducing a caller's
   `max_tokens` changes how much output they get. That is less severe than a
   400, but it is still a semantic change — decide deliberately and document it
   as a translation policy, the same way the `temperature`/`top_p` conflict
   resolution was.
2. **Probe before generalizing.** The 64000 ceiling was observed on one Claude
   model. Whether every model enforces its advertised ceiling, and whether the
   advertised value is always the real one, is not established — the
   `/responses` side already proved the advertised ceiling can be advisory
   rather than enforced.
