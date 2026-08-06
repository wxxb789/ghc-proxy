---
title: "A capability verdict belongs to one boundary — check which one before enforcing it"
date: 2026-08-04
category: conventions
module: upstream capability modeling
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Adding a local rejection for a tool, field, or feature the proxy believes upstream lacks"
  - "Reusing a probe result from `/v1/messages` on `/responses`, or the reverse"
  - "Reviewing a guard whose error text names a capability but not the endpoint it was measured on"
  - "A doc line says 'upstream does not support X' without naming a boundary"
related_components:
  - "responses routing"
  - "messages routing"
  - "ingest validation"
tags:
  - "upstream-contract"
  - "boundary-attribution"
  - "probe-before-assume"
  - "responses-api"
  - "capability-detection"
  - "tools"
---

# A capability verdict belongs to one boundary — check which one before enforcing it

## Context

ghc-proxy speaks to Copilot over three different endpoints — `/v1/messages`,
`/responses`, `/chat/completions` — backed by different vendors, different
infrastructure, and different feature gates. They are not one upstream with one
contract. They are three.

`rejectUnsupportedBuiltinTools()` (`src/routes/responses/handler.ts`, removed in
this change) rejected any `/responses` request declaring `web_search`:

```ts
for (const tool of payload.tools) {
  if (tool.type === 'web_search') {
    throwInvalidRequestError(
      'The selected Copilot endpoint does not support the Responses web_search tool.',
      'tools',
      'unsupported_tool_web_search',
    )
  }
}
```

The belief behind it was real and correctly measured. `/v1/messages` rejects web
search on every Claude model, and still did when re-probed on 2026-08-04:

```
The use of the web search tool is not supported.
```

That verdict was then enforced on `/responses` — a boundary where it had never
been measured. Probing it for the first time (2026-08-04,
`docs/research/responses-web-search.md`) returned 200 from **every** model that
advertises `/responses`: `gpt-5-mini`, `gpt-5.3-codex`, `gpt-5.4`(`-mini`),
`gpt-5.5`, all three `gpt-5.6-*`, `grok-4.5`, `mai-code-1-flash-picker`. Not
merely accepted — `gpt-5.6-sol` and `gpt-5.6-terra` emit real `web_search_call`
items with `url_citation` annotations pointing at URLs tagged
`?utm_source=openai`.

The error message is the artifact worth staring at. *"The selected Copilot
endpoint does not support..."* — it names an endpoint, in a function that runs on
exactly one endpoint, and the endpoint it runs on was not the one that
rejected. The sentence was true about a boundary the code never touched.

### This is a distinct failure mode

The three existing learnings each rule out a different explanation, and none of
them covers this:

- `upstream-types-are-not-contract-evidence.md` — the belief was **never
  verified**. Here it was: a real request, a real 400, quotable error text.
- `policy-rejection-is-not-a-protocol-limit.md` — the belief was attributed to
  the wrong **layer** (org policy read as protocol). Here the layer was read
  correctly; *"the use of the web search tool is not supported"* is a
  protocol-level statement, and it is still accurate for `/v1/messages` today.
- `duplicated-semantic-rules-diverge-silently.md` — the belief was implemented
  twice and the copies drifted. Here there was one implementation.

The verdict was verified, correctly attributed to a layer, and implemented once.
It was attached to the **wrong boundary**. The usual defences — "did you probe
it?", "is that a policy error?", "is this rule duplicated?" — all return a clean
answer.

## Guidance

**A probe result is scoped to the endpoint it was sent to. Before enforcing a
capability verdict, check that the code enforcing it runs on the endpoint that
produced it.**

### 1. Name the boundary in the same breath as the verdict

"Copilot does not support web search" is not a statement that can be true or
false. "Copilot's `/v1/messages` rejects `web_search_20250305` for
`claude-opus-5`, 2026-08-04" is. Every capability claim in a comment, doc line,
or commit message should carry its endpoint the way it already carries its date.

`docs/messages-routing-and-translation.md` had this right by accident — its tool
table is headed *"the Copilot `/v1/messages` endpoint"* and a separate paragraph
covers `/responses`. The guard in the handler had no such header, and nothing
connected the two.

### 2. A guard's file path is a claim about scope

`src/routes/responses/handler.ts` runs on `/responses` and nowhere else. A rule
living there is asserting something about `/responses`. If the evidence in the
commit that introduced it came from a `/v1/messages` probe, the file path and
the evidence disagree, and the file path is the one clients experience.

The inverse holds for shared code: a rule in `src/transform/` or
`src/ingest/validation/shared.ts` applies to every boundary that routes through
it, so its evidence has to cover every one of them.

### 3. Do not block what upstream would answer

A local 400 saves a round trip only when upstream would have rejected anyway.
When upstream would have succeeded, the local 400 is a capability the client
cannot reach by any means — no config flag, no retry, no model switch. Forwarding
and letting upstream decide is strictly safer for anything not measured on
*this* boundary. That asymmetry is the reason the fix here is a deletion rather
than a narrower condition.

Upstream's own error text is the cheapest capability oracle available, and it
stays current for free.

### 4. Extend the standing probe, not just the one-off

The evidence for this change came from throwaway scripts. Those prove the point
once; they do not catch the next drift. `web_search` and `web_search_2025_08_26`
are now cases in `scripts/probes/tool-support.ts` alongside the `_preview`
spellings, so the weekly JSON diff covers them. A finding that does not land in
the standing probe is a finding with a one-run shelf life.

## Why This Matters

