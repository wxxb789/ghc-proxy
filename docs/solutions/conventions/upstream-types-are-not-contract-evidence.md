---
title: "Hand-written upstream types are not evidence of the upstream contract"
date: 2026-07-26
last_updated: 2026-08-25
category: conventions
module: upstream capability modeling
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Marking a request parameter unsupported, lossy, or strippable in a translator or validator"
  - "Inferring Copilot capability from field presence in `src/core/capi/types.ts` or `src/types/responses.ts`"
  - "Adding or extending a model or parameter allowlist in `src/transform/parameter-filter.ts`"
  - "Reviewing a change justified by \"the upstream does not support this\""
  - "Choosing between shipping an assumption and writing a probe under `scripts/probes/`"
tags:
  - upstream-contract
  - copilot-api
  - reverse-engineered-api
  - probe-before-assume
  - parameter-filter
  - translation-policy
  - capability-detection
---

# Hand-written upstream types are not evidence of the upstream contract

## Context

ghc-proxy is a reverse-engineered proxy. GitHub Copilot publishes no request
schema, so every upstream payload type in this repo — `CapiChatCompletionsPayload`
(`src/core/capi/types.ts`), `ResponsesPayload` (`src/types/responses.ts`),
`REASONING_EFFORT_VALUES` (`src/types/copilot.ts`) — was written by hand from
observation. They record what someone once modelled, nothing more.

That distinction gets lost quickly. A field missing from one of these types
reads, to the next person, exactly like a field the upstream rejects. It is not.
The absence only proves *we never modelled it*.

