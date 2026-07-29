---
title: "An upstream rejection names a layer — read it before you generalize"
date: 2026-07-27
last_updated: 2026-07-29
category: conventions
module: upstream capability modeling
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Turning an observed upstream 400 into a routing rule, allowlist, or capability guard"
  - "Reading an upstream error that mentions a policy, project, quota, region, or deployment"
  - "Reviewing a capability rule whose only evidence is one model on one date"
  - "An exclusion rule written for one model silently starts covering models that shipped later"
  - "Choosing between an account-scoped workaround and a permanent architectural rule"
related_components:
  - "messages routing"
  - "transform sanitize"
  - "model cache"
  - "ingest validation"
tags:
  - "upstream-contract"
  - "error-attribution"
  - "policy-vs-protocol"
  - "structured-outputs"
  - "messages-routing"
  - "capability-detection"
  - "probe-before-assume"
---

# An upstream rejection names a layer — read it before you generalize

## Context

ghc-proxy already has two learnings about beliefs that turn out to be wrong.
This is a third mode among four, and it is worth naming precisely because the
others do not cover it:

- `docs/solutions/conventions/upstream-types-are-not-contract-evidence.md` — the
  belief was **never verified**. `top_k` was declared unsupported because it was
  absent from a hand-written payload type. Nobody had ever sent it.
- `docs/solutions/conventions/duplicated-semantic-rules-diverge-silently.md` —
  the belief was **implemented twice** and the copies drifted. The rule was
  right; two of its three implementations were stale.
- `docs/solutions/testing/green-suite-is-evidence-about-one-runtime.md` — the
  belief was **tested on one of two runtimes**. It was verified, correctly
  attributed, and implemented exactly once; the suite that confirmed it runs
  only on Bun, and the code ships on Node too.
- **This one:** the observation was real, reproducible, and correctly recorded.
  It was **attributed to the wrong layer** — an operational policy read as a
  protocol limit — and then generalized to every model and every future model.

The distinction matters because the usual defence does not fire. "Did you
verify it?" gets a yes. There *was* a probe, of a sort: a live upstream request
that returned a live upstream 400, with the error text pasted into the doc.
What nobody asked was **what the error was a statement about**.

### The timeline

**2026-06-02.** Claude Code startup payloads carrying `output_config.format`
reached Copilot's native `/v1/messages` and Vertex refused `structured_outputs`
for `claude-opus-4-7`. Recorded honestly in
`docs/solutions/integration-issues/claude-code-messages-startup-payloads.md`,
symptom line 11. That doc got the hard part right — it explicitly rejected the
tempting fix of stripping `format`, on the grounds that a schema-constrained
request must not silently come back unconstrained (lines 39, 44). It then drew
the routing conclusion: send **every** Messages payload carrying
`output_config.format` to the Responses translator, and reject outright when the
model has no `/responses` endpoint.

**~8 weeks later.** A user reports:

```
WARN  Rejected request { param: 'output_config.format',
  code: 'unsupported_output_config_format',
  message: 'Anthropic output_config.format requires a model with Responses endpoint support.' }
<- POST /v1/messages?beta=true 400 2ms model=claude-opus-5
```

`2ms`. The request never left the proxy. `claude-opus-5` shipped long after the
rule was written, has no `/responses` endpoint, and so fell through
`responsesApiEntry` (`src/routes/messages/strategy-registry.ts:73`) into the
chat-completions guard that throws
(`src/routes/messages/strategy-registry.ts:118-124`). A rule about one model's
Vertex deployment had grown to cover a model that did not exist when it was
written, and left that model's structured-output requests with no path at all.

The user's own reaction was the tell: *"it shows `/v1/messages?beta=true` should
call `/v1/messages` of github copilot directly why you said 落到
chat-completions"*. They were reading the routing rule as absurd on its face,
which it was — for their model.

**Probed for the first time.** `scripts/probes/messages/output-format.ts` is new
in this change. The pre-existing `scripts/probes/messages/output-config.ts` had
only ever sent `effort` variants (its probe list, lines 32-34, is
`effort=high` / `effort=null` / `adaptive + output_config`) — so `format` on
native Messages had never been tested against upstream at all in the 8 weeks the
rule stood. Results in `docs/research/structured-output-native.md`: **6 of 8
Messages models return 200** for a bare `{ type, schema }`, including
`claude-opus-5` and `claude-sonnet-5`.

The 2 failures say:

```
Organization Policy constraint constraints/vertexai.allowedPartnerModelFeatures
violated for projects/<id> attempting to use a disallowed feature
structured_outputs for Partner model claude-opus-4-7
```

