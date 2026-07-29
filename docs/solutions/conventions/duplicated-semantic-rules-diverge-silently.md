---
title: "A semantic rule implemented twice diverges silently"
date: 2026-07-27
last_updated: 2026-07-29
category: conventions
module: reasoning effort across ingest/transform/translator
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Adding a value to a shared enum or constant such as `REASONING_EFFORT_VALUES` in `src/types/copilot.ts`"
  - "Writing or editing a Zod schema at an ingress boundary that restates a value set already defined under `src/types/`"
  - "Fixing a clamp, default, or mapping that exists on more than one execution strategy"
  - "A client reports a local 400 or a silently dropped field on one route only"
  - "Reviewing a fix whose diff touches exactly the one path named in the bug report"
related_components:
  - "ingest validation"
  - "transform sanitize"
  - "translator responses"
  - "translator anthropic"
tags:
  - "single-source-of-truth"
  - "reasoning-effort"
  - "duplicated-enum"
  - "execution-strategy"
  - "fix-boundary"
  - "silent-divergence"
---

# A semantic rule implemented twice diverges silently

## Context

ghc-proxy translates Anthropic- and OpenAI-shaped requests onto GitHub Copilot's
API. Reasoning effort is one field with one rule behind it:

> A request may only carry an effort level the target model advertises in
> `capabilities.supports.reasoning_effort`.

That rule has to hold across three ingress schemas and three execution
strategies. In one session it was found violated four times, in four files,
all inside that one subsystem. Each violation was a *second implementation* of
the rule that had drifted from the first — and in three of the four the full
test suite was green while the proxy returned 400s or silently downgraded the
caller's request.

The trigger was a user-reported failure on `gpt-5.6-sol`:

```
WARN Invalid request payload { context: 'openai.responses',
  issues: [{ path: 'reasoning.effort',
    message: 'Invalid option: expected one of "none"|"minimal"|"low"|"medium"|"high"|"xhigh"' }] }
<- POST /v1/responses 400 3ms model=gpt-5.6-sol
```

`max` shipped in PR #63. The `/responses` ingress schema had hand-written its
own copy of the effort list and was never extended, so the proxy rejected `max`
locally — before the request could reach a model that accepts it upstream.
PR #66 fixed it by importing the shared constant. Auditing outward from that one
line turned up three more divergences of the same shape.

## Guidance

**When you fix a rule violation, grep for every implementation of the rule and
fix all of them. Then collapse them into one, so the next divergence cannot
happen.**

This sharpens rather than contradicts the `AGENTS.md` scope-discipline rule
("Fix only the issue the change targets"). The issue is the *rule*, not the
route that happened to surface it — a diff that repairs one of three
implementations has not finished the targeted issue, it has relocated it.

### 1. One constant, imported — never a second hand-written copy

The shared list lives at `src/types/copilot.ts:85`:

```ts
export const REASONING_EFFORT_VALUES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
```

Both ingress schemas now derive from it rather than restating it
(`src/ingest/validation/openai-chat.ts:115`,
`src/ingest/validation/responses.ts:248`):

```ts
const responsesReasoningConfigSchema = z.object({
  effort: z.enum(REASONING_EFFORT_VALUES).nullable().optional(),
})
```

A hand-written enum in a validator is a copy of a contract that lives elsewhere.
It is correct the day it is written and wrong the day the contract moves —
silently, because nothing links the two.

### 2. One function for the rule, called from every path

The clamp now has exactly one implementation, `clampEffortToAdvertised`
(`src/transform/sanitize.ts`), and both boundaries reach it: the native
`/v1/messages` path through `normalizeOutputConfigEffort`, and the Anthropic →
Responses path through `clampResponsesEffort`.

Where the boundaries genuinely differ, the difference is explicit and narrow
rather than a second implementation. The Responses vocabulary includes `none`
and `minimal`, which are not on the Anthropic `output_config` ladder, so they
pass through instead of being ranked — clamping `none` *up* to a model's highest
advertised level would invert the caller's intent. That is a two-line divergence
with a stated reason, not a fork.

### 3. Clamp at the exit, not per branch

`resolveResponsesReasoningEffort` has four branches that can each produce an
effort. Rather than remembering to clamp in each, candidate selection and
clamping are separate and the clamp sits on the single exit:

```ts
const candidate = resolveEffortCandidate(payload, options)
if (!candidate) {
  return candidate
}
return clampResponsesEffort(candidate, options)
```

A fifth branch added to `resolveEffortCandidate` is clamped by construction.
Nobody has to know the rule exists to comply with it.

### 4. Before recording a field as unsupported, check whether it is merely unread

A field that disappears is not automatically an unsupported field. On the Chat
Completions Fallback, `output_config.effort` was dropped because
`normalizeAnthropicRequest` never read it — but `src/core/capi/plan-builder.ts`
already serialized `reasoning_effort` onto that boundary, so Copilot accepted the
field all along. Recording an `unsupported_*` translation-policy issue would have
codified a limitation that did not exist. The fix was to read the field and carry
it through.

### The diagnostic move

When a bug report names one path, run the grep before writing the fix. If more
than one call site *implements* the rule rather than *calling* it, the reported
path is a sample, not the scope.

*A clean grep closes this question and no other.* In PR #69 the timeout rule had
exactly one implementation after consolidation and was still wrong on Node,
because the grep bounds how many places implement the rule and says nothing about
how many input shapes the one place must accept. See
`docs/solutions/testing/green-suite-is-evidence-about-one-runtime.md`.

## Why This Matters

