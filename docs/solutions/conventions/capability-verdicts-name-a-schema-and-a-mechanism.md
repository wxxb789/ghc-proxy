---
title: "A capability verdict names a schema and a mechanism, not just a boundary"
date: 2026-08-06
category: conventions
module: upstream capability modeling
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Reading or writing a capability claim that identifies a tool by its word alone"
  - "Deciding whether an upstream builtin block affects a client's same-named function tool"
  - "Recording a probe rejection whose error text is about payload shape rather than support"
  - "Writing a functional probe whose prompt gives the model no reason to invoke the tool"
  - "Treating a 200 as evidence of support on a boundary that ignores the field under test"
related_components:
  - "messages routing"
  - "probe harness"
  - "tool catalogue"
  - "documentation"
tags:
  - "upstream-contract"
  - "capability-detection"
  - "probe-before-assume"
  - "probe-methodology"
  - "builtin-tools"
  - "tool-schemas"
  - "execution-mechanism"
  - "boundary-attribution"
---

# A capability verdict names a schema and a mechanism, not just a boundary

## Context

This repo now has a small taxonomy of *beliefs that turn out to be wrong*, and
each entry exists because the previous entries' defences all returned a clean
answer:

- `docs/solutions/conventions/upstream-types-are-not-contract-evidence.md` — the
  belief was **never verified**. `top_k` was declared unsupported because it was
  missing from a hand-written payload type. Nobody had ever sent it.
- `docs/solutions/conventions/duplicated-semantic-rules-diverge-silently.md` —
  the belief was **implemented twice** and the copies drifted.
- `docs/solutions/testing/green-suite-is-evidence-about-one-runtime.md` — the
  belief was **tested on one of two runtimes**.
- `docs/solutions/conventions/policy-rejection-is-not-a-protocol-limit.md` — the
  belief was real and reproducible but attributed to the wrong **layer**: a GCP
  org-policy constraint read as an Anthropic protocol limit, then generalized to
  every future model.
- `docs/solutions/conventions/capability-verdicts-are-scoped-to-one-boundary.md`
  — the belief was measured on one of three **endpoints** and enforced on a
  different one. `/v1/messages` rejects web search; the guard blocking it lived
  in the `/responses` handler.

**This one is the next step past all of them.** In the 2026-08-05 probe round
described below, the boundary was right — `/v1/messages` was probed and
`/v1/messages` was the subject. The layer was read right — `The use of the web
search tool is not supported.` really is a tool-specific gate, not an org
policy. There was one implementation, and a probe really ran, against live
upstream, returning live status codes.

The verdicts were still wrong, three different ways:

1. The probe sent a payload **malformed for the schema under test**, and the
   resulting 400 described the probe's own bug. Recording it produced a
   capability verdict manufactured from a shape error.
2. The probe used a **prompt that demanded nothing**, so "the model chose not to"
   and "the model cannot" produced the same output.
3. Two tools sharing a **name** have opposite verdicts because they have
   different **execution mechanisms** — one server-executed by upstream, one
   client-executed by the caller. A verdict for one says nothing about the other.

The short form: an endpoint is not the finest grain a capability claim has to be
scoped to. A verdict is scoped to `(boundary, schema, mechanism, prompt)`. Get
any one of the four wrong and the probe still returns a confident number.

### The four findings, all probed 2026-08-05

Live GitHub Copilot upstream, `claude-opus-5` and `claude-sonnet-5`, identical
results on both. Full writeup in `docs/research/claude-5-tool-schemas.md`.

**A. Same name, opposite verdict, different mechanism.** On the *same*
`/v1/messages` boundary, in the same session:

```text
// builtin type tag — server-executed by upstream
{"type": "web_search_20250305", "name": "web_search"}
// → 400 The use of the web search tool is not supported.

// ordinary function tool — client-executed by the caller
{"name": "web_search", "description": "...", "input_schema": {...}}
// → 200, and the model emits a `tool_use` block naming `web_search`
```

All eight probed names — `WebSearch`, `WebFetch`, `web_search`, `web_fetch`,
`Bash`, `shell`, `computer`, `Read` — were accepted *and invoked* as function
tools on both `/v1/messages` and `/chat/completions`
(`docs/research/claude-5-tool-schemas.md:33-50`). The gate is on the builtin
type tag, not on the word.

