---
title: "A proxy default is a decision made for the caller"
date: 2026-08-06
category: conventions
module: request translation
problem_type: convention
component: api_translation
severity: high
applies_when:
  - "Adding a `?? default` for a request field the client left unset"
  - "Choosing between omitting a key and sending its 'safe' value"
  - "Writing normalization that rewrites a caller's payload to satisfy a mode the proxy selected"
  - "Reviewing a translator that changes a field the client believes is in force"
related_components:
  - "responses routing"
  - "responses translation"
  - "tool schemas"
tags:
  - "proxy-boundary"
  - "translation-policy"
  - "upstream-contract"
  - "responses-api"
  - "tool-schemas"
  - "silent-rewrite"
---

# A proxy default is a decision made for the caller

## Context

This repo's taxonomy of wrong beliefs is now five entries long, and each exists
because the previous entries' defences all came back clean:

- `upstream-types-are-not-contract-evidence.md` — the belief was never verified.
- `duplicated-semantic-rules-diverge-silently.md` — it was implemented twice and
  drifted.
- `policy-rejection-is-not-a-protocol-limit.md` — it was attributed to the wrong
  **layer**.
- `capability-verdicts-are-scoped-to-one-boundary.md` — it was measured on one
  **endpoint** and enforced on another.
- `capability-verdicts-name-a-schema-and-a-mechanism.md` — it was measured with
  the wrong **schema**, **prompt**, or **execution mechanism**.

**This one is not a wrong belief at all.** No verdict was misread here. Nobody
mis-scoped a probe. There was nothing upstream to misunderstand, because the
proxy was not reporting on upstream — it was making a choice on the caller's
behalf and then rewriting their payload to make that choice work.

`/responses` did this:

```ts
// src/routes/responses/handler.ts — before
return {
  ...tool,
  parameters: normalizeFunctionParametersSchemaForCopilot(tool.parameters),
  strict: tool.strict ?? true,
}
```

A caller who sent no `strict` got `strict: true`. Under strict mode upstream
enforces a schema contract ordinary client schemas — MCP servers, plugin
manifests, anything using JSON Schema composition — do not satisfy. So a second
piece of code existed to make the first one survivable:

```ts
// src/translator/responses/function-schema.ts — before
if (node.type === 'object' || isRecord(normalized.properties)) {
  normalized.required = isRecord(normalized.properties)
    ? Object.keys(normalized.properties)
    : []
  normalized.additionalProperties = false
}
```

Every declared property became required. A caller's optional parameter was
silently promoted to mandatory, at every nesting depth, on every request.

The user-visible failure was a 400 naming a key the caller never wrote:

```text
Invalid schema for function 'mcp__CherryHub__invoke': In context=(), 'required'
is required to be supplied and to be an array including every key in properties.
Extra required key 'params' supplied.
```

The caller's schema did not have that `required` array. The proxy added it, then
forced the mode that rejected it.

## Guidance

**A field the client left unset is information. Filling it in is a decision you
are making for them — so make it only when you can say what breaks otherwise.**

### 1. Absence is a value, and often the correct one

The reflex `x ?? someDefault` reads as harmless. It is not, when `x` crosses a
protocol boundary: the client's *not sending* a field is a statement, and the
proxy is entitled to forward that statement unchanged.

Ask which of these you actually have:

- **The client cannot express it.** Anthropic's tool schema has no `strict`
  concept, so on the Anthropic→Responses path there is genuinely nothing to
  forward. Correct answer: send nothing. (The old code sent `strict: false`
  here, which is worse than nothing — see §2.)
- **The client can express it and chose not to.** Then forward the absence.
- **Upstream requires a value and rejects the request without one.** Only here is
  a default load-bearing, and it should carry the probe that shows the rejection.

### 2. A mode toggle is not a boolean with a safe default

`strict` looks like it has two states. It has three — `true`, `false`, and
absent — and upstream runs a *different validator* for each. Probed 2026-08-06
(`scripts/probes/tool-strict.ts`), a schema whose `required` names a key
`properties` does not declare:

```text
strict omitted  → 200
strict: false   → 400  schema must have type 'object' and not have 'oneOf'/'anyOf'/...
strict: true    → 400  Extra required key 'params' supplied.
```

`false` is not "strict off". It is a third code path. Any time you are tempted to
write "send the safe value instead of omitting the key", measure both — they are
not equivalent, and the intuition that one is a subset of the other is what makes
this invisible.

### 3. Normalization that exists to satisfy your own default is a smell

The `required`/`additionalProperties` rewrite had no independent justification.
It existed *because* of the forced `strict: true`. That is the tell: a
translation step whose only reason to exist is another translation step's side
effect. Remove the cause and the second one has nothing to do.

Per `CONCEPTS.md` [[Translation policy]], an incompatibility with upstream is
never resolved by silently altering request semantics. `AGENTS.md` states the
same rule for dropped fields; a silent *change* is the same class and worse,
because the field still arrives and looks intentional.

