# Translation Pipeline

This document describes the protocol translation architecture used when direct passthrough is not available.

## Overview

ghc-proxy translates between three API formats:

```text
Anthropic Messages  <-->  OpenAI Chat Completions
Anthropic Messages  <-->  OpenAI Responses
```

Each translation direction has its own pipeline with normalization, mapping, and streaming layers.

## Anthropic <-> Chat Completions Pipeline

Used as the fallback path when a model does not support native `/v1/messages` or `/responses`.

### Architecture Layers

```text
             Request Direction (Anthropic -> OpenAI)
             ======================================

Anthropic Messages Payload
        |
        v
[normalizeAnthropicRequest] anthropic-normalizer.ts
        |
        v
Normalized Anthropic IR    ir.ts (NormalizedAnthropicRequest)
        |
        v
[Conversation Builder]     anthropic-messages-adapter.ts
                           (normalizeAnthropicConversation,
                            toConversationTurn/toConversationBlock)
        |
        v
Conversation Model         core/conversation (ConversationRequest)
        |
        v
[CAPI Plan Builder]        core/capi/plan-builder.ts (buildCapiExecutionPlan)
        |
        v
CAPI Execution Plan        (CapiExecutionPlan -> Chat Completions payload)

---

             Response Direction (OpenAI -> Anthropic)
             ========================================

CAPI Chat Completion Response
        |
        v
[normalizeOpenAIResponse]  openai-normalizer.ts
        |
        v
Normalized OpenAI Response  ir.ts (NormalizedOpenAIResponse)
        |
        v
[mapOpenAIResponseToAnthropic]
                           openai-anthropic-mapper.ts
        |
        v
Anthropic Messages Response
```

### Intermediate Representation (IR)

The IR decouples source format parsing from target format generation. Both directions share the same block vocabulary:

```typescript
type NormalizedBlock
  = | NormalizedTextBlock // { kind: 'text', text }
    | NormalizedImageBlock // { kind: 'image', mediaType, data }
    | NormalizedThinkingBlock // { kind: 'thinking', thinking, signature? }
    | NormalizedRedactedThinkingBlock // { kind: 'redacted_thinking', data }
    | NormalizedToolUseBlock // { kind: 'tool_use', id, name, input }
    | NormalizedToolResultBlock // { kind: 'tool_result', toolUseId, content, isError? }

interface NormalizedTurn {
  role: 'system' | 'user' | 'assistant' | 'tool'
  blocks: NormalizedBlock[]
}
```

### Normalization (Layer 1)

**Anthropic Normalizer** (`anthropic-normalizer.ts`):
- Flattens Anthropic content blocks into `NormalizedBlock[]`
- Preserves one ordered normalized turn per message and prepends a normalized system turn when present
- Extracts thinking configuration
- Preserves tool choice semantics
- Coalesces Anthropic function, MCP, server-tool, and builtin-tool result variants into the shared tool block vocabulary
- Converts `search_result` and tool-result `document` blocks to formatted text; top-level document attachments become an explicit omitted-attachment marker because Chat Completions cannot represent them

**OpenAI Normalizer** (`openai-normalizer.ts`):
- Converts OpenAI choice + message into `NormalizedTurn`
- Reconstructs tool calls into `NormalizedToolUseBlock`
- Maps `reasoning_text` into `NormalizedThinkingBlock`
- Preserves CAPI-extended fields in turn metadata

### Mapping (Layer 2)

**Conversation Builder + CAPI Plan Builder** (`src/adapters/anthropic-messages-adapter.ts`, `src/core/capi/plan-builder.ts`):
- `AnthropicMessagesAdapter` calls `normalizeAnthropicConversation()` and maps each `NormalizedTurn`/`NormalizedBlock` into the internal conversation model (`toConversationTurn()`/`toConversationBlock()`)
- Converts images to data URIs (`data:<mediaType>;base64,<data>`)
- Carries tool_use blocks through with their stringified arguments; tool_result blocks become tool turns
- `buildCapiExecutionPlan()` then turns the `ConversationRequest` into a `CapiExecutionPlan` (the Chat Completions payload sent upstream)
- Records translation issues via `TranslationContext` (`recordAnthropicRequestIssues`)

