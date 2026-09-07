# Copilot Token Usage

Research into whether GitHub Copilot's backend returns token usage information, and how ghc-proxy handles it.

**Generation-usage observation recorded:** 2026-03-30. **Implementation
alignment checked:** 2026-09-06. The generation examples remain a dated
observation rather than a claim about future provider behavior. A separate,
bounded input-count capability probe was run on 2026-09-06 and is identified
explicitly below; it did not generate completions.

## Summary

Copilot returned token usage data across all three API paths in the recorded
observation. Response usage translation uses those upstream values; it does not
substitute local estimates. `gpt-tokenizer` is retained for Anthropic
`count_tokens`, Responses emulator input-token estimation, and packaged
selfcheck probes. Chat Completions no longer runs local tokenization for
diagnostic logging. The public
`POST /v1/responses/input_tokens` route is an upstream passthrough by default;
it uses the local estimator only when the official Responses emulator is
enabled. Passthrough is a transport behavior, not proof that every Copilot
account and model implements the upstream resource.

## Upstream Usage by Endpoint

### Chat Completions (`/chat/completions`)

Copilot returns standard OpenAI usage in the response:

```json
{
  "usage": {
    "prompt_tokens": 1234,
    "completion_tokens": 567,
    "prompt_tokens_details": {
      "cached_tokens": 200
    }
  }
}
```

When proxied to an Anthropic client, `mapOpenAIUsageToAnthropic()` in `src/translator/anthropic/shared.ts` maps these fields:

| OpenAI Field | Anthropic Field | Notes |
|---|---|---|
| `prompt_tokens - cached_tokens` | `input_tokens` | Cache-adjusted |
| `completion_tokens` | `output_tokens` | Direct mapping |
| `prompt_tokens_details.cached_tokens` | `cache_read_input_tokens` | Present whenever the upstream field exists, including `0`; omitted only when absent |

### Responses API (`/v1/responses`)

Copilot returns Responses-format usage:

```json
{
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 567,
    "input_tokens_details": {
      "cached_tokens": 200
    }
  }
}
```

`mapResponsesUsage()` in `src/translator/responses/responses-to-anthropic.ts` maps these fields:

| Responses Field | Anthropic Field | Notes |
|---|---|---|
| `input_tokens - cached_tokens` | `input_tokens` | Cache-adjusted |
| `output_tokens` | `output_tokens` | Direct mapping |
| `input_tokens_details.cached_tokens` | `cache_read_input_tokens` | Present whenever the upstream field exists, including `0`; omitted only when absent |
| `input_tokens_details.cache_write_tokens` | `cache_creation_input_tokens` | Present only when non-zero |

For Anthropic translation of a Responses stream,
`ResponsesStreamTranslator` maps the preliminary usage on `response.created`
into `message_start`. It then maps the terminal usage from
`response.completed` or `response.incomplete` into the final
`message_delta`, immediately before `message_stop`. The terminal event is the
final usage report; the initial event is not treated as a substitute for it.
The initial translator normalizes a missing cached count to zero and emits
`cache_read_input_tokens: 0`; the terminal mapping distinguishes an absent
field from an upstream field explicitly set to zero.

For a client calling `/v1/responses` directly, the proxy uses the Responses
passthrough strategy and preserves upstream SSE rather than translating it to
Anthropic events.

### Native Messages (`/v1/messages`)

When Copilot supports native Anthropic messages (direct passthrough), the response already contains Anthropic-format usage fields. No translation is needed -- the response is forwarded as-is.

## Streaming Usage Opt-in

For the Chat Completions path, streaming usage requires explicit opt-in via `stream_options`:

```json
{
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
```

This is configured per CAPI profile in `src/core/capi/profile.ts`. All profiles set `includeUsageOnStream: true`, meaning streaming usage is automatically requested for all models.

When a Chat Completions stream is translated to Anthropic, the last
usage-bearing upstream chunk is retained and emitted on the final
`message_delta`. `message_start` may carry the usage available on the first
chunk, with `output_tokens` forced to `0`; it is the final delta that carries
the completed count when upstream supplies it.

## Local Tokenization (`gpt-tokenizer`)

