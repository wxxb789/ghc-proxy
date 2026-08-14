# xAI API capability matrix: native platform vs GHC upstream

* **As of:** 2026-08-14
* **Source policy:** xAI primary sources (`docs.x.ai` and `x.ai/news`) plus
  direct GitHub Copilot upstream experiments
* **Purpose:** identify the best API for Grok generally, then measure which
  parts GitHub Copilot/GHC actually exposes for `grok-4.5`

## Executive verdict

The best general-purpose interface for current Grok models is xAI's
OpenAI-compatible **Responses API** at `POST https://api.x.ai/v1/responses`.
xAI explicitly recommends it over Chat Completions, delivers new capabilities
there first, and documents native support for stateful conversations,
reasoning content, and agentic server-side tools.

The **native Python xAI SDK** is the strongest alternative when a Python
integration wants xAI's full product surface or the native gRPC transport. xAI
says the SDK uses gRPC for optimal performance and spans products beyond text
inference, including Collections, Voice, and management APIs. For ordinary
REST applications and broad SDK interoperability, Responses remains the
better default.

The other surfaces are narrower:

* **OpenAI Chat Completions is deprecated.** It remains usable for legacy text
  and client-side function calling, but xAI documents no agentic server-side
  tools, no returned reasoning content, no stateful continuation, and limited
  future updates on that endpoint.
* **Anthropic compatibility is fully deprecated.** The `/v1/messages` and
  `/v1/complete` compatibility endpoints remain in the REST reference, but xAI
  explicitly directs users to Responses or gRPC.
* **Dedicated xAI media and realtime APIs** are best for direct image, video,
  and voice generation. The Responses API's `image_generation` tool is useful
  when image creation is one step in a larger agentic conversation, not when
  the caller needs precise media controls.

This is a native xAI baseline, not evidence that GitHub Copilot exposes the
same provider-side systems. A Grok model slug, a 200 response, or acceptance of
a same-named tool is insufficient proof of xAI-native search, code execution,
image generation, MCP, or multi-agent research.