Key lossy translations:
- Thinking and redacted-thinking history blocks: preserved in IR but omitted from the upstream Chat prompt (`lossy_thinking_omitted_from_prompt`)
- Text/tool_use interleaving: flattened into upstream content + `tool_calls` (`lossy_interleaving_flattened`)
- Thinking budget: an enabled budget preserves the caller's token count; adaptive thinking uses 24000 when the resolved CAPI profile supports `thinking_budget`. Unsupported profiles drop the field (`applyThinkingBudgetOverride`).
- Explicit `output_config.effort` remains separate from a budget-derived effort and takes precedence in the CAPI plan

**OpenAI -> Anthropic Mapper** (`openai-anthropic-mapper.ts`):
- Converts single OpenAI choice to Anthropic content blocks
- Maps `tool_calls` to `tool_use` blocks
- Maps `finish_reason` to Anthropic `stop_reason`
- Maps `content_filter` to Anthropic refusal
- Uses index-0 only when multiple choices returned

### Streaming (Layer 3)

**`AnthropicStreamTranslator`** (`anthropic-stream-transducer.ts`):
- Orchestrates stream event translation and content-block indexing
- Emits Anthropic protocol events: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
- Maintains per-index delta buffering
- Reconstructs tool calls from partial deltas
- Handles interleaved tool call deltas across different indexes
- Maintains independent lanes per tool call index
- Finalizes all open blocks on stream completion

### Translation Policy

The `TranslationContext` class tracks translation fidelity:

```typescript
interface TranslationPolicy {
  mode: 'best-effort' | 'strict'
}

class TranslationContext {
  record(issue: TranslationIssue, options?: { fatalInStrict?: boolean })
  getIssues(): TranslationIssue[]
}
```

Issue severity levels:
- **info** -- semantics fully preserved
- **warning** -- best-effort conversion with some semantic loss
- **error** -- cannot be translated (throws `TranslationFailure` with 400 in strict mode)

Issue `kind` strings follow a naming convention that indicates the category: `lossy_*` for warning-level semantic loss, `unsupported_*` for error-level incompatibilities.

## Anthropic <-> Responses Pipeline

Used when a model supports `/responses` but not native `/v1/messages`.

### Request Translation

```text
Anthropic Messages Payload
        |
        v
[anthropic-to-responses.ts]
        |
        v
Responses Payload
  instructions: string         <-- system
  input: ResponseInputItem[]   <-- messages mapped to items
  tools: ResponseTool[]        <-- tool schemas
  reasoning: ReasoningConfig   <-- thinking config
```

Key mappings:

| Anthropic                          | Responses                    |
|------------------------------------|------------------------------|
| `system` text                      | `instructions`               |
| User text message                  | `message { role: user, content: [input_text] }` |
| User image                         | `message { content: [input_image] }` |
| User `search_result`               | `message { content: [input_text] }` |
| User `tool_result`                 | `function_call_output`       |
| `tool_result` `search_result` content | `function_call_output` with text output |
| Assistant text                     | `message { role: assistant, content: [output_text] }` |
| Assistant `tool_use`               | `function_call`              |
| Assistant reasoning (with signature) | `reasoning` (with encrypted_content + id) |
| Compaction carrier                 | `compaction` item            |
| `thinking: disabled`              | `reasoning.effort = none`    |
| `output_config.effort`            | Same effort, clamped to advertised model levels |
| `thinking: adaptive`              | `reasoning.effort = medium`, clamped to advertised levels |
| `thinking: { budget_tokens }`     | Configured per-model effort (default `medium`), clamped to advertised levels |

The translator also forces `store: false` and `parallel_tool_calls: true`, maps
`max_tokens` to `max_output_tokens`, and rejects translated-path features that
cannot be represented safely, including `stop_sequences`, `service_tier`, and
Anthropic server tools.

