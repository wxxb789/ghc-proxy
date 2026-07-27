---
title: Claude Code Messages startup payload compatibility
date: 2026-06-02
last_updated: 2026-07-27
category: integration-issues
module: Anthropic Messages routing
problem_type: integration_issue
component: tooling
symptoms:
  - "Initial /v1/messages?beta=true startup requests returned upstream 400 errors before later requests succeeded"
  - "Copilot native /v1/messages rejected anthropic-beta: mid-conversation-system-*"
  - "Vertex org policy rejected structured_outputs for claude-opus-4-7 when output_config.format reached Copilot native Messages"
  - "Structured output_config.format could be silently dropped while forwarding an unconstrained request"
root_cause: missing_validation
resolution_type: code_fix
severity: high
related_components:
  - "assistant"
  - "development_workflow"
tags:
  - "anthropic-messages"
  - "claude-code"
  - "structured-outputs"
  - "responses-routing"
  - "beta-headers"
  - "github-copilot"
---

# Claude Code Messages startup payload compatibility

> **Read this first (2026-07-27).** Two of this doc's conclusions were later
> overturned, and both reversals are annotated inline below:
>
> - The **routing rule** — divert every `output_config.format` payload away from
>   native Messages — was over-generalized from one model's Vertex organization
>   policy. Native serves structured output on most models. See the superseded
>   note in Solution, and
>   `docs/solutions/conventions/policy-rejection-is-not-a-protocol-limit.md` for
>   why the mistake happened.
> - The **`output_config` container** was `.strict()`; it is now `.loose()`.
>
> Everything else here still holds, and the part this doc got most right — never
> strip a caller's schema guarantee to fit an upstream shape — is what the
> replacement routing preserves.


## Problem

Newer Claude Code startup probes send Anthropic Messages payloads that exercise recently added Anthropic features before the main steady-state request path. ghc-proxy originally accepted those requests at the public Anthropic boundary but forwarded unsupported details too directly to Copilot native `/v1/messages`, causing the first startup requests to fail upstream and, in one case, risking a successful response that no longer honored the caller's structured-output contract.

## Symptoms

- Startup logs showed upstream `400 Bad Request` for `POST /v1/messages?beta=true`, followed by later successful requests.
- Vertex rejected `structured_outputs` for `claude-opus-4-7` when `output_config.format` reached Copilot native Messages.
- Copilot native Messages rejected `anthropic-beta: mid-conversation-system-2026-04-07` as an unexpected beta header.
- Review feedback later confirmed that simply stripping `output_config.format` would silently convert a schema-constrained request into an unconstrained request.

## What Didn't Work

- Passing Anthropic beta headers through unchanged did not work because Copilot native Messages does not accept every beta value that the official Anthropic API or SDK can send.
- Stripping `output_config.format` on the native path avoided the Vertex policy error, but it changed request semantics. A client using JSON Schema structured output could receive ordinary text output while believing schema constraints were still enforced.
- Letting the request fall back to Chat Completions would have the same semantic-loss problem because that path does not represent Anthropic `output_config.format`.
- Session history search found no relevant prior sessions for this specific structured-output routing problem.

## Solution

Handle the startup payloads at the proxy boundary instead of letting unsupported fields leak to Copilot native Messages.

Accept mid-conversation system messages in the Anthropic schema and translators:

```ts
const anthropicSystemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.union([
    z.string(),
    z.array(anthropicTextBlockSchema),
  ]),
}).loose()
```

Strip only the Copilot-unsupported beta values before upstream forwarding, preserving unrelated beta values:

```ts
const COPILOT_UNSUPPORTED_BETA_RE = /^mid-conversation-system-\d{4}-\d{2}-\d{2}$/

if (COPILOT_UNSUPPORTED_BETA_RE.test(value)) {
  continue
}
```

Model structured output explicitly at ingress instead of letting it pass through a loose `output_config` object:

```ts
const anthropicOutputFormatSchema = z.object({
  type: z.literal('json_schema'),
  schema: jsonObjectSchema,
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  strict: z.boolean().optional(),
}).strict()

const anthropicOutputConfigSchema = z.object({
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
  format: anthropicOutputFormatSchema.optional(),
}).loose()
```

> **Amended 2026-07-27.** The container was `.strict()` as originally written and
> is now `.loose()`. It was the only strict container on this boundary, so every
> field Anthropic added arrived as a local 400 before the request could reach a
> model that might accept it. `format` keeps its own `.strict()` — an
> unrecognized key *inside* it still means a constraint the proxy cannot carry.

Make Messages strategy selection payload-aware. Native Messages still wins for ordinary native-compatible payloads, but payloads with `output_config.format` need the Responses translator so the schema is preserved:

```ts
const nativeMessagesEntry: StrategyEntry<StrategyContext> = {
  name: 'native-messages',
  canHandle: (model, ctx) => modelCache.supportsEndpoint(model, MESSAGES_ENDPOINT)
    && !hasOutputConfigFormat(ctx?.anthropicPayload),
  // ...
}
```