**The blocked capability was invisible from inside the proxy.** The 400 fired at
the proxy boundary before dispatch. No upstream call, no upstream error, nothing
in a Copilot-side log — and from the client's side, an authoritative-sounding
message asserting a limit that did not exist. `web_search` is a Codex/ChatGPT
built-in, so any Codex-shaped client pointed at this proxy lost web search
entirely and was told the backend could not do it.

**The tests encoded the same mistake.** Two tests asserted the 400
(`/v1/responses rejects unsupported builtin tools explicitly` and its
`tool_choice` sibling). They passed continuously. A test written from the same
misattribution cannot detect the misattribution — it locks it in, and it makes
the rule look deliberate to the next reader. Both are now passthrough tests
asserting the tools reach upstream unmodified.

**Boundary confusion gets easier as the proxy grows.** Three endpoints, a
translation layer that converts between them, and a strategy registry that picks
per model means a single client request can traverse two boundaries. "Does
Copilot support X" stops being answerable the moment the second endpoint
appears, and every doc line phrased that way becomes a latent version of this
bug.

**Deleting a wrong guard exposes what it hid.** Removing the block sent
`web_search` payloads down a path they had never taken. Here the downstream code
was already correct — `ResponseTool` is a permissive union and the validator's
`responsesUnknownToolSchema` passes unknown types through — but two narrower
spots did need widening: `ToolChoiceBuiltin` (`src/types/responses.ts`) and the
`tool_choice` enum in `src/ingest/validation/responses.ts` listed only the
`_preview` spellings, so a `tool_choice: { type: 'web_search' }` would have been
rejected by the schema even after the guard was gone.

## When to Apply

- **Writing a local rejection for an upstream limit.** State which endpoint the
  evidence came from, and confirm it is the endpoint the code runs on.
- **Reading a capability claim with no endpoint named.** Treat it as unscoped and
  therefore unverified, the same way `upstream-types-are-not-contract-evidence.md`
  treats a verdict with no probe.
- **Porting a rule between route directories.** `src/routes/messages/` and
  `src/routes/responses/` do not share an upstream contract. A rule that moves
  between them needs its evidence re-gathered, not copied.
- **A guard's error message names something the guard cannot see.** "The selected
  Copilot endpoint does not support..." in a single-endpoint handler is the smell
  this whole doc is about.

Not needed when the constraint comes from the client-facing spec rather than
upstream — those are properties of the protocol the proxy exposes and apply
wherever that protocol is spoken.

## Examples

### The verdict, per boundary, same day

Probed 2026-08-04, both boundaries, one run:

| Boundary | Request | Result |
| --- | --- | --- |
| `/responses` | `tools: [{ type: 'web_search' }]` | 200 on all 10 models; real `web_search_call` + `url_citation` on gpt-5.6 |
| `/v1/messages` | `tools: [{ type: 'web_search_20250305', name: 'web_search' }]` | 400 `The use of the web search tool is not supported.` (opus-5, sonnet-5) |

Both facts are true. Only one of them was ever about the code enforcing it.

### `tool_choice` is narrower than `tools` — and upstream says so

Not every web-search spelling works in every position. On `gpt-5.6-terra`:

```
tool_choice: { type: 'web_search' }                    → 200
tool_choice: { type: 'web_search_preview' }            → 200
tool_choice: { type: 'web_search_preview_2025_03_11' } → 400
tool_choice: { type: 'web_search_2025_08_26' }         → 400

Missing required parameter: 'tool_choice.tools'.
```

The dated spellings are fine inside `tools` and rejected as a bare
`tool_choice` — upstream parses them as the `allowed_tools` shape. That is a
constraint upstream states in its own error text, so the proxy forwards it
rather than reimplementing the rule locally. Per §3: a local guard here would
buy one saved round trip and cost a capability the moment upstream relaxes it.

### The tests that confirmed the bug

Before — passing, and wrong:

```ts
expect(response.status).toBe(400)
expect(json.error?.code).toBe('unsupported_tool_web_search')
expect(calls).toHaveLength(0)
```

After (`tests/responses-routing.test.ts`, "forwards builtin web_search tools
upstream") — asserts the payload reaches the client, unmodified:

```ts
expect(response.status).toBe(200)
expect(calls[0]?.payload.tools).toEqual([
  { type: 'web_search' },
  { type: 'web_search_preview' },
])
```

`calls).toHaveLength(0)` was the load-bearing assertion in the old pair: it
asserted upstream is never asked. Any test that asserts upstream is never
consulted about a capability deserves a second look at where the capability
verdict came from.

## Related

- `docs/research/responses-web-search.md` — the full probe: acceptance matrix
  across every `/responses` model, the functional `web_search_call` evidence, the
  `tool_choice` asymmetry, and an explicit not-covered list (streaming,
  `web_fetch`, tool options, per-search cost).
- `docs/solutions/conventions/upstream-types-are-not-contract-evidence.md` — the
  unverified belief. Its remedy (probe first) was already satisfied here;
  add: probe *the boundary you are about to enforce on*.
- `docs/solutions/conventions/policy-rejection-is-not-a-protocol-limit.md` — the
  wrong-layer sibling. Between them: an upstream rejection has a layer *and* a
  boundary, and reading one correctly says nothing about the other.
- `docs/messages-routing-and-translation.md` — per-boundary tool tables; the
  `/v1/messages` verdict there is unchanged and still correct.
- `scripts/probes/tool-support.ts` — the standing probe, now covering
  `web_search` and `web_search_2025_08_26`.
