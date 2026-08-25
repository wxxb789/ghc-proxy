# Builtin tool support (probed)

Which builtin tools each model family actually supports, per boundary — and
whether "supports" means the tool *runs* or merely that upstream accepts the
field.

**Probe:** `scripts/probes/tool-support.ts` — re-run when models change.
**Date:** 2026-08-04.
**Method:** two levels per (model × tool). Level 1 declares the tool and asks
for one word; only the HTTP status is recorded. Level 2 sends a prompt that
cannot be answered without the tool, then looks in the response for the item or
content-block types that prove it ran. Level 1 alone is not evidence — that
conflation is what produced the bogus `web_search` block this probe was written
to catch (`../solutions/conventions/capability-verdicts-are-scoped-to-one-boundary.md`).

**Vocabulary.** `supported` = the tool ran (server-executed) or the model
emitted a correctly-named call (client-executed). `inert` = accepted but never
invoked. `unsupported` = upstream rejected the declaration. `unmeasured` = a
capacity or gateway fault; **no verdict**, and not a synonym for unsupported.

Every accepted tool below reached `supported`. Nothing came back `inert` — on
these two boundaries, acceptance and execution agreed everywhere they could
both be measured.

## `/responses` — OpenAI Responses builtins

| Tool | gpt-5.6-terra | gpt-5.3-codex | grok-4.5 |
| --- | --- | --- | --- |
| function *(control)* | supported | supported | supported |
| `web_search` | **supported** | **supported** | **supported** |
| `web_search_2025_08_26` | **supported** | **supported** | unmeasured |
| `web_search_preview` | **supported** | **supported** | unmeasured |
| `web_search_preview_2025_03_11` | **supported** | **supported** | unmeasured |
| `custom` `apply_patch` | supported | supported | unmeasured |
| `custom` `shell` | supported | supported | unmeasured |
| `code_interpreter` | unsupported | unsupported | unsupported |
| `image_generation` | unsupported | unsupported | unsupported |
| `file_search` | unsupported | unsupported | unsupported |
| `mcp` | unsupported | unsupported | unsupported |
| `computer_use_preview` | unsupported | unsupported | unsupported |
| `local_shell` | unsupported | unsupported | unsupported |

Every rejection carries the same sentence, which is a protocol-level statement
rather than a policy one:

```
The requested tool <name> is not supported.
```

`grok-4.5`'s six `unmeasured` cells returned 503 on **four consecutive
attempts** each — sustained capacity pressure, not a blip:

```
Sorry, the upstream model provider is currently experiencing high demand.
Please try another model.
```

Those cells are blank, not negative. `grok-4.5` accepted and ran `web_search`
in the same session, so it reaches the tool layer fine; the other spellings are
simply unknown for that model today.

### The search loop is real, and it is not cheap

`gpt-5.3-codex` issued **five** `web_search_call` items in a single
`web_search_preview` run before answering, and three to four on the other
spellings. `gpt-5.6-terra` answered after one. A `max_output_tokens` sized for
a one-line reply will truncate the loop mid-flight and return
`status: incomplete`.

## `/v1/messages` — Anthropic builtins

`claude-opus-5` and `claude-sonnet-5` returned an **identical** surface.

| Tool | Verdict | Evidence |
| --- | --- | --- |
| function *(control)* | supported | `tool_use` |
| `bash_20250124` | supported | `tool_use` name=`bash` |
| `text_editor_20250728` | supported | `tool_use` name=`str_replace_based_edit_tool` |
| `memory_20250818` | supported | `tool_use` name=`memory` |
| `custom` | supported | `tool_use` name=`my_custom_tool` |
| `code_execution_20250522` | **supported** | `server_tool_use` + `code_execution_tool_result` |
| `code_execution_20250825` | **supported** | `server_tool_use` + `bash_code_execution_tool_result` |
| `code_execution_20260120` | **supported** | `server_tool_use` + `bash_code_execution_tool_result` |
| `tool_search_tool_bm25`(+`_20251119`) | **supported** | `server_tool_use` + `tool_search_tool_result` |
| `tool_search_tool_regex`(+`_20251119`) | **supported** | `server_tool_use` + `tool_search_tool_result` |
| `text_editor_20250124` | unsupported | `does not support tool types: text_editor_20250124` |
| `text_editor_20250429` | unsupported | `does not support tool types: text_editor_20250429` |
| `computer_20250124` | unsupported | `Input tag 'computer_20250124' ... does not match any` |
| `web_search_20250305` | unsupported | `The use of the web search tool is not supported.` |
| `web_search_20260209` | unsupported | `The use of the web search tool is not supported.` |
| `web_fetch_20250910` | unsupported | `rejected tool(s): web_fetch` |
| `web_fetch_20260209` | unsupported | `rejected tool(s): web_fetch` |
| `mcp_toolset` | unsupported | `Input tag 'mcp_toolset' ... does not match any` |
| `mcp-client-2025-11-20` | unsupported | `Input tag 'mcp-client-2025-11-20' ... does not match any` |