That distinction has a blast radius attached. A blocked *tag* is narrow: a
client can rename around it, and only clients using Anthropic builtins are
affected. A filtered *name* would be broad and unworkaroundable — every Claude
Code client silently loses `WebSearch`, every Codex client loses `web_search`,
and no config change helps. Those two worlds produce the same user-visible
symptom, and until this round nothing in the repo distinguished them. That
reasoning is now recorded in the probe itself
(`scripts/lib/tool-cases.ts:42-58`).

**B. A malformed payload masquerading as a verdict.** Round 1 cross-posted the
raw Anthropic tool object to `/chat/completions` and recorded the 400 as
"rejected". The error was:

```
tools.0.custom.name: String should have at least 1 character
```

Read what that sentence is about. `tools.0.custom.name` is a path into the
*OpenAI* tool schema, where a `custom` tool carries a nested `custom` object with
its own `name`. Upstream was complaining that a required field of the schema it
models was empty — because the probe had posted an Anthropic-shaped object into
an OpenAI-shaped slot. It is a statement about the probe's payload, not about
whether the boundary supports builtins. Recording it as a capability verdict
would have been a fourth entry in the taxonomy above, invented on the spot
(`docs/research/claude-5-tool-schemas.md:77-90`).

**C. A functional probe whose prompt demanded nothing.** Round 1 declared a tool
and then prompted:

```
Reply with the single word OK.
```

and recorded `observed: ["text"]` — no tool call, for every case. That result is
compatible with "upstream blocks this tool" and with "the model correctly
answered a question that needed no tool," and nothing in the run separates them.
Round 2 paired each name with a prompt that cannot be satisfied without the tool
and forced `tool_choice`. **Every previously "silent" case produced a real call**
(`docs/research/claude-5-tool-schemas.md:105-114`).

**D. `/chat/completions` does not validate tool `type` at all.** Probed on
`claude-opus-5`:

```text
{"type": "web_search_20250305",   "function": {"name": "web_search", ...}} // → 200
{"type": "function",              "function": {"name": "web_search", ...}} // → 200
{"type": "totally_not_a_tool_9000","function": {"name": "web_search", ...}} // → 200
```

A deliberately nonsensical type returns 200. So a 200 on a builtin tag on that
boundary is **not** evidence of builtin support — the field is ignored and the
tool is handled as a plain function
(`docs/research/claude-5-tool-schemas.md:94-103`). B and D are the same mistake
with opposite signs: B would have recorded a capability the boundary *has* as
missing; D would have recorded a capability the boundary *does not have* as
present.

**E. The deliberate non-change.** `README.md:68` recommends, for Claude Code:

```json
{ "permissions": { "deny": ["WebSearch"] } }
```

Finding A looks like it contradicts that line. It does not. Claude Code's
`WebSearch` is Anthropic's server-side builtin — the same tag `/v1/messages`
refuses — not a function tool that happens to share the name. Same word,
different mechanism, opposite verdict. The README line was left in place, and
`docs/research/claude-5-tool-schemas.md:141-168` records *why*, specifically so
that a future reader does not "fix" the README from the name table two sections
above it.

## Guidance

**Before recording a capability verdict, state four things: which boundary, which
request schema, which execution mechanism, and what the prompt required. A probe
that leaves any of them implicit can manufacture the answer.**

### 1. A 400 that describes your payload is not a verdict

Classify the error text before recording anything. `docs/research/builtin-tool-support.md:96-105`
already splits `/v1/messages` rejections into three layers that age differently:

- `does not support tool types: X` — the model knows the tag and declines it.
- `Input tag 'X' ... does not match any` — schema-level; upstream does not model
  the tag at all.
- `The use of the web search tool is not supported.` / `rejected tool(s): web_fetch`
  — a tool-specific gate.

Finding B adds a fourth that belongs in a different bucket entirely:

- `tools.0.custom.name: String should have at least 1 character` — **a shape
  error about the request you sent.** No verdict. Fix the payload and re-probe.

The tell is that the error names a *field path in your own request*, not a
capability. Anything of the form `<path>: <constraint>` is upstream parsing what
you sent, and the only thing it establishes is that you sent it wrong.

### 2. A functional probe needs a prompt the tool is necessary for