**The tests do not catch it.** This is what makes a duplicated semantic rule
dangerous rather than merely untidy. Tests are written against implementations.
Two implementations get two test suites, each asserting its own behavior, and
both pass while the two disagree. The existing suite covered
`normalizeOutputConfigEffort` thoroughly — including the `max`/`xhigh` ordering
case — and said nothing about the degraded second clamp in the Responses
translator. A green suite is not evidence of consistency; it is evidence that
each copy matches itself.

**The failure surfaces at the client, not in CI.** The effort divergences
produced a local 400 for a request the upstream would have accepted, a second
class of 400 on any model advertising `[high, xhigh, max]`, and a silent
downgrade from `max` to `low`. All client-visible, none test-visible.

**Fixing only the reported path leaves the siblings broken and the diff looks
complete.** The `/responses` enum fix in PR #66 was correct and self-contained.
It would also have been the whole change, if nobody had gone looking for the
rest of the rule.

**Silent drops are worse than 400s.** A 400 is a bug report; a caller who asks
for `max` and quietly receives `low` gets a worse answer and no signal that
anything happened.

**Local rejections were invisible in logs, which is what let this accumulate.**
`HTTPError` carries its own `toResponse()`, and `onError` in `src/server.ts`
returns early for it, so a request rejected at the proxy boundary produced no log
line of its own — indistinguishable from one that reached upstream and
succeeded. When your own rejections leave no trace, divergence has no feedback
signal and compounds. `throwInvalidRequestError` and `fromTranslationFailure`
(`src/lib/error.ts`) now each warn on the way out: one line at the shared throat,
not at every call site — the same structural move as the clamp fix.

## When to Apply

- You are about to hand-write a value list — an enum, an allowlist, a set of
  levels — that also exists somewhere else in the repo. Import it.
- You are fixing a validation or normalization bug and the rule involved is
  named in more than one file. Grep before editing.
- A function has several branches that each produce a value the same
  post-condition must hold for. Put the post-condition on the exit.
- A field reaches the proxy and does not reach upstream. Determine whether it is
  *rejected* upstream or merely *unread* here — they call for opposite fixes.
- You are reviewing a fix that touches exactly the file named in the bug report.
  Ask what else implements the same rule.

It does **not** apply to superficially similar code encoding genuinely different
rules. Two functions clamping two different fields against two different
capability lists should stay separate. The test: would a change in the domain
rule have to be applied to both? If yes they are one rule; if no they are two.

## Examples

### A hand-written enum drifts (PR #66, merged)

Before, in `src/ingest/validation/responses.ts`:

```ts
const responsesReasoningConfigSchema = z.object({
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).nullable().optional(),
})
```

`/chat/completions` validated against `REASONING_EFFORT_VALUES` and accepted
`max`. `/responses` had its own copy and rejected it. After, the same line reads
`z.enum(REASONING_EFFORT_VALUES)`, and the regression tests iterate the shared
constant — so extending the list extends the tests.

### Two clamps, one correct and one degraded (PR #67, open)

Before, in `src/translator/responses/anthropic-to-responses.ts`:

```ts
if (effort === 'max' && !options?.supportedEfforts?.includes('max')) {
  return 'xhigh'
}
return effort
```

Three defects, all consequences of it being a second implementation: it handled
only `max`; it clamped to a hardcoded `xhigh` without checking the model
advertises `xhigh`; and it never clamped `xhigh` itself. The other clamp already
knew better — the levels are not a ladder every model implements a prefix of.
`claude-opus-4.6` and `claude-sonnet-4.6` advertise `max` but *not* `xhigh`, and
reject `xhigh` while accepting `max` (probed 2026-07-26,
`scripts/probes/effort-and-tokens.ts`). So `max → xhigh` was a downgrade *onto a
level the model rejects*.

### Three of four branches unclamped (PR #67, open)

Fixing the clamp fixed one branch. An audit of the whole chain found the
enclosing function had four, and only the branch where the user's error appeared
was clamped: `thinking: adaptive` returned a hardcoded `'medium'`,
`thinking: enabled` pushed a configured default through an `as` cast — which
suppressed the one signal the type system could have given — and
`thinking: disabled` returned `'none'` unchecked.

### A silent drop rather than a 400 (PR #67, open)

`normalizeAnthropicRequest` built its IR without reading `output_config.effort`,
so on the Chat Completions Fallback a caller asking for `max` reached upstream
with whatever the thinking-budget heuristic produced — `high` at most, `low` for
a small budget. Nothing in the response, nothing in the logs. The fix reads the
field, carries it on the IR and the conversation request, and prefers it over the
inferred value in both CAPI profiles.

## Related

- `docs/solutions/integration-issues/claude-code-messages-startup-payloads.md` —
  the precedent this learning was extracted from, and its own counterexample.
  That doc's prevention rule ("treat every newly accepted Anthropic field as a
  translation-policy decision: preserve, translate, mark lossy, or reject
  explicitly") was applied to `output_config.format` and missed for
  `output_config.effort` — the other field on the same object, at the same
  fallback, roughly two months later. The rule was right; its scope was set by
  the field the incident named.
- `docs/solutions/conventions/upstream-types-are-not-contract-evidence.md` — the
  sibling convention on the orthogonal axis. There the belief under scrutiny is
  about an *external* system and a probe settles it; here the belief is about our
  own code and a grep settles it. PR #67 needed both: a probe established what
  the correct clamp target is, a grep established how many places computed it.
- `docs/solutions/testing/regression-test-must-fail-first.md` — why the green
  suite was not evidence. A regression test for this class asserts the same input
  through every execution strategy, not through the one that broke.
- `docs/solutions/testing/green-suite-is-evidence-about-one-runtime.md` — where
  this doc's diagnostic runs out. There the rule had one implementation, the grep
  was clean, and the rule was still wrong because Bun and Node hand the same
  predicate different error shapes and CI only runs Bun. Implementation count is
  this doc's axis; input-space count is that one's.
