# claude-opus-5 / claude-sonnet-5 — tool support by schema (probed)

Whether the v5 Claude pair's tool restrictions follow the **tool type tag** or
the **tool name**, across every request schema they can be addressed with.

**Date:** 2026-08-05. **Method:** one-off probes on
`scripts/lib/probe-harness.ts`; reproduction recipe at the bottom. Two rounds —
round 1 had two defects, both corrected in round 2 and both described below,
because the corrections are the finding.

## Why this was worth asking

`/v1/messages` rejects the builtin `web_search_20250305` tag with:

```
The use of the web search tool is not supported.
```

That sentence names a *capability*, not a tag. If upstream were filtering on
tool **names**, then any Claude Code client — whose toolset includes a function
tool literally named `WebSearch` — would silently lose it, and Codex clients
would lose `web_search`. That would be a far larger blast radius than a blocked
builtin.

It is not. The filter is on the type tag only.

## Verdict: named function tools are unrestricted, and they run

Every name below was sent as an **ordinary function tool** — nothing builtin
about it, only the name matches a Claude Code or Codex builtin — with a prompt
demanding its use and `tool_choice` forcing it.

| Tool name | `/v1/messages` | `/chat/completions` |
| --- | --- | --- |
| `WebSearch` | called | called |
| `WebFetch` | called | called |
| `web_search` | called | called |
| `web_fetch` | called | called |
| `Bash` | called | called |
| `shell` | called | called |
| `computer` | called | called |
| `Read` | called | called |

8/8 on both boundaries, both models, `200` with the tool actually invoked —
`tool_use` blocks on `/v1/messages`, `tool_calls` on `/chat/completions`, each
carrying the requested name back.

**A function tool named `web_search` is invoked on the same boundary whose
builtin `web_search` tag is refused.** The restriction is about the builtin
implementation, not the word.

## Reachability: `/responses` is genuinely absent

The model record advertises `/v1/messages` + `/chat/completions`. Probed
directly rather than trusted:

```
POST /responses  {"model":"claude-opus-5",   ...} → 400 model claude-opus-5 does not support Responses API.
POST /responses  {"model":"claude-sonnet-5", ...} → 400 model claude-sonnet-5 does not support Responses API.
```

Here the advertisement matches reality. Worth stating explicitly: this was
checked, not assumed — `grok-4.5` had just proven the model record can be wrong
about efforts (`grok-4.5-schema.md`).

## Builtin type tags are exclusive to `/v1/messages`

| Tag | `/v1/messages` | `/chat/completions` |
| --- | --- | --- |
| `bash_20250124` | accepted | not modelled |
| `text_editor_20250728` | accepted | not modelled |
| `code_execution_20250825` | accepted | not modelled |
| `web_search_20250305` | **rejected** — `The use of the web search tool is not supported.` | not modelled |

"Not modelled" needs care, and round 1 got it wrong.

### Round-1 defect: a malformed payload read as a capability verdict

Round 1 cross-posted the raw Anthropic tool object to `/chat/completions` and
recorded the resulting 400 as "rejected". The error was:

```
tools.0.custom.name: String should have at least 1 character
```

That is upstream complaining that an *OpenAI-shaped* `custom` tool is missing
its nested `custom.name` — a shape error caused by the probe, not a statement
about builtins. Recording it as a rejection would have been the same mistake
this repo already has two learnings about.

Round 2 re-sent it in the shape that boundary models. The result is that
`/chat/completions` **does not validate `type` at all**:

```
{"type":"web_search_20250305",  "function":{"name":"web_search", ...}} → 200
{"type":"function",             "function":{"name":"web_search", ...}} → 200
{"type":"totally_not_a_tool_9000","function":{"name":"web_search", ...}} → 200
```

A deliberately nonsensical type is accepted. So the `200` on the builtin tag is
**not evidence of builtin support** — the field is ignored and the tool is
handled as a plain function. `/chat/completions` exposes no builtin tool surface;
it accepts OpenAI function tools and disregards anything else in `type`.

### Round-1 defect: a prompt that gave the model no reason to call

Round 1 asked *"Reply with the single word OK."* while declaring the tool, then
recorded `observed: ["text"]` — no tool call. That proved nothing: the prompt
never asked for one. Round 2 pairs each name with a prompt that requires it and
forces `tool_choice`. Every previously "silent" case turns into a real call.

The general form: **a functional probe needs a prompt the tool is necessary
for.** Otherwise "the model did not use it" and "the model could not use it"
are indistinguishable.

## Whole-toolset bundles

Single-tool passes do not prove a real client's payload passes. Full sets, sent
in one request:

| Bundle | `/v1/messages` | `/chat/completions` |
| --- | --- | --- |
| Claude Code's 14 tools (`Task`, `Bash`, `Glob`, `Grep`, `Read`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`, `BashOutput`, `KillShell`, `SlashCommand`) | accepted, `tool_use` emitted | accepted |
| Codex's 5 tools (`shell`, `apply_patch`, `update_plan`, `view_image`, `web_search`) | accepted, `tool_use` emitted | accepted (`tool_call:shell` on sonnet-5) |
| Mixed: builtin `bash_20250124` + `text_editor_20250728` **plus** 6 named function tools | accepted, `tool_use` emitted | — |

