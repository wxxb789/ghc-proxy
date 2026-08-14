# Gemini web search and API schema support on GHC

* **Date:** 2026-08-14
* **Boundary:** raw GitHub Copilot upstream, bypassing ghc-proxy request
  validation, translation, and parameter filtering
* **Endpoint:** the Copilot token-provided
  `https://api.enterprise.githubcopilot.com`
* **Question:** whether the current Gemini family exposes a server-side web
  search tool, and whether it accepts Google-native, OpenAI Responses, or
  Anthropic schemas in addition to OpenAI Chat Completions

## Verdict

The current Gemini family on GHC does **not** expose a functional built-in web
search or Google Search grounding tool.

All four models are OpenAI **Chat Completions-only**:

* `gemini-3.1-pro-preview`
* `gemini-3.5-flash`
* `gemini-3.6-flash`
* `gemini-3.7-flash`

They can emit ordinary client-executed function calls, including a function
named `web_search`. That is not server-side search: the caller must execute the
function and send the result back.

GHC does not expose any of the Google-native Gemini API surfaces tested:
`generateContent`, Gemini Interactions, or the `google_search` built-in. It also
does not route these models through OpenAI Responses or Anthropic Messages.

## Advertised model surface

Every current Google model record advertised exactly:

```json
{
  "supported_endpoints": ["/chat/completions"],
  "supports": {
    "tool_calls": true,
    "parallel_tool_calls": true,
    "streaming": true,
    "vision": true
  }
}
```

`tool_calls: true` means ordinary function calling. It does not advertise a
provider-hosted tool runtime or search grounding.

## Built-in search matrix

The functional prompt requested the latest stable Bun release as of Friday,
August 14, 2026, required a source citation, and instructed the model to reply
`NO_SERVER_SEARCH` if no provider-hosted search ran.

| Model | `tools:[{type:"web_search"}]` | `tools:[{type:"google_search"}]` | `tools:[{google_search:{}}]` | `web_search_options` | Function named `web_search` |
| --- | --- | --- | --- | --- | --- |
| `gemini-3.1-pro-preview` | inert, `NO_SERVER_SEARCH` | inert, `NO_SERVER_SEARCH` | inert, `NO_SERVER_SEARCH` | inert, `NO_SERVER_SEARCH` | emitted client `tool_calls` |
| `gemini-3.5-flash` | no search trace; generation ended `finish_reason:error` | no search trace; generation ended `finish_reason:error` | no search trace; generation ended `finish_reason:error` | no search trace; generation ended `finish_reason:error` | emitted client `tool_calls` |
| `gemini-3.6-flash` | inert, `NO_SERVER_SEARCH` | inert, `NO_SERVER_SEARCH` | inert, `NO_SERVER_SEARCH` | inert, `NO_SERVER_SEARCH` | emitted client `tool_calls` |
| `gemini-3.7-flash` | inert, `NO_SERVER_SEARCH` | inert, `NO_SERVER_SEARCH` | inert, `NO_SERVER_SEARCH` | inert, `NO_SERVER_SEARCH` | emitted client `tool_calls` |

No successful search-shaped request returned any of the evidence required for
a built-in-tool verdict:

* no `google_search_call`
* no `google_search_result`
* no `web_search_call`
* no grounding metadata
* no citation or source structure
* no search-dependent answer

### The `tool_choice` asymmetry

Without `tool_choice`, the Chat endpoint accepted `web_search` and
`google_search` type objects but ignored them. With `tool_choice: "auto"`, all
four models returned:

```text
400 tools are required when tool choice is specified.
```

The likely boundary behavior is that the Chat tool parser discards tool types
other than `function`; `tool_choice` then observes an empty effective tool
list. Either way, it is not built-in search support.

### Function control

Every model correctly emitted a standard client-owned call when given:

```json
{
  "type": "function",
  "function": {
    "name": "web_search",
    "parameters": {
      "type": "object",
      "properties": { "query": { "type": "string" } },
      "required": ["query"]
    }
  }
}
```

The result shape was `choices[0].message.tool_calls` with
`finish_reason: "tool_calls"`. No search was executed by GHC. This control
proves the model and harness reached the tool-calling layer while separating
client function calling from provider-hosted grounding.

### Gemini 3.5 Flash qualification

`gemini-3.5-flash` successfully answered a simple text control with `OK` and
successfully emitted the client function call. Search-demanding prompts,
including no-tool controls, repeatedly returned HTTP 200 with
`finish_reason: "error"`, empty text, and no search trace. Its row is therefore
not a positive unsupported-tool error; it is an unsuccessful functional probe
with no evidence of built-in search. The family-level protocol results still
match the other three models.

## API schema matrix

| API/schema | Result | Evidence |
| --- | --- | --- |
| OpenAI Chat Completions | **Supported** | All four models completed text and function-call controls |
| OpenAI Responses | **Unsupported** | `gemini-3.7-flash` returned 400 `does not support Responses API` for both `web_search` and `google_search` |
| Anthropic Messages | **Unsupported** | All four returned 400 `no model endpoints available given user constraints` |
| Google `v1beta/models/{model}:generateContent` | **Not exposed** | All four returned 404 |
| Google `v1/models/{model}:generateContent` | **Not exposed** | Representative returned 404 |
| Bare `models/{model}:generateContent` | **Not exposed** | Representative returned 405 |
| Gemini Interactions `/interactions` | **Not exposed** | 404 |
| Gemini Interactions `/v1/interactions` | **Not exposed** | 404 |
| Gemini Interactions `/v1beta/interactions` | **Not exposed** | 404 |
| Google `generateContent` body sent to Chat endpoint | **Rejected** | 400 `messages must be non-empty` |

The provider identity therefore does not determine the public schema. On GHC,
Gemini models are served through the OpenAI Chat contract only; Google-native
`contents[].parts[]`, `generationConfig`, Gemini Interactions, and Anthropic
Messages are not alternate interfaces.

## Native Google control

Direct Gemini APIs do support Google Search grounding, but on different
provider-owned surfaces:

* Gemini Interactions declares `tools: [{"type":"google_search"}]` and returns
  `google_search_call`, `google_search_result`, and citation outputs.
* Gemini `generateContent` uses the Google-native `contents[].parts[]` body and
  the built-in tool shape `tools: [{"google_search": {}}]`.

Those native capabilities cannot be inferred from the model name when the
model is hosted by Copilot. The GHC boundary must expose both the endpoint and
the execution runtime, and it currently exposes neither.

Primary controls:

* [Google Search grounding](https://ai.google.dev/gemini-api/docs/google-search)
* [Gemini Interactions](https://ai.google.dev/gemini-api/docs/interactions)
* [GenerateContent API](https://ai.google.dev/api/generate-content)
* [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)

## Experiment method

The existing proxy on port 4141 was not used. A loopback-only raw-forward
experiment service ran on port 44532 and used
[`scripts/lib/probe-harness.ts`](../../scripts/lib/probe-harness.ts) to send
the supplied JSON directly to Copilot upstream. The initial model-enumeration
instance used port 44531 and was stopped before the full matrix started.

Requests ran sequentially. Transient capacity and gateway statuses would have
been retried and recorded as unmeasured rather than unsupported. No transient
status occurred in this matrix.