This is now written on the type every future case is declared against, rather
than in a doc someone might not read (`scripts/lib/tool-cases.ts:12-17`):

```text
 * **The prompt is load-bearing.** A probe that declares a tool and then asks
 * "Reply with the single word OK." records `silent` for every tool on earth,
 * because nothing in the request called for one. "The model chose not to" and
 * "the model cannot" are indistinguishable unless the prompt demands the tool.
 * Cost one probe round on 2026-08-05 (`docs/research/claude-5-tool-schemas.md`).
```

`ToolCase` (`scripts/lib/tool-cases.ts:29-40`) makes the requirement structural:
every case must supply `prompt` (*"A prompt that cannot be answered without the
tool"*), `proof` (the item/block types that appear when it runs), and `kind` (who
executes it). None of the three is optional, so a case that cannot answer
"how would I know it worked?" cannot be written.

### 3. Name the mechanism, because the name does not

`ToolKind` (`scripts/lib/tool-cases.ts:20-27`) exists because "did the tool work"
means different things depending on who runs it:

```ts
export type ToolKind
  /** Upstream executes it and returns a result. */
  = | 'server'
  /** The model emits a call; the caller executes it. */
    | 'client'
  /** Not a builtin — the baseline that proves the harness itself works. */
    | 'control'
```

For a `server` tool, proof is a result block coming back
(`web_search_tool_result`, `code_execution_tool_result`). For a `client` tool,
proof is a correctly-named call going out (`tool_use`, `function_call`) — the
caller executes it, so there is nothing else upstream could return. Conflating
the two makes a `client` tool look broken because upstream never ran it, and
makes a `server` tool look supported because the model emitted a call upstream
then refused.

`classify()` enforces the name check as well as the type check
(`scripts/probes/tool-support.ts:151-158`):

```ts
const traced = kase.proof.some(p => types.includes(p))
if (!traced)
  return 'silent'
if (kase.callName && names.length > 0 && !names.includes(kase.callName))
  return 'silent'
return kase.kind === 'server' ? 'ran' : 'called'
```

Without the second clause, a model that invents an unrelated tool call scores as
a hit for whatever tool you were probing.

### 4. Design the probe so a 200 cannot mean two things

Finding D is the reason this is a design rule rather than an analysis rule. On
`/chat/completions`, `type` is ignored, so `200` is returned by both a supported
builtin and a meaningless string. A probe that only reads status codes on that
boundary is incapable of distinguishing them *no matter how carefully you read
the results afterwards*.

The remedy is a **negative control**: send something that must fail if the field
is being validated. `totally_not_a_tool_9000` is that control, and it is what
turned an ambiguous 200 into a finding. The existing suite already had the
positive equivalent — the `function (control)` case on both boundaries
(`scripts/lib/tool-cases.ts:121-133` and `226-236`), which proves the harness
itself works before any real case is believed. Findings D shows the pair is
needed: a control that must pass, and a control that must fail.

### 5. Keep the two questions separable in the standing probe

`--names` exists so the tag-versus-name distinction is re-measurable rather than
a one-run finding (`scripts/probes/tool-support.ts:65`), and it composes rather
than replaces:

```text
cases: withNames
  ? [...MESSAGES_TOOL_CASES, ...nameFilterCases(anthropicFunctionTool, ['tool_use'])]
  : MESSAGES_TOOL_CASES,
```

(`scripts/probes/tool-support.ts:262-264`; the `/responses` wiring is the same
shape at `:237-239` with `responsesFunctionTool` and `['function_call']`.)

The name cases are generated from one list of suspects and one boundary-specific
shape function (`nameFilterCases`, `scripts/lib/tool-cases.ts:85-97`), so the
same eight names are asked the same question on each boundary in that boundary's
own schema — which is precisely the discipline finding B violated by hand.

Note what is *not* covered, and say so out loud: `buildBoundaries`
(`scripts/probes/tool-support.ts:231-281`) returns exactly two boundaries,
`/responses` and `/v1/messages`. `/chat/completions` is not among them, so
finding D — the one that most needs a standing guard, because it makes 200s
unreadable — is currently only reproducible by hand. The comment recording the
8/8 result claims both `/v1/messages` and `/chat/completions`
(`scripts/lib/tool-cases.ts:54-56`); the standing probe can re-measure the first
half of that claim only.