### The rejections come from three different layers

Worth separating, because they age differently:

- **`does not support tool types: X`** — the model knows the tag and declines
  it. Version-specific; a newer model may accept it.
- **`Input tag 'X' ... does not match any`** — schema-level. Upstream does not
  model the tag at all.
- **`The use of the web search tool is not supported.`** / **`rejected
  tool(s): web_fetch`** — a distinct, tool-specific refusal that reads like a
  deliberate gate rather than a missing feature.

The `code_execution` date variants are also not interchangeable: `20250522`
returns `code_execution_tool_result`, while `20250825` and `20260120` return
`bash_code_execution_tool_result`. A translator matching only the former would
silently drop the newer results.

## The two boundaries disagreed in the August 4, 2026 probe

Same day, same account, opposite answers:

| | `/responses` | `/v1/messages` |
| --- | --- | --- |
| web search | supported everywhere measured | rejected on every model |
| code execution | unsupported (`code_interpreter`) | supported (`code_execution_*`) |
| MCP | unsupported | unsupported |
| shell / patch editing | `custom` tools | `bash_*` / `text_editor_*` |

Neither boundary is a superset. Web search exists only on `/responses`; server
side code execution exists only on `/v1/messages`. "Does Copilot support X" has
no answer without naming the endpoint.

## Not covered

- `gemini-*` and the `/chat/completions`-only models. That boundary has no
  builtin tool surface to probe — it takes OpenAI function tools only.
- `gpt-5.6-luna` / `gpt-5.6-sol` / `gpt-5.4*` / `gpt-5.5` / `gpt-5-mini` /
  `mai-code-1-flash-picker`. `gpt-5.6-terra` and `gpt-5.3-codex` were probed as
  representatives; earlier sweeps showed the gpt family agreeing on the
  web-search rows, but the other builtins were not re-probed per model.
- `claude-opus-4.x` / `sonnet-4.x` / `haiku-4.5`. Only the v5 pair was probed
  here; `../messages-routing-and-translation.md` carries the older per-model
  table.
- The six `grok-4.5` cells listed `unmeasured` above.
- Whether a *rejected* tool would work if retried later. These are point-in-time
  observations; the three-layer split above is a guess at durability, not a
  measurement of it.
- Multi-tool requests. Every cell declared exactly one tool, so nothing here
  says whether combinations are accepted.

## Reproducing

```bash
bun scripts/probes/tool-support.ts --json                 # full sweep
bun scripts/probes/tool-support.ts --boundary=responses   # or: messages
bun scripts/probes/tool-support.ts --model=claude-opus-5
bun scripts/probes/tool-support.ts --accept-only          # half the quota, level 1 only
```

Sequential by design — the upstream is shared and rate-limited, and a parallel
sweep converts capability cells into 429s.

## Related

- [responses-web-search.md](responses-web-search.md) — the web-search finding
  in depth, including the `tool_choice` asymmetry and the SSE trace.
- [grok-4.5-schema.md](grok-4.5-schema.md) — the request-schema surface for the
  one xAI model.
- [../solutions/conventions/capability-verdicts-are-scoped-to-one-boundary.md](../solutions/conventions/capability-verdicts-are-scoped-to-one-boundary.md)
  — why this probe measures two levels and two boundaries.
- [../messages-routing-and-translation.md](../messages-routing-and-translation.md)
  — the per-model tables this supersedes for the v5 Claude pair.