Read what that sentence is about. `Organization Policy constraint`. A named GCP
`projects/<id>`. `allowedPartnerModelFeatures`. That is somebody's Google Cloud
configuration — account-scoped, mutable, possibly different for the next
subscriber. It is not the Anthropic Messages contract, and it never said
anything about `claude-opus-5`.

## Guidance

**When upstream rejects something, the error text names a layer. Read which
layer before you generalize the rejection into a rule.**

Two categories, opposite handling:

| Error is about | Examples | Scope of the workaround |
| --- | --- | --- |
| **Policy / quota / deployment / entitlement** | org policy constraint, region unavailable, plan tier, rate limit, "disallowed feature for project X" | Narrow to the affected models. Re-check on a schedule. Someone else can change it without telling you. |
| **Protocol / schema** | `Extra inputs are not permitted`, `Field required`, `not supported by model <id>; supported values: [...]`, type errors | About the contract itself. Safe to generalize to the boundary. |

The second category is a fact about the API. The first is a fact about an
account on a given day. Encoding the first as if it were the second freezes
another party's configuration into your architecture — and unlike a normal stale
constant, it **expands on its own** as new models arrive that were never tested
against it.

### 1. Scope a policy-shaped rejection to the models it names

A policy error names a model and a project. It licenses an exclusion for that
model, nothing wider. The proxy already had the right shape for this in
`MODELS_REJECTING_OUTPUT_CONFIG` (`src/state/model-cache.ts:16-19`) — an
explicit ID set with the probe name, the probe date, and an instruction to
re-run when models change:

```ts
/**
 * Models whose upstream `/v1/messages` endpoint rejects the `output_config`
 * field with "Extra inputs are not permitted".
 *
 * Verified via `scripts/probes/messages/output-config.ts` (2026-03-14); the
 * probe enumerates the live `/models` surface, so this list only ever covers
 * models that existed on the probe date. ...
 * When new models appear, re-run the probe and update this list.
 */
```

Note what that comment does that a routing rule cannot: it *bounds itself in
time*. A `canHandle` predicate that excludes a whole class of payload has no
such bound, and reviewing it does not surface one.

### 2. Route on the advertised capability, not on observed behavior

The pending fix keys native structured output on the model record
(`src/state/model-cache.ts`):

```ts
class ModelCache {
  supportsStructuredOutputs(model: Model | undefined): boolean {
    if (!model || MODELS_BLOCKING_NATIVE_STRUCTURED_OUTPUT.has(model.id)) {
      return false
    }
    return model.capabilities.supports.structured_outputs ?? false
  }
}
```

The probe found two models — `claude-sonnet-4.5` and `claude-haiku-4.5` — that
**accept** `format` while advertising `structured_outputs: false`. That
observation is deliberately *not* exploited
(`docs/research/structured-output-native.md:87-91`). The advertised list is a
floor on capability, so routing on it stays safe; routing on observed behavior
would bind the proxy to an undocumented quirk that upstream never promised. This
is the same asymmetry `docs/research/sampling-parameters.md:150-154` records for
`gpt-5.3-codex` accepting an unadvertised `none`.

That is the mirror image of the mistake this doc is about, and it is worth
holding both at once: **an observed rejection under-constrains the rule, and an
observed acceptance over-constrains it.** One observation is a data point about
one model on one account on one day, in either direction.

### 3. Separate what is droppable from what is a caller guarantee

The narrowed rule still has to decide what to do with the fields native rejects.
The pending change splits the two questions — one pure predicate for selection,
one mutator for execution (`src/transform/sanitize.ts:103-108` and `126-140`):

```ts
export function canReduceOutputFormatForNativeMessages(
  payload: AnthropicMessagesPayload | undefined,
): boolean {
  const format = payload?.output_config?.format
  return !format || format.strict === undefined
}
```

`name` and `description` are labels — stripping them costs the caller nothing,
so the reducer drops them (`src/transform/sanitize.ts:134-139`). `strict` is
not: it is a promise about the reply. Requests carrying it keep their old
routing rather than being served natively with the guarantee quietly removed.
That is exactly the principle the 2026-06-02 doc established and got right
(`claude-code-messages-startup-payloads.md:44`); this change narrows the routing
rule without weakening it.

### 4. Verify the narrowed path end to end — the old rule may be hiding a bug

Narrowing an exclusion sends traffic down a path that has never carried it. That
path can have its own latent defect the exclusion was masking.
`sanitizeOutputConfig` did (`src/transform/sanitize.ts:211-222`): on a null
effort it deleted the whole `output_config` container. A structured-output
request typically sends no effort at all, so the caller's schema would have
vanished — the exact silent-drop failure the original doc was written to
prevent, reintroduced through the door the fix opened. It now removes only the
effort key when a `format` is present.

## Why This Matters