## Why This Matters

**Both error directions cost a real capability, and they hide in different
places.** A false negative (B) removes a tool the client could have used and
leaves an authoritative-sounding "not supported" in a table. A false positive (D)
advertises a tool that will silently do nothing — the `inert` verdict
`summarize()` exists to name (`scripts/probes/tool-support.ts:94-104`), where the
field is tolerated and never invoked. `docs/research/builtin-tool-support.md:22-24`
records that nothing came back `inert` in that sweep, which is only meaningful
*because* the probe could have reported it.

**A probe is code, and code has bugs with the same shape as the bugs it hunts.**
`upstream-types-are-not-contract-evidence.md` already documents one instance —
the first prompt-caching run measured a warm cache and would have "proven"
Copilot never writes cache. Round 1 here is two more. The remedy in all three
cases is the same and it is not "be careful": it is a control that fails when the
methodology is broken. The cold-prefix `RUN_ID` for caching, the
`function (control)` case for tool tracing, and `totally_not_a_tool_9000` for
type validation are the same device applied to three different probes.

**The blast-radius question is what makes this worth two probe rounds.** "Is
`web_search` blocked?" has no useful answer. "Is the *builtin tag* blocked, or is
the *name* filtered?" has two answers with different remedies: rename your tool,
versus there is no remedy. Nothing in the upstream error text distinguishes them
— `The use of the web search tool is not supported.` names a capability, not a
tag — so the distinction had to be measured. It is the sort of question that
looks like a detail until you notice one branch means every Claude Code user
silently loses a tool.

**A correct doc can still mislead through adjacency.** The name table in
`docs/research/claude-5-tool-schemas.md:33-42` is accurate and the README's
`deny: ["WebSearch"]` is also correct, and a reader who takes the first as
license to delete the second breaks their own setup. The doc carries a section
titled *"Do NOT read this as 'Claude Code's WebSearch works'"* (`:141`) for
exactly that reason. When a finding is one inference step away from a wrong
action, write the wrong inference down and refute it — do not rely on the reader
not making it.

**The open question is honestly open, and the suggested way to close it does not
cover the boundary it needs to.** `docs/research/claude-5-tool-schemas.md:172-177`
says the one thing that would change a README recommendation is *what shape
Claude Code actually sends `WebSearch` in*, and suggests `--dump-failed-payloads`
as the capture tool. At the current tree that flag only dumps `/responses`
payloads on upstream 400 (`src/routes/responses/strategy.ts:95`, described that
way in `README.md:119`); `claude-opus-5` has no `/responses` endpoint, so a
Claude Code request carrying `WebSearch` would not be dumped by it. Anyone
picking this up needs a `/v1/messages`-side capture, not that flag.

**Unscoped phrasing is how a good verdict decays.** An auto-memory entry from
2026-07-26 (auto memory [claude], `project_copilot_upstream_status`) records
`web_search_*/web_fetch_*/computer_*/mcp_* = rejected everywhere`. That was
accurate for the boundary it was measured on and is exactly the sentence this
learning warns about: it names no boundary, no schema, and no mechanism, so a
reader cannot tell that it is about builtin *type tags* on `/v1/messages` and
says nothing about a function tool named `web_search` on the same endpoint —
which works.

## When to Apply

- **A probe cross-posts a payload between boundaries.** Re-shape it into the
  target boundary's own schema first. `/v1/messages` tools carry
  `input_schema`; `/responses` tools carry `parameters`; `/chat/completions`
  tools carry a nested `function` object and model `custom` differently. The
  same tool in three schemas is three payloads, and posting one where another
  belongs produces a 400 that means nothing.
- **You are about to write "rejected" next to an error you have not classified.**
  If the message names a field path in your request, it is a shape error. If it
  names a project, org, policy, or quota, see
  `policy-rejection-is-not-a-protocol-limit.md`. Only a statement about the
  capability itself is a capability verdict.
- **A functional result says the model did not use the tool.** Check what the
  prompt asked for before recording anything. If the request could be satisfied
  without the tool, the run measured nothing.
- **A boundary returns 200 for a field you suspect it ignores.** Add a garbage
  value. If garbage also returns 200, no 200 on that field is evidence of
  anything, and the whole column of results needs re-reading.