`top_k` is the clean case. From the original translator work (#5, #6) until
PR #62, the proxy treated it as unsupported on both non-native paths — the chat
fallback logged an `unsupported_top_k` issue and dropped the value, and the
Responses path threw `TranslationFailure(..., { status: 400 })`.
`docs/anthropic-translation-matrix.md` recorded it as `Unsupported`, which made
the judgement look researched. The only support for any of it was that `top_k`
did not appear in the hand-written payload types.

A probe (`scripts/probes/sampling-params.ts`) settled it in one run: `top_k` was
accepted by every model that could be reached — 8 on `/v1/messages`, 12 on
`/chat/completions`, 9 on `/responses`. The two `/chat/completions` models that
did not return 200 failed on their baseline request for unrelated reasons
(`gpt-5.4` requires `max_completion_tokens`; `trajectory-compaction` reports
itself unsupported), so they carry no `top_k` verdict either way. Four months of
a client-visible 400 and a silent drop, resting on nothing.

## Guidance

**Before declaring an upstream field unsupported, probe it. Before trusting an
existing "unsupported" verdict, find the probe that established it — and if
there isn't one, treat the verdict as unverified.**

### 1. Never infer upstream capability from a type in this repo

`src/core/capi/types.ts`, `src/types/responses.ts`, and `src/types/copilot.ts`
are our model of Copilot, not Copilot's contract. Absence means unmodelled.
Presence means someone observed it once, possibly before the model set changed.

### 2. Probe combinations, not just fields

A parameter can be accepted alone and rejected in company. The sampling probe
tests each of `temperature` / `top_p` / `top_k` alone, then the pairs, then all
three — because single-field probes would have missed the real constraint:
non-reasoning Claude models on `/v1/messages` reject the **pair**
`temperature`+`top_p`:

```
`temperature` and `top_p` cannot both be specified for this model.
Please use only one.
```

The proxy had never modelled this at all. It now drops `top_p` and keeps
`temperature` on that boundary (`sanitizeExclusiveSamplingParams`,
`src/transform/sanitize.ts`).

### 3. Record the probe next to the code it justifies

Every constant encoding an upstream fact carries the probe name and date in its
doc comment: `REASONING_PARAM_EXEMPTIONS` (`src/transform/parameter-filter.ts`),
`RESPONSES_MIN_OUTPUT_TOKENS`, `MODELS_REJECTING_OUTPUT_CONFIG`
(`src/state/model-cache.ts`). Full results live in `docs/research/`. The next
reader then gets both things they need: what the evidence was, and how stale it is.

This extends an existing convention — `docs/design/model-routing.md` already
date-stamps its endpoint map with an explicit staleness warning.

### The other half: which model metadata *is* trustworthy

"Always probe" is not "never trust the model record." The same probe run
answered both questions, and they came out differently per dimension:

- **Sampling-parameter support cannot be derived.** `capabilities.supports` is
  byte-identical across `gpt-5.3-codex`, `gpt-5.4`, and `gpt-5.4-mini`, yet
  `gpt-5.3-codex` accepts `top_p` on `/responses` while the others reject it.
  Nothing derivable distinguishes them, so `REASONING_PARAM_EXEMPTIONS` has to
  be an evidence-backed glob list.
- **Ranked `reasoning_effort` normalization is derivable from a safe target
  set.** For the Anthropic ladder (`low` through `max`), the advertised list
  supplies values the proxy can safely emit. If a requested ranked level is not
  advertised, `clampEffortToAdvertised` selects the highest advertised ranked
  value. The list is wired through as `supportedEfforts`; no hardcoded model IDs
  are needed for that normalization. This does not mean the advertised list is
  an exact inventory of everything the model may accept.

**Amended 2026-08-04 — the second bullet has aged.** `grok-4.5` advertises
`["low","medium","high"]` and accepts `minimal` and `xhigh` as well, while
rejecting `none` (which every `/responses` model accepted in the 2026-07-26
run). See `docs/research/grok-4.5-schema.md`. Two consequences, opposite in
severity:

- For the **ranked** levels the advertised list is a **safe floor, not an exact
  set**. Replacing an unsupported ranked request with one of those advertised
  values avoids emitting a value known to be rejected, though the caller may
  lose an unadvertised level the model would have honoured.
- For the **unranked** Responses values, there is no semantics-preserving ranked
  fallback. `clampResponsesReasoningEffort` and the Anthropic-to-Responses path
  pass `none` and `minimal` through instead of using them as clamp targets.
  `none` can mean "do not reason", so changing it upward would invert intent;
  `minimal` is a direct Responses value, not an Anthropic `output_config` rung.
  This is not a universal-support claim: `reasoning.effort: none` still reaches
  `grok-4.5` and can return `400 This model does not support
  'reasoning_effort' value 'none'`, as verified through the proxy.

That amendment is this doc's own thesis turned on itself. "Advertised is exact"
was a probe result, not a law, and it was true of every model that existed on
the day it was measured. A rule extracted from a probe inherits the probe's
expiry date — including the rule that a level is *universally* supported, which
is the same kind of unbounded generalization
`policy-rejection-is-not-a-protocol-limit.md` warns about.

The counterexample that pins the second point down: `claude-opus-4.6` and
`claude-sonnet-4.6` advertise `max` but **not** `xhigh`, and behave that way —
accepting `max`, rejecting `xhigh`. The effort levels are not an ordered ladder
every model implements a prefix of, so "supports `max`, therefore supports
`xhigh`" is wrong twice over.

A probe is what tells you which dimension you are in. Hardcode a list only where
derivation provably fails.

## Why This Matters

**The failure is silent and it compounds.** An incorrect "unsupported" verdict
produces either a 400 the client cannot work around or a dropped field the
client still believes is in force. Neither shows up in the test suite — the
tests encode the same assumption — and neither generates an upstream error to
investigate. `top_k` survived four months and a full `src/` reorganisation (#38)
that moved the code without questioning it.

**Wrong verdicts get laundered into documentation.** The translation matrix
carried `top_k | Unsupported` for the same four months. A reader cannot tell a
probed fact from a copied assumption once both are rows in the same table. The
matrix now links to `docs/research/sampling-parameters.md` rather than restating
the verdict.

**Under-modelling and over-modelling are the same mistake.** `top_k` was assumed
unsupported and was fine everywhere. `parameter-filter` assumed every reasoning
model rejects `top_p` and stripped it for `gpt-5.3-codex`, which accepts it.
Both are a guess about upstream promoted to a rule, and both cost the client a
capability.

**Upstream moves; a snapshot ages into a bug.** The Responses translator mapped
effort `max` down to `xhigh` unconditionally. That was *correct when written* —
nothing accepted `max` — and became a silent capability loss the moment gpt-5.6
shipped. A dated probe reference makes the staleness visible; a bare constant
hides it.

## When to Apply

- Before writing a new `unsupported_*` translation issue, or extending
  `assertResponsesCompatibleRequest`
  (`src/translator/responses/anthropic-to-responses.ts`).
- When a translation-matrix row says `Unsupported` and you cannot find the probe
  behind it.
- When adding a model-ID list or glob that encodes upstream behavior — probe
  first, then cite the probe in the doc comment.
- When Copilot ships new models. The evidence-backed lists are snapshots; re-run
  the relevant probe rather than reasoning about family names.
- When a type in `src/types/` or `src/core/capi/` looks like it defines what
  upstream accepts. It defines what we send.

Not needed for fields whose behavior the client-facing spec fully determines, or
for a constraint upstream states in its own error text.

## Examples

### The `top_k` reversal

Before (both removed by PR #62):

```ts
// src/adapters/anthropic-messages-adapter.ts — chat fallback
if (request.topK !== undefined) {
  context.record({
    kind: 'unsupported_top_k',
    severity: 'warning',
    message: 'Anthropic top_k is not supported by the upstream Copilot CAPI payload and was dropped.',
  }, { fatalInStrict: true })
}

// src/translator/responses/anthropic-to-responses.ts — Responses path
if (payload.top_k !== undefined) {
  throw new TranslationFailure(
    'Anthropic top_k is not supported on the Responses execution path.',
    { status: 400, kind: 'unsupported_top_k' },
  )
}
```

After — forwarded on both paths, with the evidence attached to the type
(`src/core/capi/types.ts`, mirrored in `src/types/responses.ts`):

```ts
// src/core/capi/types.ts
export interface CapiChatCompletionsPayload
  extends Omit<ChatCompletionsPayload, 'messages' | 'tools'> {
  // ...
  /**
   * Not part of the OpenAI chat schema — Copilot accepts it as an extension.
   * Probed 2026-07-26: accepted by every reachable model on both
   * `/chat/completions` and `/v1/messages`
   * (`scripts/probes/sampling-params.ts`). Only populated internally from an
   * Anthropic-to-CAPI translation; public OpenAI Chat ingress rejects a
   * client-supplied `top_k` because it is outside the official boundary.
   */
  top_k?: number | null
}
```

Forwarding happens in `buildCapiExecutionPlan` in
`src/core/capi/plan-builder.ts`.

`ResponsesPayload` carries the same internal Copilot extension for the
Anthropic-to-Responses path. Public OpenAI Responses ingress likewise rejects a
client-supplied `top_k`; upstream acceptance is evidence for internal
translation, not permission to widen either public OpenAI contract.

### Recurrences of the same mistake

| What was assumed | What upstream does | Fixed in |
| --- | --- | --- |
| `top_k` unsupported everywhere | accepted by every reachable model on all three boundaries | PR #62 |
| `temperature`+`top_p` independent | rejected as a **pair** by non-reasoning Claude on `/v1/messages` | PR #62 |
| every reasoning model rejects `top_p` | `gpt-5.3-codex` accepts it | PR #62 |
| efforts are `['minimal','low','medium','high']` | models advertised `max` and `xhigh` long before | PR #63 |
| `xhigh` ranks above `max` | canonical order is `… high < xhigh < max` | PR #37 |

The PR #63 case deserves its own note: `REASONING_EFFORT_VALUES` had neither
`xhigh` nor `max`, while models had been advertising both in their own
`capabilities.supports` payloads. The evidence was already sitting in the model
records the proxy fetches on every startup. Nobody had compared the hand-written
constant against them.

### Probe design: the tested state must be cold

A probe can be wrong in the same way the assumption it replaces was wrong. The
first prompt-caching run produced entirely fabricated data: a fixed prompt prefix
was served from the **previous run's** cache, so no call was ever cold and
`cache_write_tokens` read `0` everywhere — which would have "proven" Copilot
never writes cache.

The fix (`scripts/probes/prompt-caching.ts`) makes the prefix unique per model,
per variant, per run:

```ts
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

function prefixFor(variantLabel: string): string {
  return `You are a helpful assistant. Session ${RUN_ID} variant ${variantLabel}.\n${FILLER}`
}
```

Before trusting a probe result, ask what state the request lands in — cache,
session, conversation — and whether the probe controls it.

### Stating what was *not* probed

`docs/research/sampling-parameters.md` closes with an explicit not-covered list:
`service_tier` (still rejected on `/responses`, never probed), streaming
requests, and whether `top_k` measurably changes output. Accordingly
`service_tier` was left alone — `assertResponsesCompatibleRequest` still throws
`unsupported_service_tier`.

This is the honest version of the same discipline. An unprobed field stays
unprobed and stays labelled as such; it does not get swept into the fix because
it looked similar to the one that was measured.

## Related

- `docs/solutions/testing/regression-test-must-fail-first.md` — the sibling
  learning. Both say a signal that looks like proof is consistent with two
  opposite worlds, and only a deliberate experiment separates them. There the
  experiment is breaking the fix to watch the test fail; here it is a probe
  against the real upstream.
- `docs/research/sampling-parameters.md` — full `top_k` / `temperature` /
  `top_p` and `reasoning_effort` results, per boundary and per model.
- `docs/research/prompt-caching.md` — the cold-prefix methodology note.
- `scripts/probes/` — the probe suite. `sampling-params.ts` is the current
  template for a multi-boundary probe.
- `docs/solutions/conventions/capability-verdicts-are-scoped-to-one-boundary.md`
  — the next step after "probe it": probe the *boundary you enforce on*. A
  `/v1/messages` web-search rejection was enforced in the `/responses` handler,
  where it had never been measured and was false.
- `docs/solutions/integration-issues/claude-code-messages-startup-payloads.md` —
  the same failure surface from the opposite direction: an under-modelled
  *inbound* field rather than an outbound one.
- PR #62 (`top_k`, codex `top_p` exemption, `temperature`/`top_p` conflict),
  PR #63 (`max` effort, `max_tokens` rename, output floor), PR #64 (explicit
  prompt caching).