### 4. Compensating code does not cover the case it was written for

The rewrite could not reach the failure that motivated it. When `required` sits
at a composition root — beside `$ref` or `anyOf`, with no sibling `properties` —
the block never fired:

```text
{ "$ref": "#/$defs/Invoke", "required": ["params"], "$defs": { ... } }
// normalizer: unchanged. strict:true: 400.
```

So the schema that produced the reported error passed straight through the very
code meant to prevent it. Compensating logic tends to handle the shapes its
author had in mind; the payload that breaks is the one they did not.

## Why This Matters

**Both halves were invisible from the client's side.** A caller either saw a 400
citing a `required` key they never wrote, or — worse, silently — lost an optional
parameter, with the model now believing it mandatory. Nothing in the response
said the proxy had edited the schema.

**The blast radius was every client with a real toolset.** MCP servers, plugin
manifests, and anything generated from a typed schema use partial `required`
arrays and open `additionalProperties` as a matter of course. This was not an
edge case; it was the normal shape of a tool schema.

**The tests encoded the rewrite as intent.** Fourteen assertions across four
files asserted the injected `required` arrays and `additionalProperties: false`,
and two tests were *named* after the behavior (`adds additionalProperties false
and derives required…`). A test written from the same assumption cannot detect
the assumption — it locks it in and makes it look deliberate to the next reader.
The same trap as `capability-verdicts-are-scoped-to-one-boundary.md`, where two
passing tests asserted a 400 that should never have existed.

**Removing a default exposes what it hid.** A caller who explicitly sends
`strict: true` with a partial `required` array now receives upstream's 400 where
they previously got a 200 — measured on three models. That is the honest
outcome: they opted into strict and upstream enforces strict. But it is a real
behavior change, and it is disclosed rather than discovered.

## When to Apply

- **Writing `?? default` on any field that crosses the proxy boundary.** Name
  what breaks without it. If the answer is "nothing, it just seemed safer",
  forward the absence.
- **Choosing between omitting a key and sending a neutral value.** Measure both.
  They are different requests.
- **Reviewing normalization that reshapes a caller's payload.** Ask what forced
  it. If the answer is another line in the same codebase, fix that line instead.
- **Reading a 400 that names a field the client swears they did not send.**
  Check whether the proxy wrote it.

Not needed when upstream genuinely rejects the request without a value — that is
a real constraint, and it should carry its probe and date.

## Examples

### After

```ts
// src/routes/responses/handler.ts — `strict` destructured out of the spread so
// a caller-sent `null` is dropped rather than carried through.
const { strict, ...rest } = tool
return {
  ...rest,
  parameters: normalizeFunctionParametersSchemaForCopilot(tool.parameters),
  ...(strict != null ? { strict } : {}),
}
```

```ts
// src/translator/responses/anthropic-to-responses.ts — no `strict` key at all.
return tools.map(tool => ({
  type: 'function',
  name: tool.name,
  parameters: normalizeFunctionParametersSchemaForCopilot(tool.input_schema),
  ...(tool.description ? { description: tool.description } : {}),
}))
```

The normalizer keeps only the metadata-annotation stripping. That block is
currently inert — upstream accepts those annotations today — but it was written
against the upstream of 2026-04 and stays on the dated-snapshot reasoning in
`upstream-types-are-not-contract-evidence.md`.

### The test that now states the contract

```ts
// A caller's optional parameter stays optional.
expect(normalizeFunctionParametersSchemaForCopilot({
  type: 'object',
  properties: { command: { type: 'string' }, timeout: { type: 'number' } },
  required: ['command'],
})).toEqual({
  type: 'object',
  properties: { command: { type: 'string' }, timeout: { type: 'number' } },
  required: ['command'],
})
```

Previously this returned `required: ['command', 'timeout']`.

Route-level assertions now check **key absence** explicitly:

```ts
expect(tool && 'strict' in tool).toBe(false)
```

`toMatchObject` cannot distinguish "absent" from "not asserted", and absence is
the entire point — so the assertion has to name it.

## Related

- `docs/research/responses-tool-strict.md` — the full matrix, the functional
  probe, the model-specific `grok-4.5` case, and an explicit not-covered list.
- `scripts/probes/tool-strict.ts` — the standing probe. Per
  `capability-verdicts-are-scoped-to-one-boundary.md` §4, a finding that does not
  land in the standing probe has a one-run shelf life.
- `docs/solutions/conventions/capability-verdicts-name-a-schema-and-a-mechanism.md`
  — the discipline the probe follows: vary the schema, and make the prompt
  demand the tool.
- `docs/solutions/conventions/upstream-types-are-not-contract-evidence.md` — why
  the inert annotation list stays.
- `CONCEPTS.md` — [[Proxy boundary]], [[Translation policy]].