Local tokenization is not involved in response usage reporting. It has three
current consumers:

1. `POST /v1/messages/count_tokens` estimates an Anthropic request locally.
2. Responses emulator mode estimates `POST /v1/responses/input_tokens`
   locally from the effective input-item JSON. The default, non-emulator route
   forwards the request to Copilot's upstream Responses input-token API instead.
3. `selfcheck` exercises tokenizer loading in packaged Bun and Node builds.

The Chat Completions handler now performs only output-token defaulting and the
model-specific `max_tokens` rename after model selection. It does not import,
load, or await `gpt-tokenizer`, including on overload fallback preparation.

`gpt-tokenizer` is declared as a dev dependency so source development and builds
can resolve it without installing a redundant copy with the published package.
The build still bundles all five tokenizer encodings because the retained local
counting and selfcheck paths need them.

### How `count_tokens` Works

1. The Anthropic `count_tokens` payload is translated to an OpenAI chat-completions payload
2. `getTokenCount()` in `src/lib/tokenizer.ts` uses `gpt-tokenizer` to estimate token counts locally
3. If tools are present, a family-specific fixed overhead is added: **Claude
   346**, **Grok 480**, **GPT 346** tokens. Claude Code requests containing an
   `mcp__*` tool skip that extra fixed overhead. The typed
   `browser_toolset_20260801` and `computer_toolset_20260801` definitions instead
   use conservative documented costs of **7,550** and **4,590** tokens; these
   avoid the severe undercount produced by serializing only the compact toolset
   declaration.
4. The handler sums the estimated input and assistant-output tokens, then
   applies a family correction factor: **Claude 1.15x**, **Grok 1.03x**, or
   **GPT 1.10x**, rounding the final result.

The encoder comes from the selected model's advertised tokenizer and falls
back to `o200k_base` when the value is missing or unsupported. The fixed
overheads and correction factors are local calibration policy, not upstream
usage and not official tokenizer contracts. The two toolset constants are
conservative ceilings derived from Anthropic's August 2026 toolset token tables;
browser includes all optional members.

Anthropic `count_tokens` remains local because the proxy does not route that
Anthropic-shaped preflight request to an upstream Messages token-counting API.
The default Responses route still attempts Copilot's upstream
`/responses/input_tokens` resource, but availability is account- and
model-dependent and is not established by the presence of the proxy client
method.

### September 6, 2026 Count Capability Gate

An approved bounded probe used the default account, made five HTTP requests in
total, and made zero generation requests. Its model inventory did not contain
`claude-sonnet-5`. For the advertised `gpt-5.5` model, raw Copilot
`/responses/input_tokens` returned `404`.

This fails the replacement gate: neither a usable Responses count operation for
the tested model nor coverage for the requested Messages model was established.
The local count endpoints, tokenizer implementation, five bundled encodings,
and packaged selfcheck probes therefore remain in place. This result concerns
preflight counting capability; it does not revise the dated generation-usage
observations above.

`estimateSerializedTokens()` is intentionally simpler than the Anthropic
counter: in emulator mode it encodes `JSON.stringify(effectiveInputItems)` and
does not apply the family factors or fixed tool overhead above.

## Summary Table

| Path | Upstream Returns Usage? | Translation Function | Streaming Usage |
|---|---|---|---|
| Chat Completions | Yes (OpenAI format) | `mapOpenAIUsageToAnthropic()` | Opt-in via `stream_options` |
| Responses API | Yes (Responses format) | `mapResponsesUsage()` | Preliminary usage may appear in `response.created`; final usage comes from `response.completed` / `response.incomplete` and is emitted in the terminal Anthropic `message_delta` |
| Native Messages | Yes (Anthropic format) | None (passthrough) | Included natively |
| Anthropic `count_tokens` | N/A (local estimation) | `getTokenCount()` + family overhead/factor | N/A |
| Responses `input_tokens` (default) | Passthrough attempted; bounded 2026-09-06 `gpt-5.5` probe returned `404` | None (passthrough) | N/A |
| Responses `input_tokens` (emulator) | N/A (local estimation) | `estimateSerializedTokens()` | N/A |