> **Superseded 2026-07-27.** The blanket exclusion above was wrong, and this doc
> is the record of how it got that way. The Vertex rejection that motivated it
> was an *organization-policy* constraint on `claude-opus-4-7`
> (`constraints/vertexai.allowedPartnerModelFeatures`), not a limit of Anthropic
> Messages — but it was generalized into a permanent rule for every model.
> Probing native Messages directly for the first time
> (`scripts/probes/messages/output-format.ts`, results in
> `docs/research/structured-output-native.md`) found 6 of 8 models serve a bare
> `{ type, schema }`. `claude-opus-5` and `claude-sonnet-5` have no `/responses`
> endpoint, so the rule left their structured-output requests with no path at
> all — a local 400. Native now handles them when the model advertises
> `structured_outputs`; `strict` requests still route away, since dropping that
> key would silently discard a caller guarantee, which is the failure this doc
> got right.

Translate Anthropic JSON Schema output config to Responses `text.format`:

```ts
function resolveResponsesTextConfig(
  payload: AnthropicMessagesPayload,
): ResponsesPayload['text'] | undefined {
  const format = payload.output_config?.format
  if (!format) {
    return undefined
  }

  switch (format.type) {
    case 'json_schema':
      return {
        format: {
          type: 'json_schema',
          name: format.name ?? 'anthropic_output',
          schema: format.schema,
          ...(format.description !== undefined ? { description: format.description } : {}),
          ...(format.strict !== undefined ? { strict: format.strict } : {}),
        },
      }
  }
}
```

If a structured-output request reaches the Chat Completions fallback because the selected model has no `/responses` endpoint, reject it explicitly instead of silently dropping the schema:

```ts
if (hasOutputConfigFormat(ctx.anthropicPayload)) {
  throwInvalidRequestError(
    'Anthropic output_config.format requires a model with Responses endpoint support.',
    'output_config.format',
    'unsupported_output_config_format',
  )
}
```

## Why This Works

The public Anthropic boundary and the Copilot upstream boundary have different compatibility contracts. Claude Code can send newer Anthropic payload features before Copilot native Messages supports the same beta header or provider feature. Treating ghc-proxy as a translation boundary means each field must either be preserved, intentionally translated, or rejected before it reaches an incompatible upstream endpoint.

The final routing policy keeps the useful native path for ordinary Messages traffic, but diverts structured-output requests to the only current path that can preserve schema intent. When that path is unavailable, the local `400` is more correct than an upstream Vertex policy error or a successful unconstrained request.

> **Superseded 2026-07-27.** "The only current path" was the error. Native
> Messages had never been tested with `output_config.format` — the probe that
> existed only ever sent `effort` — so "only" was an assumption, not a finding.
> The reasoning that survives is the ranking: a local 400 beats a silently
> unconstrained response. What changed is that most models need neither, because
> native serves the schema directly.

The generated Responses schema name is also intentional. Anthropic's raw `output_config.format` example only requires `type: json_schema` and `schema`, while Responses `text.format.json_schema` requires `name`. Supplying a stable default name lets valid Anthropic structured-output requests map to valid Responses payloads without asking the caller for a Responses-specific field.

## Prevention

- Treat every newly accepted Anthropic field as a translation-policy decision: preserve it exactly, translate it losslessly, mark it lossy, or reject it explicitly.
  - *This rule was later violated by its own author.* It was applied to
    `output_config.format` here and missed for `output_config.effort` — the
    other field on the same object, at the same fallback — which was dropped
    with no issue recorded until 2026-07-27. Applying a rule to the field an
    incident named is not the same as applying it to the rule's own scope. See
    `docs/solutions/conventions/duplicated-semantic-rules-diverge-silently.md`.
- Do not solve upstream incompatibility by deleting caller-visible semantic fields unless the field is documented as intentionally lossy.
- Make strategy selection depend on payload semantics when endpoint support alone is not enough to preserve the request contract.
  - *Necessary but not sufficient.* A payload-shaped predicate has no natural
    bound over models, so it silently enrolls every model that ships later. Pair
    it with a capability check or a dated, explicit model list.
- Keep tests for both halves of a fallback decision: one test proving a supported strategy preserves the field, and one test proving unsupported strategies return local `400` before upstream dispatch.
  - *Those tests passed throughout.* They proved the proxy implemented the rule
    faithfully, which it did. No test can tell you the rule described someone's
    GCP project rather than the protocol — only re-probing upstream can.
- Keep beta-header filters narrow. Strip only known Copilot-incompatible beta values so unrelated beta behavior can continue to work.

## Related Issues

- `gh issue list --search "output_config structured output responses messages" --state all --limit 5` found no related GitHub issues.

## Related

- `docs/solutions/conventions/policy-rejection-is-not-a-protocol-limit.md` — the
  learning extracted from this doc's own mistake. The Vertex rejection recorded
  here was real and correctly observed; it was attributed to the wrong layer and
  then generalized. That doc is the rule for reading which layer an upstream
  error names before turning it into architecture.
- `docs/solutions/conventions/duplicated-semantic-rules-diverge-silently.md` —
  why this doc's first prevention rule was later violated for a sibling field on
  the same object.
- `docs/solutions/conventions/upstream-types-are-not-contract-evidence.md` — the
  same failure surface from the other direction. Here an inbound Anthropic field
  was under-modelled and nearly dropped silently; there an outbound field was
  wrongly declared unsupported because it was missing from a hand-written type.
  Both resolve to modelling the field explicitly at the boundary.