- **A capability claim mentions a tool by name.** Ask who executes it.
  `WebSearch` the Anthropic server builtin and `WebSearch` the Claude Code
  function tool are different objects with opposite verdicts on the same
  endpoint on the same day.

Not needed when the constraint comes from the client-facing spec the proxy
exposes rather than from upstream — those are properties of the protocol and hold
wherever it is spoken, independent of which schema carried the request.

## Examples

### The same question, asked wrong and then right

Round 1, `/chat/completions`, Anthropic object posted raw:

```jsonc
{ "tools": [{ "type": "web_search_20250305", "name": "web_search" }] }
// → 400 tools.0.custom.name: String should have at least 1 character
// Recorded as: "rejected"        ← a verdict manufactured from a probe bug
```

Round 2, same boundary, the shape that boundary actually models:

```text
{"tools": [{"type": "web_search_20250305", "function": {"name": "web_search", ...}}]}
// → 200
{"tools": [{"type": "totally_not_a_tool_9000", "function": {"name": "web_search", ...}}]}
// → 200                          ← so the first 200 is not support either
```

The corrected round produced a *different* finding from the one round 2 set out
to check: not "builtins are supported here" but "`type` is not read here at all."
That is the payoff of fixing a methodology rather than re-running it — the second
control answered a question nobody had thought to ask.

### The name table and the README line, side by side

Both true at the current tree, on `/v1/messages`, for `claude-opus-5`:

| Declaration | Mechanism | Result |
| --- | --- | --- |
| `{"type":"web_search_20250305","name":"web_search"}` | server-executed builtin | 400 `The use of the web search tool is not supported.` |
| `{"name":"web_search","description":...,"input_schema":{...}}` | client-executed function tool | 200, `tool_use` block named `web_search` |

`README.md:68` denies `WebSearch` for Claude Code because Claude Code's
`WebSearch` is the first row, not the second. Reproduction for both rows —
including the `tool_choice` forcing that makes the second row conclusive — is at
`docs/research/claude-5-tool-schemas.md:186-202`.

### The prompt change, in the cases themselves

Before (round 1) — every case shared the accept-level prompt:

```
"Reply with the single word OK."   → observed: ["text"]   → recorded silent
```

After (`scripts/lib/tool-cases.ts:89-96`) — the prompt is generated per name from
a task the tool is required for, and the expected call name travels with it:

```ts
return NAME_FILTER_SUSPECTS.map(({ name, task }) => ({
  name: `name:${name}`,
  kind: 'client',
  tool: shape(name),
  prompt: `Use the ${name} tool to ${task}. Call the tool.`,
  proof,
  callName: name,
}))
```

The task strings are deliberately concrete —
`'search for the latest Bun release version'`, `'run \`uname -a\`'`,
`'take a screenshot'` (`scripts/lib/tool-cases.ts:64-73`) — because a vague task
is answerable in prose and puts you back in round 1.

Note the two-level structure this sits inside
(`scripts/probes/tool-support.ts:184-227`): level 1 declares the tool and records
the HTTP status, and level 2 runs only if level 1 accepted. That ordering is what
keeps an accept-level 400 (a real rejection) from being confused with a
functional-level silence (no proof of use), and `--accept-only`
(`scripts/probes/tool-support.ts:64`) makes the cheap half runnable on its own —
as long as the person reading its output remembers it answers the weaker
question.

### The verdict vocabulary that keeps the distinctions visible

`summarize()` (`scripts/probes/tool-support.ts:94-104`) refuses to collapse the
axes into a boolean:

```ts
if (v.accept === 'unmeasured')
  return 'unmeasured'
if (v.accept === 'rejected')
  return 'unsupported'
if (!v.functional || v.functional === 'skipped')
  return 'accepted'
if (v.functional === 'unmeasured')
  return 'unmeasured'
return v.functional === 'silent' ? 'inert' : 'supported'
```