**A policy-derived rule expands by itself.** This is the property that makes it
worse than an ordinary stale constant. `MODELS_REJECTING_OUTPUT_CONFIG` is a
fixed set — a new model is simply absent from it and gets the default. The
Messages routing rule was written as *"any payload with `output_config.format`"*,
so every model Copilot shipped after 2026-06-02 was silently enrolled into a
restriction derived from `claude-opus-4-7`'s Vertex deployment. Nobody made that
decision. The rule made it.

**The blast radius is set by an accident of the model surface.** Routing
structured output away from native was survivable while the affected models had
`/responses` — the request still had somewhere to go, at translation cost.
`claude-opus-5` and `claude-sonnet-5` shipped without `/responses`, which turned
"suboptimal routing" into "no path at all". The severity of a
wrongly-generalized rule is not fixed at the time you write it; it is set later,
by facts you do not control.

**A local 400 produces no upstream signal to investigate.** The request was
rejected at the proxy boundary in 2ms. There is no upstream error, no failed
call, nothing in a Copilot-side log. This class of bug surfaces only when a user
reports it, which here took roughly 8 weeks — and it took the user's disbelief
(*"why … 落到 chat-completions"*) to reframe it as a routing question rather
than an unsupported-feature question. `duplicated-semantic-rules-diverge-silently.md`
makes the same point about local rejections being invisible; the visibility fix
landed in PR #67 (merged).

**Tests confirm the rule, not the world.** The 2026-06-02 doc's own prevention
list asked for a test proving unsupported strategies return a local 400 before
dispatch (`claude-code-messages-startup-payloads.md:174`). That test existed and
passed. It asserted the proxy implemented the rule faithfully, which it did. No
test can tell you the rule was about someone's GCP project — only re-probing
upstream can.

**The correct fix was cheap once the layer was read.** A predicate change in
`canHandle` (`src/routes/messages/strategy-registry.ts:45-48`), one capability
accessor, and a reducer. The expensive part was the eight weeks of nobody
re-reading a sentence that had `Organization Policy constraint` in it.

## When to Apply

- **You are about to write a rule from an upstream error.** Read the error text
  first and classify it. If it names a project, org, policy, plan, region, or
  quota, it is account-scoped — scope the rule to the models it names and date
  the evidence.
- **You are reviewing a capability rule whose evidence is one model on one
  date.** Ask whether the rule's *scope* matches the evidence's scope. A rule
  phrased over a payload shape ("any request with field X") generalizes further
  than a rule phrased over model IDs, and it keeps generalizing.
- **New upstream models have shipped since a rule was written.** Any rule
  expressed as a payload predicate now covers them. Re-probe rather than assume
  the family behaves like its predecessor.
- **You are narrowing an existing exclusion.** Trace the newly-opened path end to
  end before shipping. Code downstream of an exclusion has never run with that
  traffic.
- **A rejection and an acceptance disagree with the advertised capability.**
  Prefer the advertised list in both directions: do not exploit an unadvertised
  acceptance, and do not let a policy-shaped rejection override an advertised
  capability for models it never named.

It does **not** apply to protocol errors. `Extra inputs are not permitted`,
`Field required`, and `not supported by model <id>; supported values: [...]` are
statements about the contract, and generalizing them to the boundary is correct
— that is precisely why `reduceOutputFormatForNativeMessages` strips `name` and
`description` unconditionally rather than per model.

## Examples

### The rule, before and after (PR #68, open — changes below are pending)

Before, in `src/routes/messages/strategy-registry.ts` — payload-shaped, and so
unbounded over models:

```ts
const nativeMessagesEntry = {
  canHandle: (model, ctx) => modelCache.supportsEndpoint(model, MESSAGES_ENDPOINT)
    && !hasOutputConfigFormat(ctx?.anthropicPayload),
}
```

After, at the current tree (`src/routes/messages/strategy-registry.ts:45-48`),
with the evidence and its date attached in the comment above it (lines 39-44):

```ts
const nativeMessagesEntry = {
  canHandle: (model, ctx) => modelCache.supportsEndpoint(model, MESSAGES_ENDPOINT)
    && (!hasOutputConfigFormat(ctx?.anthropicPayload)
      || (modelCache.supportsStructuredOutputs(model)
        && canReduceOutputFormatForNativeMessages(ctx?.anthropicPayload))),
}
```

Both clauses of the new condition earn their place: the capability check gates
on the model record, and the reducibility check keeps `strict` requests off a
path that cannot carry them.