### Signature Codec

The signature codec (`signature-codec.ts`) handles opaque state preservation:

- It packs an already-opaque Responses `encrypted_content` value and item ID into an Anthropic signature carrier.
- It distinguishes reasoning carriers from prefixed compaction carriers and unpacks them on the next request.
- It does not encrypt or decrypt model state; Copilot supplies the opaque encrypted content.

### Response Translation

```text
Responses Result (output items)
        |
        v
[responses-to-anthropic.ts]
        |
        v
Anthropic Messages Response
  content: ContentBlock[]
  stop_reason: string
  usage: Usage
```

### Streaming Translation

**ResponsesStreamTranslator** (`responses-stream-translator.ts`):

Stateful translator that converts Responses stream events to Anthropic stream events:

- Tracks current content block index
- Buffers function call deltas until complete
- Emits Anthropic events: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
- On error: emits Anthropic `error` event instead of breaking TCP

Error recovery guarantees:
- Malformed JSON → Anthropic `error` event
- Upstream `response.failed` / Responses `error` events → Anthropic `error` event
- Completed function calls are never reopened
- Excessive whitespace-only argument streams → `error` event
- Unfinished streams → terminal `error` event

## Conversation Model

The public Chat Completions route and the Messages Chat-Completions fallback use
the internal Conversation model. The Anthropic↔Responses path translates
directly and does not pass through this IR.

```typescript
interface ConversationRequest {
  model: string
  turns: ConversationTurn[] // Ordered message exchange
  maxTokens?: number
  stopSequences?: string[]
  stream?: boolean
  temperature?: number | null
  topP?: number | null
  topK?: number | null
  userId?: string
  tools?: ConversationTool[]
  toolChoice?: ConversationToolChoice
  thinking?: ConversationThinkingConfig
  outputEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  completionOptions?: CompletionOptions
}

interface ConversationTurn {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  blocks: ConversationBlock[] // Fine-grained content blocks
  meta?: ConversationTurnMeta // CAPI-extended fields
}
```

`ConversationBlock` includes text, image, thinking, redacted thinking, tool use,
and tool result variants. The Conversation model serves as the bridge from
either OpenAI Chat or normalized Anthropic input to the CAPI execution plan.

## Token Usage Translation

Usage on generation responses is derived from upstream counters; the tokenizer
is not used to estimate it. Translated Anthropic responses require a usage
object, so missing upstream counters are represented as zero. This is schema
completion rather than a local token estimate.

### Chat Completions Path

`mapOpenAIUsageToAnthropic()` in `src/translator/anthropic/shared.ts` converts OpenAI-format usage:

```text
OpenAI                              Anthropic
─────                               ─────────
prompt_tokens - cached_tokens   →   input_tokens
completion_tokens               →   output_tokens
prompt_tokens_details.cached    →   cache_read_input_tokens (when present)
```

For streaming, the CAPI plan requests `stream_options.include_usage`. The stream
translator keeps the final usage-only chunk before `[DONE]` and emits those
counters in `message_delta`.

### Responses Path

`mapResponsesUsage()` in `src/translator/responses/responses-to-anthropic.ts` converts Responses-format usage:

```text
Responses                           Anthropic
─────────                           ─────────
input_tokens - cached_tokens    →   input_tokens
output_tokens                   →   output_tokens
input_tokens_details.cached     →   cache_read_input_tokens (when present)
input_tokens_details.cache_write_tokens → cache_creation_input_tokens (when non-zero)
```

For streaming, `ResponsesStreamTranslator` builds `message_start` from
`response.created`, then maps the terminal response usage into `message_delta`
on `response.completed` or `response.incomplete`.

### Native Messages Path

No translation needed. The upstream response already contains Anthropic-format usage fields and is forwarded as-is.

### Streaming Usage Opt-in

Streaming usage for the Chat Completions path requires `stream_options: { include_usage: true }`. This is configured per CAPI profile (`src/core/capi/profile.ts`): enabled for all models (`includeUsageOnStream = true` in all profiles).