Five words, and each names a different epistemic state: `supported` (it ran or
was called), `accepted` (declaration took, execution not measured), `inert`
(accepted and never invoked), `unsupported` (upstream refused), `unmeasured` (a
capacity or gateway fault carrying no signal —
`scripts/lib/probe-harness.ts:30` treats 408/429/5xx/529 as unmeasured and
`sendRawWithRetry` retries them without ever retrying a 400,
`scripts/lib/probe-harness.ts:111-129`). The probe then prints the `unmeasured`
cells with an explicit instruction not to publish them as unsupported
(`scripts/probes/tool-support.ts:373-379`). Round 1's `observed: ["text"]` had no
vocabulary slot at all, which is part of how it got written down as a fact.

### What the fix touched, and what it deliberately did not

On the unmerged branch `fix/responses-web-search-unblock` (commits `f7e2e0b`,
`8db42c3`, `8a5db2d` — pending, not on `main`):

- `scripts/lib/tool-cases.ts` — `nameFilterCases()`, `anthropicFunctionTool()`,
  `responsesFunctionTool()`, `NAME_FILTER_SUSPECTS`, and the module/`ToolCase`
  doc comments quoted above.
- `scripts/probes/tool-support.ts` — the `--names` flag and its wiring into both
  boundaries' `cases`.
- `docs/research/claude-5-tool-schemas.md` — the evidence writeup, including both
  round-1 defects, which are kept rather than quietly corrected.
- Verified live: `--names` against `claude-sonnet-5` returned 8/8 `supported`.
- **No proxy behavior changed.** The proxy filters no tool names on either
  boundary — `grep -rn web_search src/` at the current tree finds only Anthropic
  *result* block types, the `/responses` `tool_choice` enum
  (`src/ingest/validation/responses.ts:218-231`), and `ToolChoiceBuiltin`
  (`src/types/responses.ts:66-68`) — so the correct outcome of the probe was a
  documented non-change plus a re-runnable probe.

The earlier commit on the same branch is the one that removed real code:
`rejectUnsupportedBuiltinTools()` is gone from `src/routes/responses/handler.ts`,
which is the subject of
`capability-verdicts-are-scoped-to-one-boundary.md`. Worth holding both together
— that change deleted a wrong guard, this one declined to touch a right one. The
same evidence-first discipline produced opposite actions, which is what
distinguishes it from a bias toward deleting guards.

## Related

- `docs/research/claude-5-tool-schemas.md` — the full probe: the name table, the
  `/chat/completions` type-validation finding, the whole-toolset bundles, both
  round-1 defects, the README non-change, and an explicit not-covered list whose
  top entry is the one open question.
- `docs/solutions/conventions/a-proxy-default-is-a-decision-made-for-the-caller.md`
  — the entry one step *past* this taxonomy. There the belief was not wrong at
  all: no verdict was misread, because the proxy was not reporting on upstream —
  it defaulted a field the caller left unset and rewrote their payload to make
  that default work. This doc's discipline is what its probe follows.
- `docs/research/builtin-tool-support.md` — the per-tool matrix this extends, and
  the three-layer split of `/v1/messages` rejection text that finding B adds a
  fourth bucket to.
- `docs/solutions/conventions/capability-verdicts-are-scoped-to-one-boundary.md`
  — the sibling one step back: right layer, wrong endpoint. Its remedy (probe the
  boundary you enforce on) is necessary here but not sufficient; the boundary was
  right and the schema was wrong.
- `docs/solutions/conventions/policy-rejection-is-not-a-protocol-limit.md` — the
  wrong-layer sibling, and the entry that first laid out this taxonomy explicitly.
- `docs/solutions/conventions/upstream-types-are-not-contract-evidence.md` — the
  never-verified sibling. Its "Probe design: the tested state must be cold"
  section is the direct ancestor of this doc's §4: a probe can be wrong the same
  way the assumption it replaces was wrong.
- `docs/solutions/testing/green-suite-is-evidence-about-one-runtime.md` — the
  same shape one layer down: a signal that looks like proof, scoped to a
  dimension nobody stated.
- `scripts/lib/tool-cases.ts` / `scripts/probes/tool-support.ts` — the standing
  probe. `--names` re-measures the tag-versus-name distinction on `/responses`
  and `/v1/messages`; `/chat/completions` is not a boundary it covers.
- PR #62, #63 (parameter verdicts), PR #68 (the policy-layer fix), PR #70 (the
  runtime-scope fix). The web-search unblock and the probe rework described here
  are pending on `fix/responses-web-search-unblock` and have no PR number yet.