The capability check needed one more piece than it first appeared. Writing this
learning up surfaced the gap: `claude-opus-4.7` and `claude-sonnet-4.6`
advertise `structured_outputs: true` and are blocked only by the org policy, so
the advertised flag alone would have routed them straight onto a path that 400s
upstream. `supportsStructuredOutputs` now excludes them explicitly
(`src/state/model-cache.ts:37-40`, backed by
`MODELS_BLOCKING_NATIVE_STRUCTURED_OUTPUT` at `:22-35`) — a bounded, dated ID
list, which is what §1 above prescribes for a policy-shaped rejection.

That gap is itself the doc's thesis applied one level up: the fix narrowed a
rule correctly but still leaned on an advertised capability to encode a
constraint the advertisement knows nothing about. A policy exclusion has to be
written down as a policy exclusion.

Note the ordering constraint in `execute`:
`reduceOutputFormatForNativeMessages` runs *after* `sanitizeOutputConfig`
(`src/routes/messages/strategy-registry.ts:52-53`), which is why the container
must survive the null-effort branch.

### The silent drop the narrowing exposed

Before, in `src/transform/sanitize.ts` — correct for every request that could
reach this code under the old rule, since `format` requests never got here:

```ts
const effort = payload.output_config.effort
if (effort == null) {
  delete payload.output_config
}
```

After (`src/transform/sanitize.ts:211-222`):

```ts
const effort = payload.output_config.effort
if (effort == null) {
  // A null effort is a no-op, but the object may still carry `format` — the
  // usual shape of a structured-output request, which sends no effort at all.
  // Deleting the container here would drop the caller's schema silently.
  if (payload.output_config.format) {
    delete payload.output_config.effort
    return
  }
  delete payload.output_config
}
```

The regression test for this sends `output_config: { effort: null, format: {...} }`
and asserts the format reaches upstream while the effort key does not
(`tests/messages-routing.test.ts`, "keeps output_config.format when no effort is
set").

### The two paths need opposite shapes

Worth recording because it is counterintuitive and it is what makes the routing
decision load-bearing rather than cosmetic. Native Messages rejects
`format.name` as an extra input; Responses `text.format.json_schema` **requires**
`name`, so the translator injects a default one
(`claude-code-messages-startup-payloads.md:123-147`,
`docs/research/structured-output-native.md:54-66`). The same caller request has
to be reshaped in opposite directions depending on which strategy serves it —
which is exactly the kind of asymmetry that gets lost when one path is
unconditionally preferred and the other never exercised.

### The evidence, dated and bounded

`docs/research/structured-output-native.md:96-101` closes with what was not
established, including:

> Whether the Vertex policy blocking `claude-opus-4.7` and `claude-sonnet-4.6`
> is account-specific. It names a specific GCP project, so another Copilot
> account may see different results — re-run the probe rather than assuming
> these two models are permanently excluded.

That paragraph is the whole learning applied to itself. The current exclusion of
those two models is *also* a policy-derived rule; it is written down as one, with
a re-check instruction, instead of hardening into another permanent capability
claim.

### The ingress schema drifted the same way

Adjacent evidence that "one incident, generalized" is a recurring shape here, not
a one-off. The 2026-06-02 change also made `anthropicOutputConfigSchema`
`.strict()`. It was the only strict container on the Anthropic Messages boundary,
so every field Anthropic subsequently added arrived as a local 400 before it
could reach a model that might accept it. At the current tree the container is
`.loose()` and only `format` keeps `.strict()`
(`src/ingest/validation/anthropic-messages.ts:207-226`) — an unrecognized key
*inside* `format` still means a constraint the proxy cannot carry, which is a
genuine protocol-level judgement. The original doc carries an amendment note
recording the change (`claude-code-messages-startup-payloads.md:91-95`).

## Related

- `docs/solutions/integration-issues/claude-code-messages-startup-payloads.md` —
  the incident this learning is extracted from. Its routing conclusion is
  annotated as superseded (lines 108-121); its semantic-preservation principle
  stands and is reused by the fix.
- `docs/solutions/conventions/upstream-types-are-not-contract-evidence.md` — the
  belief that was never verified. Its remedy (probe before asserting) is
  necessary here but not sufficient: a probe *was* run in 2026-06-02, and the
  result was misread. Add: probe, then read what the result is a statement about.
- `docs/solutions/conventions/duplicated-semantic-rules-diverge-silently.md` —
  the belief implemented twice. Its diagnostic is a grep; this one's is a second
  reading of an error string. Both share the finding that a green test suite
  confirms only that the code matches the rule, never that the rule matches
  reality.
- `docs/research/structured-output-native.md` — the full probe results, per model
  and per variant, with an explicit not-covered list.
- `scripts/probes/messages/output-format.ts` — the probe. Note it exists
  alongside `output-config.ts`, which covers the same object's `effort` key only;
  when a probe covers part of a field, say which part.
- PR #66 and PR #67 (both merged) — the reasoning-effort divergences.
  PR #68 (open) — the change described here.