Sources: [Responses vs Chat Completions](https://docs.x.ai/developers/model-capabilities/text/comparison),
[Generate Text](https://docs.x.ai/developers/model-capabilities/text/generate-text),
[Legacy & Deprecated](https://docs.x.ai/developers/rest-api-reference/inference/legacy),
[Tools Overview](https://docs.x.ai/developers/tools/overview).

## Live GHC upstream verdict

For the GitHub Copilot backend measured on 2026-08-14, the answer is narrower
than the native xAI answer:

> Use the **OpenAI Responses API shape**. GHC advertises `grok-4.5` only on
> `/responses`; Chat Completions and Anthropic Messages are not alternate Grok
> surfaces. xAI's native SDK/gRPC, media endpoints, and multi-agent models are
> not exposed by this GHC integration.

The current model record contains exactly one xAI model: `grok-4.5`, with
`/responses` as its only supported endpoint. It advertises a 500k context
window, 128k maximum output, one JPEG/PNG image, streaming, structured output,
parallel tool calls, tool calls, vision, and reasoning effort `low` / `medium`
/ `high`.

### Endpoint matrix

| Raw Copilot endpoint | Result | Upstream evidence |
| --- | --- | --- |
| `/responses` | **Supported** | 200 `status=completed` |
| `/chat/completions` | **Unsupported for Grok** | 400 `model "grok-4.5" is not accessible via the /chat/completions endpoint` |
| `/v1/chat/completions` | **Not exposed** | 404 |
| `/v1/messages` | **Unsupported for Grok** | 400 `no model endpoints available given user constraints` |
| xAI native SDK/gRPC | **Not a GHC surface** | Copilot exposes HTTP model endpoints, not xAI's native transport |
| `/images/generations` and `/v1/images/generations` | **Not exposed** | 404 on both paths |

### Capability matrix on GHC `grok-4.5`

| Capability | GHC verdict | Functional evidence |
| --- | --- | --- |
| Client function calling | **Supported** | Returned `function_call` with schema-valid `get_weather` arguments |
| Parallel function calls | **Supported** | One response returned both `add` and `multiply` calls |
| Strict structured output | **Supported** | Strict JSON Schema produced `{"answer":42,"verified":true}` |
| Server-side Web Search | **Supported** | Returned `web_search_call` items and URL citation |
| Server-side X Search | **Supported** | `x_search` produced a completed Copilot-specific `custom_tool_call` named `x_keyword_search`, then a direct `x.com` citation without a client tool-result round trip; official handle filters were not reliably enforced |
| Vision input | **Supported** | PNG containing `GHC42` was transcribed exactly |
| Streaming | **Supported** | SSE contained `response.created`, text deltas, and `response.completed` |
| Encrypted reasoning | **Supported** | `include: ["reasoning.encrypted_content"]` returned `encrypted_content` on the reasoning item |
| Server-side code execution | **Unsupported** | 400 `The requested tool code_interpreter is not supported.` |
| Conversational image generation | **Unsupported** | 400 `The requested tool image_generation is not supported.` |
| File/collection search | **Unsupported** | 400 `The requested tool file_search is not supported.` |
| Remote MCP | **Unsupported** | 400 `The requested tool mcp is not supported.` |
| Stored Responses | **Unsupported** | `store:true` returned 400 `store is not supported` |
| `previous_response_id` continuation | **Unsupported** | 400 `previous_response_id is not supported` |
| Grok 4.6 | **Unavailable** | 400: not available for Copilot integrator `vscode-chat` |
| `grok-4.20-multi-agent` research | **Unavailable** | 400 `The requested model is not supported.` |
| `grok-imagine-image-2.0` | **Unavailable** | image-generation endpoints returned 404 |

GHC's X Search result is functional but not wire-identical to native xAI.
Native xAI documents `x_search_call`; Copilot returned a completed
`custom_tool_call` named `x_keyword_search`. Because the same single upstream
request returned the final cited X content without the caller supplying a tool
result, execution ownership remained server-side. A translator that recognizes
only native `x_search_call` items would still miss this Copilot-specific shape.

One date-filtered run returned 200 but did not invoke the tool, incorrectly
claiming August 13-14, 2026 was in the future. August 13 is in the past and
August 14 is the current date for this report. A date-free prompt that
explicitly required the newest @SpaceXAI post then produced the real
`x_keyword_search` trace and direct citation in 6.1 seconds. This is why HTTP
acceptance is not the capability verdict; inspect the output trace.

In another same-task run against the same upstream, native `x_search` completed
in 11.5 seconds, while generic `web_search` restricted to `x.com` took 98.7
seconds and issued a long chain of searches and page opens. This is one
observation, not a latency benchmark, but it confirms that the dedicated X path
is behaviorally distinct from ordinary web search.

The official Responses schema places `allowed_x_handles` directly on the
`x_search` tool object, not under a `filters` object. GHC accepted that shape.
With `tool_choice: "required"`, a raw run searched `*` and returned the newest
@SpaceXAI post even though the prompt did not name the account, which is
evidence that the field reached the server-side tool. It is **not**, however,
a reliable security boundary: an end-to-end run with the same declaration
issued 27 X tool calls, including searches and citations involving other
accounts, before returning the @SpaceXAI answer. Put the handle in the prompt,
validate final citations, and do not assume `allowed_x_handles` prevents the
model's intermediate search loop from accessing other X content. Also note
that `tool_choice: "required"` can expand into a long, expensive tool loop;
`auto` plus an explicit tool-use prompt produced the concise one-call path.

### Reasoning effort on GHC

The upstream-advertised list is a safe subset, not the exact accepted set:

| `reasoning.effort` | Result |
| --- | --- |
| `none` | 400: not supported |
| `minimal` | **200**, accepted but not advertised |
| `low` | 200 |
| `medium` | 200 |
| `high` | 200 |
| `xhigh` | **200**, accepted but not advertised |
| `max` | 400: invalid effort |

Every successful effort returned a reasoning item and non-zero reasoning-token
usage. These are raw-upstream results; ghc-proxy's public Responses handler can
clamp ranked effort values to advertised metadata, so an end-to-end request
through the normal proxy is not evidence of the upstream's exact effort set.

### Experiment boundary

The user's existing proxy remained on port 4141 and was not used. Raw requests
went through temporary loopback-only raw-forward experiment services on ports
44521, 44522, and 44525. Although one process started with the `individual`
account fallback, the Copilot token's `endpoints.api` value took precedence;
the raw services ultimately targeted
`https://api.enterprise.githubcopilot.com`, the same endpoint printed by a
standard experimental start on ports 44523 and 44524.

The raw services used the authentication and header construction from
[`scripts/lib/probe-harness.ts`](../../scripts/lib/probe-harness.ts), but sent
the JSON body directly to Copilot upstream, bypassing ghc-proxy route
validation, translation, model rewrites, and parameter filters. Probes ran
sequentially, and transient capacity/gateway statuses would have been retried
instead of recorded as capability rejections.

After the upstream verdicts were fixed, ports 44523 and 44524 ran the normal
ghc-proxy Responses route as delivery checks. `POST /v1/responses` with
`x_search` passed through and returned completed `x_keyword_search` traces and
direct X citations. This confirms the recommended client route works in the
current source tree; those runs were not used as the sole evidence for the
upstream capability verdict.

## Official Copilot-specific signal

xAI announced **Grok 4.5 in GitHub Copilot** on July 28, 2026, naming the VS
Code model picker, Copilot CLI, and Copilot cloud agents. The announcement is a
model-availability statement; it does not claim that Copilot exposes xAI's
Responses contract, X Search backend, code executor, MCP runtime, image tools,
or multi-agent research.

The direct xAI baseline advanced to Grok 4.6 on August 12, 2026. xAI's Grok
4.6 announcement lists the xAI API, Grok Build, Cursor, OpenRouter, Vercel, and
Cloudflare, but does not list GitHub Copilot. That omission is not proof that
Copilot cannot add Grok 4.6 independently; it means the last Copilot-specific
xAI primary source found for this report is still the Grok 4.5 announcement.

Sources: [Grok 4.5 in GitHub Copilot](https://x.ai/news/grok-github-copilot),
[Introducing Grok 4.6](https://x.ai/news/grok-4-6).

## Capability matrix

| Capability | Best current model | Best interface | Native xAI contract and evidence | Less suitable surfaces |
| --- | --- | --- | --- | --- |
| General text, chat, coding, and agentic work | `grok-4.6` | **OpenAI-compatible Responses API**; native xAI SDK when Python/gRPC is preferred | 500k context; text and image input; text output; no text output limit; reasoning levels `low`, `medium`, `high`, `xhigh`; function calling, Web Search, X Search, and code execution | Chat Completions is deprecated; Anthropic compatibility is fully deprecated |
| Client-side function/tool calling | `grok-4.6` | **Responses API or xAI SDK** | JSON Schema tools, `tool_choice`, parallel calls by default, up to 200 function tools; caller executes results | Chat Completions can cover legacy function calling but loses the richer agentic/stateful surface |
| Server-side Web Search | `grok-4.6` | **Responses API or xAI SDK** | `web_search`; real-time search plus page browsing; domain allow/exclude filters; optional image understanding and image search; citations returned | Chat Completions has function calling only; Anthropic compatibility is deprecated |
| Server-side X search | `grok-4.6` | **Responses API or xAI SDK** | `x_search`; keyword, semantic, user, and thread search over X; handle/date filters; optional image and X-video understanding; citations returned | No equivalent is documented for Chat Completions or Anthropic compatibility |
| Server-side code execution | `grok-4.6` | **Responses API (`code_interpreter`) or xAI SDK (`code_execution`)** | Sandboxed Python with common scientific/data libraries; isolated, stateless, no external network access | A same-named client function is not the server-side executor; Chat Completions does not expose agentic built-ins |
| Reasoning effort and reasoning state | `grok-4.6` | **Responses API or xAI SDK** | `low` / `medium` / `high` (default) / `xhigh`; encrypted reasoning can be returned and carried forward; Grok 4.6 also exposes summarized reasoning streams | Chat Completions returns no reasoning content; Anthropic compatibility is deprecated |
| Conversational image generation/editing | `grok-4.6` orchestrating `grok-imagine-image-2.0` | **Responses API `image_generation` tool** | Server-side generate/edit calls, multi-step chaining, multi-turn editing, base64 image result in `image_generation_call` | The native xAI SDK and Vercel AI SDK are not listed for this conversational tool |
| Direct image generation/editing with exact controls | `grok-imagine-image-2.0` | **Dedicated Images API or native xAI SDK** | `/v1/images/generations` and image editing APIs; explicit aspect ratio, resolution, quality, and batch generation | Responses tool lets the model choose prompt/aspect ratio and is less deterministic |
| Private-document/collection RAG | `grok-4.6` | **xAI SDK (`collections_search`) or Responses API (`file_search`)** | Server-side collection search with document citations; can combine with Web Search, X Search, and code execution | Chat Completions has no documented agentic built-in equivalent |
| Remote MCP | `grok-4.6` | **xAI SDK or Responses API (`mcp`)** | xAI connects to remote Streaming HTTP/SSE MCP servers, manages tool discovery/calls, supports allowlists, auth headers, and multiple servers | Advanced patterns are not fully exposed by every wrapper SDK; Chat Completions is not the target surface |
| Single-agent deep research | `grok-4.6` | **Responses API or xAI SDK with Web/X Search and code execution** | `max_turns` governs the server-side agent loop; xAI recommends `10+` or unset for deep research | A short output cap or small turn cap can truncate research; Chat Completions cannot run the built-in loop |
| Multi-agent deep research | `grok-4.20-multi-agent` (beta) | **Responses API or xAI SDK** | 4 or 16 collaborating agents; built-in search/code/collections and remote MCP; leader synthesizes final answer | No Chat Completions; no client-side/custom function tools; `max_tokens` unsupported |
| Long-running agent loops | `grok-4.6` | **Responses API**, optionally WebSocket Responses; xAI SDK convenience APIs | `previous_response_id`, 30-day stored responses, encrypted state for ZDR/local storage, prompt caching, context compaction, and a WebSocket transport for sequential tool-heavy runs | Stateless Chat Completions requires resending history and does not receive new features first |
| Realtime voice agents | `grok-voice-think-fast-2.0` / `grok-voice-latest` | **Dedicated Speech-to-Speech WebSocket API** | Bidirectional audio, configurable reasoning, Web/X/collection/MCP/custom tools, session resumption, custom voices | This is a specialized realtime API, not the text Responses endpoint |
| Direct video generation | `grok-imagine-video-1.5` | **Dedicated Grok Imagine Video API** | Purpose-built media endpoint and model | Not a general text/agentic Responses capability |

Model selection is from xAI's current [Models](https://docs.x.ai/developers/models)
page, which recommends Grok 4.6 for everything except dedicated image, video,
and voice workloads. Grok 4.6 was added to the API in the August 2026
[Release Notes](https://docs.x.ai/developers/release-notes) and announced on
August 12, 2026 in [Introducing Grok 4.6](https://x.ai/news/grok-4-6).

## Interface comparison

| Interface | Status on xAI | Best use | Important limitations |
| --- | --- | --- | --- |
| xAI OpenAI-compatible Responses API | **Recommended** | Default REST surface for text, reasoning, state, function calling, built-in tools, MCP, image-generation-as-a-tool, and multi-agent research | Uses xAI's implementation of the OpenAI Responses shape; provider-specific fields and tool names still need exact validation |
| Native Python xAI SDK / gRPC | **First-class** | Python, optimal native transport, full xAI product coverage, verbose tool telemetry, Collections/Voice/management operations | Python-specific; object and parameter names differ from Responses (`code_execution` vs `code_interpreter`, for example) |
| OpenAI Chat Completions | **Deprecated** | Existing stateless text/function-calling integrations during migration | No server-side agentic tools, no returned reasoning content, no stored state; future features go to Responses |
| Anthropic-compatible `/v1/messages` and `/v1/complete` | **Fully deprecated** | Migration compatibility only, if still operational for the account/model | Not a target for new xAI capabilities; xAI directs users to Responses or gRPC |
| Vercel AI SDK | Supported client wrapper | Convenient JS/TS access to Responses, Web Search, X Search, code execution, and standard function loops | Some advanced tool options and the image-generation tool are not exposed; use OpenAI SDK or direct REST when missing |
| Dedicated Images/Video/Voice APIs | **First-class specialized surfaces** | Precise media generation and realtime audio | Separate protocols/models; do not infer availability from text-model access |
| Third-party gateways | Distribution option, not the native control | Convenience, billing consolidation, regional/vendor integration | xAI documents that partner feature parity may differ; direct `api.x.ai` is the control for capability testing |

## Capability details

### Function calling and mixed tools

Grok supports client-executed functions through both Responses and the native
xAI SDK. The function schema root must be an object (or a union whose branches
are objects), parallel function calls are enabled by default, and the model can
mix client-side functions with xAI server-side tools. When mixed, xAI executes
built-ins automatically but pauses and returns a `function_call` for the client
to execute.

The distinction is observable in the Responses output:

| Output item | Execution owner |
| --- | --- |
| `function_call` | Client/application |
| `web_search_call` | xAI server |
| `x_search_call` | xAI server |
| `code_interpreter_call` | xAI server |
| `file_search_call` | xAI server |
| `mcp_call` | xAI server |

This is the key control for GHC probing: a custom function named
`web_search`, `x_search`, or `code_interpreter` proves only model-generated
function calling. It does not prove that xAI's server-side implementation ran.

Sources: [Function Calling](https://docs.x.ai/developers/tools/function-calling),
[Advanced Tool Usage](https://docs.x.ai/developers/tools/advanced-usage),
[Tool Usage Details](https://docs.x.ai/developers/tools/tool-usage-details).

### Web and X search

xAI exposes two distinct server-side search systems:

* `web_search` performs real-time search and page browsing. It supports domain
  allowlists/exclusions, image understanding on browsed pages, and optional
  image search whose results can be embedded into the final response.
* `x_search` performs keyword search, semantic search, user search, and thread
  fetch over X. It supports included/excluded handles, date ranges, image
  understanding, and X-video understanding.

Both are documented on the Responses API and native xAI SDK, and both return
citations. X Search is the most provider-specific capability in this matrix:
generic web results, news articles quoting posts, or a function tool with the
same name are not equivalent to xAI's documented X data path.

Sources: [Web Search](https://docs.x.ai/developers/tools/web-search),
[X Search](https://docs.x.ai/developers/tools/x-search),
[Citations](https://docs.x.ai/developers/tools/citations).

### Server-side code execution

The native xAI name is `code_execution`; the Responses-compatible name is
`code_interpreter`. The executor is an isolated, temporary Python environment
with common packages such as NumPy, Pandas, Matplotlib, and SciPy. It has
limited filesystem access, no external network access, and does not persist
between requests.

The native control is therefore not merely whether a model emits Python. A
successful control response should contain a server-owned
`code_interpreter_call` (Responses) or corresponding native server-side tool
telemetry, and the result should affect the model's answer.

Source: [Code Execution Tool](https://docs.x.ai/developers/tools/code-execution).

### Reasoning

`grok-4.6` supports `low`, `medium`, `high` (default), and `xhigh` reasoning.
Reasoning cannot be disabled for Grok 4.6. xAI can return encrypted reasoning
state so a client can preserve it across stateless or Zero Data Retention
flows, and Grok 4.6 can stream summarized reasoning content. Reasoning tokens
are billed as output consumption.

The same semantic knob has different wire shapes:

* xAI SDK: `reasoning_effort="high"`
* Responses API: `reasoning: {"effort": "high"}`
* Vercel AI SDK: provider option `reasoningEffort`

For `grok-4.20-multi-agent`, the Responses `reasoning.effort` field selects
the agent count rather than ordinary reasoning depth: `low`/`medium` maps to 4
agents, while `high`/`xhigh` maps to 16.

Sources: [Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning),
[Grok 4.6](https://docs.x.ai/developers/grok-4-6),
[Multi Agent](https://docs.x.ai/developers/model-capabilities/text/multi-agent).

### Image generation

There are two correct paths, chosen by workflow:

1. Use Responses `image_generation` with `grok-4.6` when Grok should decide
   when to create or edit an image during a conversation. The tool can chain
   generation and editing calls and preserve generated images across turns.
2. Use the dedicated Images API with `grok-imagine-image-2.0` when the caller
   needs direct prompt, aspect-ratio, resolution, quality, or batch controls.

The conversational tool is currently documented only for the OpenAI-compatible
Responses API. Its result appears as an `image_generation_call` with base64
image data. The direct API is available through REST, the native xAI SDK, the
OpenAI SDK pointed at xAI, and supported image wrappers.

Sources: [Image Generation Tool](https://docs.x.ai/developers/tools/image-generation),
[Direct Image Generation](https://docs.x.ai/developers/model-capabilities/images/generation),
[Grok Imagine Image 2.0](https://docs.x.ai/developers/models/grok-imagine-image-2.0).

### Deep research

xAI offers two levels rather than one branded switch:

* **Single-agent research:** `grok-4.6` plus Web Search, X Search, and optionally
  code execution/collections. `max_turns` controls the number of agent-loop
  turns; xAI suggests `10+` or no caller-specified limit for deep research.
* **Realtime Multi-agent Research (beta):** `grok-4.20-multi-agent`, with 4 or
  16 collaborating agents and a leader agent that synthesizes the final
  response. It supports built-in tools and remote MCP, but not client-side
  custom functions, Chat Completions, or `max_tokens`.

Only leader output and leader-visible tool calls are returned by default. The
sub-agent state is encrypted and can be retained when the native SDK requests
encrypted content. Multi-agent requests can consume substantially more tokens
and server-side tool calls because every participating agent is billable.

Sources: [Multi Agent](https://docs.x.ai/developers/model-capabilities/text/multi-agent),
[Grok 4.20 Multi-Agent](https://docs.x.ai/developers/models/grok-4.20-multi-agent),
[Tool Usage Details](https://docs.x.ai/developers/tools/tool-usage-details).

## Distinctive native xAI features

These are the capabilities most likely to disappear or change when Grok is
served through a third-party gateway:

* **Native X Search**, including semantic/user/thread search and image/video
  understanding of X posts.
* **Realtime Multi-agent Research** with selectable 4- or 16-agent execution.
* **Remote MCP as a server-side tool**, where xAI itself connects to and
  executes tools from remote MCP servers.
* **Hybrid search across private Collections, the web, and X**, with code
  execution available in the same server-side agent loop.
* **Conversational image generation and editing** as a Responses tool, in
  addition to dedicated Imagine APIs.
* **Context compaction** into an opaque reusable item for long agent loops.
* **WebSocket Responses mode** for sequential, tool-heavy runs using the same
  Responses event model and in-memory continuation.
* **Stored or encrypted agentic state**, including reasoning and server-side
  tool state, for multi-turn continuation.
* **Realtime voice agents** that can use Web Search, X Search, Collections,
  remote MCP, and custom functions during a speech-to-speech session.

Sources: [Remote MCP](https://docs.x.ai/developers/tools/remote-mcp),
[Collections Search](https://docs.x.ai/developers/tools/collections-search),
[Context Compaction](https://docs.x.ai/developers/advanced-api-usage/context-compaction),
[WebSocket Responses Mode](https://docs.x.ai/developers/advanced-api-usage/websocket-mode),
[Speech to Speech](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech).

## Native control expectations for GHC/Copilot tests

The direct xAI API should be treated as the provider control, while GHC is a
separate boundary with its own schemas, executors, routing, and policy. Use the
following evidence levels when comparing them:

| Capability | Native xAI request | Evidence required for an equivalent GHC verdict |
| --- | --- | --- |
| Function calling | `tools: [{"type":"function", ...}]` | Correctly named function call with schema-valid arguments; client remains execution owner |
| Web Search | `tools: [{"type":"web_search"}]` | A server-side search item/event, result-dependent answer, and web citations; acceptance alone is insufficient |
| X Search | `tools: [{"type":"x_search"}]` | A server-side X search item/event plus citations resolving to X content; ordinary web/news results are not equivalent |
| Code execution | `tools: [{"type":"code_interpreter"}]` | A server-side code-execution item/event and answer derived from execution, not merely a code block or client function call |
| Image generation tool | `tools: [{"type":"image_generation"}]` | `image_generation_call`-equivalent output containing actual image data; text describing an image is not support |
| Collections search | `tools: [{"type":"file_search", ...}]` | Server-side file-search item/event and citations to the supplied collection/files |
| Remote MCP | `tools: [{"type":"mcp", ...}]` | Server-side MCP item/event and observable execution of an allowed remote tool |
| Reasoning effort | `reasoning: {"effort":"..."}` | Exact accepted levels plus observable response/usage metadata; advertised model metadata is only a starting point |
| Multi-agent research | `model: "grok-4.20-multi-agent"` on Responses | Successful model-specific execution with supported built-ins and agent-count semantics; a long single-model answer is not proof |

Run at least two levels for every tool: declaration acceptance, then a prompt
whose answer requires the tool. Inspect output item types, streaming events,
citations, and usage instead of relying on HTTP status or prose claims. Where a
GHC result differs from the native xAI control, report the exact boundary:
client validation, ghc-proxy translation, Copilot API behavior, or xAI direct.

## Primary sources

All sources below are first-party xAI material consulted for this report:

1. [Models](https://docs.x.ai/developers/models) - current model selection,
   pricing, context sizes, and recommendation to use Grok 4.6 for general work.
2. [Grok 4.6](https://docs.x.ai/developers/grok-4-6) - current flagship model,
   APIs, tools, modalities, reasoning levels, and context window.
3. [Release Notes](https://docs.x.ai/developers/release-notes) - August 2026
   API release and current platform additions.
4. [Introducing Grok 4.6](https://x.ai/news/grok-4-6) - August 12, 2026 model
   announcement and availability.
5. [Grok 4.5 in GitHub Copilot](https://x.ai/news/grok-github-copilot) - July
   28, 2026 Copilot model-availability announcement and named Copilot surfaces.
6. [Generate Text](https://docs.x.ai/developers/model-capabilities/text/generate-text) -
   Responses recommendation, xAI SDK/gRPC positioning, state, and encrypted
   reasoning continuation.
7. [Responses vs Chat Completions](https://docs.x.ai/developers/model-capabilities/text/comparison) -
   official endpoint comparison and deprecation status.
8. [Legacy & Deprecated](https://docs.x.ai/developers/rest-api-reference/inference/legacy) -
   fully deprecated Anthropic compatibility and legacy endpoints.
9. [Tools Overview](https://docs.x.ai/developers/tools/overview) - built-in vs
   client-side tools and the server-side agent loop.
10. [Function Calling](https://docs.x.ai/developers/tools/function-calling) -
   schemas, tool choice, parallel calls, and mixed tools.
11. [Advanced Tool Usage](https://docs.x.ai/developers/tools/advanced-usage) -
    client/server tool ownership and stateful agentic loops.
12. [Tool Usage Details](https://docs.x.ai/developers/tools/tool-usage-details) -
    output types, attempted vs billable calls, usage accounting, and
    `max_turns` guidance.
13. [Web Search](https://docs.x.ai/developers/tools/web-search) - web browsing,
    filters, image understanding/search, and SDK mappings.
14. [X Search](https://docs.x.ai/developers/tools/x-search) - X-native search
    modes, filters, and image/video understanding.
15. [Code Execution](https://docs.x.ai/developers/tools/code-execution) -
    server-side Python executor and API-specific tool names.
16. [Image Generation Tool](https://docs.x.ai/developers/tools/image-generation) -
    agentic generate/edit behavior in Responses.
17. [Direct Image Generation](https://docs.x.ai/developers/model-capabilities/images/generation) -
    dedicated Images API and precise generation controls.
18. [Collections Search](https://docs.x.ai/developers/tools/collections-search) -
    private RAG and hybrid internal/external research.
19. [Remote MCP](https://docs.x.ai/developers/tools/remote-mcp) - server-side
    remote MCP support and access controls.
20. [Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning) -
    reasoning levels, encrypted state, and reasoning summaries.
21. [Multi Agent](https://docs.x.ai/developers/model-capabilities/text/multi-agent) -
    beta deep-research architecture, agent counts, supported APIs, and
    limitations.
22. [Context Compaction](https://docs.x.ai/developers/advanced-api-usage/context-compaction) -
    long-run context reduction and opaque continuation item.
23. [WebSocket Responses Mode](https://docs.x.ai/developers/advanced-api-usage/websocket-mode) -
    long-lived Responses transport for tool-heavy agents.
24. [Speech to Speech](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech) -
    realtime voice model and tool surface.