The mixed bundle matters most: a client may combine Anthropic builtins with its
own function tools in one request, and that composition is accepted.

## What this means for the proxy

The proxy ingress uses `type` to preserve the mechanism. Ordinary function
tools have an absent, null, or `custom` type and require both `name` and
`input_schema`. Every other non-null type remains an Anthropic built-in or
toolset even if a caller adds `input_schema`; a toolset may also omit `name`.
The native Messages path accepts these shapes without converting a typed
definition into a function tool.

The proxy does not filter tool names and does not pre-empt the observed
`web_search_20250305` policy failure. For the v5 pair, the `400` documented
above is returned by Copilot upstream after the canonical builtin passes local
ingress validation. That keeps the capability verdict at the boundary that
actually made it, per
`../solutions/conventions/capability-verdicts-are-scoped-to-one-boundary.md`.

If a selected model cannot use native Messages and would require Responses or
Chat Completions translation, the proxy rejects the typed built-in/toolset shape
(a non-null `type` other than `custom`) with `unsupported_server_tool` before
dispatch, even if a caller adds an `input_schema`. An ordinary function call
cannot preserve the execution mechanism or expansion semantics of every typed
Anthropic definition.

The practical summary for a client author: on the v5 Claude pair, **name your
ordinary function tools whatever you like**. Canonical builtin tags are a
separate, server-executed mechanism subject to upstream policy. This page
directly observed acceptance of `bash_20250124`, `text_editor_20250728`, and
`code_execution_20250825`, and rejection of `web_search_20250305`; broader
builtin coverage belongs to `builtin-tool-support.md`.

## Do NOT read this as "Claude Code's WebSearch works"

It does not follow, and the confusion would be expensive.

This page measured a *function tool that happens to be named* `WebSearch`: the
model emits a call and the client executes it. Anthropic also defines a distinct
server-side builtin tagged `web_search_20250305`, which `/v1/messages` refused.
No captured Claude Code payload in this repo proves which shape Claude Code
actually sends, so the function-tool result must not be promoted into a Claude
Code capability claim.

So `README.md`'s recommended Claude Code config —

```json
{ "permissions": { "deny": ["WebSearch"] } }
```

— is **not** contradicted by the table above and was deliberately left in place.

What is still unverified: whether Claude Code sends `WebSearch` as the builtin
tag or in some other shape. No captured Claude Code `/v1/messages` payload
exists in this repo, and this probe did not produce one. The current
`--dump-failed-payloads` option covers Responses upstream 400s, not this native
Messages boundary; changing the README recommendation requires a dedicated
`/v1/messages` capture rather than inference from this page.

The general trap: **a tool's name does not tell you its execution mechanism.**
Two tools can share a name, one server-executed and one client-executed, and a
capability verdict for one says nothing about the other.

## Not covered

- Whether a *called* `WebSearch` function tool returns useful results. The
  probe verifies the model emits the call; executing it is the client's job, so
  there is nothing upstream to measure.
- **What shape Claude Code actually sends `WebSearch` in.** See the section
  above — this is the one open question that would change a README
  recommendation.
- Streaming. All requests here were non-streaming.
- Bundle sizes beyond 14 tools, and whether a large toolset degrades selection
  quality rather than being rejected.
- `/chat/completions` builtin support for models *other* than the Claude pair.
  The "type is not validated" finding was measured on `claude-opus-5`.
- The remaining Anthropic builtin tags on the OpenAI boundary — moot, given
  `type` is ignored there.

## Reproducing

```bash
# Name-filter question: is a plain function tool named `web_search` invoked
# on the boundary whose builtin `web_search` is blocked?
bun run ./src/main.ts start --port 4142
curl -s -X POST http://127.0.0.1:4142/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-opus-5","max_tokens":512,
       "messages":[{"role":"user","content":"Use the web_search tool to find the latest Bun version. Call the tool."}],
       "tools":[{"name":"web_search","description":"Search the web",
                 "input_schema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}],
       "tool_choice":{"type":"tool","name":"web_search"}}'
```

Expect a `tool_use` block naming `web_search`. Swap the tool declaration for
`{"type":"web_search_20250305","name":"web_search"}` to exercise the
canonical builtin shape. The proxy accepts that shape without `input_schema`
and forwards it; the v5 upstream then returns the documented 400.

## Related

- [builtin-tool-support.md](builtin-tool-support.md) — the per-tool matrix this
  extends; its `/v1/messages` rows are the type-tag control group here.
- [grok-4.5-schema.md](grok-4.5-schema.md) — the other model whose advertised
  record was checked rather than trusted, and where it turned out wrong.
- [../solutions/conventions/capability-verdicts-are-scoped-to-one-boundary.md](../solutions/conventions/capability-verdicts-are-scoped-to-one-boundary.md)
  — why a verdict names its boundary. This adds a second axis: a verdict also
  names its *schema*, and a shape error on the wrong schema is not a verdict.
