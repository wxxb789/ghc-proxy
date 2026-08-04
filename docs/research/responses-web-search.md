# Web search on `/responses` (probed)

Whether Copilot's `/responses` boundary supports the OpenAI/Codex built-in
web-search tool, and whether it *actually searches* or merely accepts the field.

**Probe:** `scripts/probes/tool-support.ts` — re-run
when models change. The functional runs below were one-off scripts built on
`scripts/lib/probe-harness.ts`; the reproduction recipe is at the bottom.
**Date:** 2026-08-04.
**Method:** two levels. Level 1 declares the tool and asks for one word, and
only records the HTTP status. Level 2 asks a question that cannot be answered
from training data ("the current Bun version", "the top Hacker News story")
and inspects the `output` array for a `web_search_call` item and
`url_citation` annotations. Level 1 alone is not evidence — a model can accept
a tool it never calls.

## Verdict

`/responses` **supports web search on every model that answered**, under both
the Codex/ChatGPT built-in type `web_search` and the older
`web_search_preview`. The proxy's blanket `400 unsupported_tool_web_search`
was stale and is removed.

`/v1/messages` (Claude family) still rejects it. The two boundaries disagree,
so a claim must always name which one it is about.

## Level 1 — acceptance, every `/responses` model

`tools: [{ "type": ... }]`, `max_output_tokens: 32`:

| Model | `web_search` | `web_search_preview` |
| --- | --- | --- |
| `gpt-5-mini` | 200 | 200 |
| `gpt-5.3-codex` | 200 | 200 |
| `gpt-5.4-mini` | 200 | 200 |
| `gpt-5.4` | 200 | 200 |
| `gpt-5.5` | 200 | 200 |
| `gpt-5.6-luna` | 200 | 200 |
| `gpt-5.6-sol` | 200 | 200 |
| `gpt-5.6-terra` | 200 | 200 |
| `grok-4.5` | 200 | 503 (capacity, twice) |
| `mai-code-1-flash-picker` | 200 | 200 |

The one non-200 is `grok-4.5` × `web_search_preview`, and it is not a
capability signal:

```
Sorry, the upstream model provider is currently experiencing high demand.
Please try another model.
```

Retried once, same 503. `grok-4.5` accepted `web_search` in the same run, so
the model reaches the tool layer fine. Treat that cell as unmeasured, not
rejected.

The gpt-5.6 family additionally accepted `web_search_preview_2025_03_11` and
`web_search_2025_08_26` in an earlier pass (all three models, 200 each).

## Level 2 — it actually searches

`gpt-5.6-sol`, `tools: [{ "type": "web_search" }]`, asked for the current Bun
version. `status: completed`, output items `["reasoning", "web_search_call",
"message"]`:

```json
{
  "type": "web_search_call",
  "status": "completed",
  "action": {
    "type": "search",
    "queries": [
      "site:bun.sh blog latest Bun release version",
      "site:github.com/oven-sh/bun/releases latest Bun release"
    ]
  }
}
```

with a citation annotation on the message content:

```json
{
  "type": "url_citation",
  "url": "https://bun.sh/",
  "title": "Bun — A fast all-in-one JavaScript runtime",
  "start_index": 98,
  "end_index": 125
}
```

`gpt-5.6-terra` produced the same shape; its citation URL carried
`?utm_source=openai`, which is OpenAI's own search backend tagging the link —
not a URL the model could have invented.

An earlier `web_search_preview` run against `gpt-5.6-sol` hit
`max_output_tokens` after **12** consecutive `web_search_call` items and
returned `status: incomplete`. Worth stating explicitly: the tool runs a real
search loop, and a stingy `max_output_tokens` truncates it mid-loop.

## `tool_choice` is narrower than `tools`

`gpt-5.6-terra`, forcing the tool via `tool_choice: { "type": ... }`:

| `tool_choice.type` | Result |
| --- | --- |
| `web_search` | 200, emitted `web_search_call` |
| `web_search_preview` | 200, emitted `web_search_call` |
| `web_search_preview_2025_03_11` | **400** |
| `web_search_2025_08_26` | **400** |

```
Missing required parameter: 'tool_choice.tools'.
```

The dated variants are usable in `tools` but not as a bare `tool_choice` —
upstream reads them as the `allowed_tools` shape and wants a `tools` array.
That is an upstream-stated constraint in its own error text, so the proxy
forwards it rather than reimplementing the rule.

## `/v1/messages` is the opposite answer

`claude-opus-5` and `claude-sonnet-5`, `tools: [{ "type": "web_search_...",
"name": "web_search" }]`:

| Model | `web_search_20250305` | `web_search_20260209` |
| --- | --- | --- |
| `claude-opus-5` | 400 | 400 |
| `claude-sonnet-5` | 400 | 400 |

```
The use of the web search tool is not supported.
```

Unchanged from the 2026-07-25 snapshot in
[messages-routing-and-translation.md](../messages-routing-and-translation.md).

## Streaming carries the search events intact

`stream: true` through the proxy (`gpt-5.6-terra`, `tools: [{ "type":
"web_search" }]`) produced, in order:

```
response.created
response.in_progress
response.output_item.added
response.web_search_call.in_progress
response.web_search_call.searching
response.web_search_call.completed
response.output_item.done
response.output_item.added
response.content_part.added
response.output_text.delta        (×2)
response.output_text.annotation.added
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

The `url_citation` arrives as `response.output_text.annotation.added` carrying
`"url": "https://bun.sh/?utm_source=openai"` — the same annotation the
non-streaming path returns inline. The three `response.web_search_call.*` event
names already declared in `src/types/responses.ts` are confirmed against a live
stream.

## What this changed in the proxy

`rejectUnsupportedBuiltinTools()` in `src/routes/responses/handler.ts` threw
`400 unsupported_tool_web_search` for any `tools[].type === 'web_search'` and
for `tool_choice.type` of `web_search_preview` /
`web_search_preview_2025_03_11`. It landed in #15, consistent with the
June 2026 probe where `/v1/messages` rejected web search everywhere — but it
was applied to the `/responses` boundary, which was never the boundary that
rejected it. Removed; both now forward.

`web_search` and `web_search_2025_08_26` were also added to the `tool_choice`
enum in `src/ingest/validation/responses.ts` and `ToolChoiceBuiltin` in
`src/types/responses.ts`, which had only the `_preview` spellings.

## Not covered

- `web_fetch` on `/responses` — never probed on this boundary.
- Whether `filters` / `user_location` / `search_context_size` options on the
  tool object are honored. Only the bare `{ "type": ... }` form was sent.
- Per-request cost of a search call. `usage` reported ~8.4k input tokens for a
  one-line question, but nothing isolates the search's share of that.
- Claude models older than v5 on `/v1/messages`; only `opus-5` and `sonnet-5`
  were re-probed here.
- `grok-4.5` × `web_search_preview` — 503 capacity on both attempts, so that
  one cell is unmeasured rather than rejected.

## Reproducing

The accept/reject matrix is now part of the standing probe:

```bash
bun scripts/probes/tool-support.ts --json --model=gpt-5.6-terra
```

Level 2 needs a question whose answer is not in training data, a
`max_output_tokens` large enough for the search loop (2048 was enough; 1024
was not for `sol`), and an inspection of `output[]` for `web_search_call`
rather than of the HTTP status.

End to end through a debug proxy instance on a spare port:

```bash
bun run ./src/main.ts start --port 4142
curl -s -X POST http://127.0.0.1:4142/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.6-terra",
       "input":[{"type":"message","role":"user",
                 "content":"Search the web for the latest Bun version. Cite the URL."}],
       "max_output_tokens":2048,
       "tools":[{"type":"web_search"}],
       "store":false}'
```

Add `"stream": true` for the SSE variant.

## Related

- [../solutions/conventions/upstream-types-are-not-contract-evidence.md](../solutions/conventions/upstream-types-are-not-contract-evidence.md)
  — the governing convention. This is another instance of its exact failure
  mode: an "unsupported" verdict that outlived the observation behind it, with
  the test suite encoding the same assumption.
- [../messages-routing-and-translation.md](../messages-routing-and-translation.md)
  — the per-model tool tables for both boundaries.
