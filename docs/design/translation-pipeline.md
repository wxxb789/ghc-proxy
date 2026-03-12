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
[Anthropic Normalizer]     anthropic-normalizer.ts
        |
        v
Normalized Anthropic IR    ir.ts (NormalizedAnthropicRequest)
        |
        v
[Anthropic-OpenAI Mapper]  anthropic-openai-mapper.ts
        |
        v
CAPI Chat Completions Payload

---

             Response Direction (OpenAI -> Anthropic)
             ========================================

CAPI Chat Completion Response
        |
        v
[OpenAI Normalizer]        openai-normalizer.ts
        |
        v
Normalized OpenAI Response  ir.ts (NormalizedOpenAIResponse)
        |
        v
[OpenAI-Anthropic Mapper]  openai-anthropic-mapper.ts
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
    | NormalizedToolUseBlock // { kind: 'tool_use', id, name, input }
    | NormalizedToolResultBlock // { kind: 'tool_result', toolUseId, content, isError? }

interface NormalizedTurn {
  role: 'system' | 'user' | 'assistant' | 'tool'
  blocks: NormalizedBlock[]
  meta?: NormalizedTurnMeta // reasoning_opaque, encrypted_content, phase, etc.
}
```

### Normalization (Layer 1)

**Anthropic Normalizer** (`anthropic-normalizer.ts`):
- Flattens Anthropic content blocks into `NormalizedBlock[]`
- Splits multi-block assistant turns preserving block order
- Extracts thinking configuration
- Preserves tool choice semantics

**OpenAI Normalizer** (`openai-normalizer.ts`):
- Converts OpenAI choice + message into `NormalizedTurn`
- Reconstructs tool calls into `NormalizedToolUseBlock`
- Maps `reasoning_text` into `NormalizedThinkingBlock`
- Preserves CAPI-extended fields in turn metadata

### Mapping (Layer 2)

**Anthropic -> OpenAI Mapper** (`anthropic-openai-mapper.ts`):
- Converts `NormalizedTurn[]` into OpenAI `Message[]`
- Maps system turns to system messages
- Converts images to `image_url` with data URIs
- Flattens tool_use into OpenAI `tool_calls` array
- Records translation issues via `TranslationContext`

Key lossy translations:
- Thinking history blocks: preserved in IR but omitted from upstream (reasoning cannot be prompted in Chat format)
- Text/tool_use interleaving: flattened (OpenAI puts tool_calls at end of message)
- Adaptive thinking: mapped to `reasoning_effort: medium` with hardcoded budget

**OpenAI -> Anthropic Mapper** (`openai-anthropic-mapper.ts`):
- Converts single OpenAI choice to Anthropic content blocks
- Maps `tool_calls` to `tool_use` blocks
- Maps `finish_reason` to Anthropic `stop_reason`
- Maps `content_filter` to Anthropic refusal
- Uses index-0 only when multiple choices returned

### Streaming (Layer 3)

**Stream Translator** (`anthropic-stream-translator.ts`):
- Orchestrates stream event translation
- Manages content block indexing across the response
- Emits Anthropic protocol events: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`

**Stream Transducer** (`anthropic-stream-transducer.ts`):
- Per-index delta buffering
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

Issue classifications:
- **exact** -- semantics fully preserved
- **lossy** -- best-effort conversion with some loss (recorded as warning)
- **unsupported** -- cannot be translated (400 error in strict mode)

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
| User `tool_result`                 | `function_call_output`       |
| Assistant text                     | `message { role: assistant, content: [output_text] }` |
| Assistant `tool_use`               | `function_call`              |
| Assistant reasoning (with signature) | `reasoning` (with encrypted_content + id) |
| Compaction carrier                 | `compaction` item            |
| `thinking: disabled`              | `reasoning.effort = none`    |
| `thinking: adaptive`              | `reasoning.effort = medium`  |
| `thinking: { budget_tokens }`     | `reasoning.effort` derived   |

### Signature Codec

The signature codec (`signature-codec.ts`) handles opaque state preservation:

- **Encryption**: Thinking content + signature -> encrypted content + item ID
- **Decryption**: Encrypted content + item ID -> thinking content + signature
- Allows reasoning state to round-trip through the Responses format without the proxy needing to understand the content

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
- Completed function calls are never reopened
- Excessive whitespace-only argument streams → `error` event
- Unfinished streams → terminal `error` event

## Conversation Model

Both pipelines use an internal conversation model as their intermediate representation for the adapter layer:

```typescript
interface ConversationRequest {
  model: string
  turns: ConversationTurn[] // Ordered message exchange
  maxTokens?: number
  tools?: ConversationTool[]
  toolChoice?: ConversationToolChoice
  thinking?: ConversationThinkingConfig
  completionOptions?: CompletionOptions
}

interface ConversationTurn {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  blocks: ConversationBlock[] // Fine-grained content blocks
  meta?: ConversationTurnMeta // CAPI-extended fields
}
```

The conversation model serves as the bridge between the normalized Anthropic form and the CAPI execution plan.

## Token Usage Translation

All three translation paths preserve upstream token usage. No synthetic or estimated usage data is injected into API responses.

### Chat Completions Path

`mapOpenAIUsageToAnthropic()` in `src/translator/anthropic/shared.ts` converts OpenAI-format usage:

```text
OpenAI                              Anthropic
─────                               ─────────
prompt_tokens - cached_tokens   →   input_tokens
completion_tokens               →   output_tokens
prompt_tokens_details.cached    →   cache_read_input_tokens (when present)
```

For streaming, usage arrives in the final `data: [DONE]`-preceding chunk when `stream_options.include_usage` is set. The stream translator emits it in `message_delta`.

### Responses Path

`mapResponsesUsage()` in `src/translator/responses/responses-to-anthropic.ts` converts Responses-format usage:

```text
Responses                           Anthropic
─────────                           ─────────
input_tokens - cached_tokens    →   input_tokens
output_tokens                   →   output_tokens
input_tokens_details.cached     →   cache_read_input_tokens (when present)
```

For streaming, `ResponsesStreamTranslator` extracts usage from the `response.created` event and emits it in `message_start`. See `src/translator/responses/responses-stream-translator.ts:117-133`.

### Native Messages Path

No translation needed. The upstream response already contains Anthropic-format usage fields and is forwarded as-is.

### Streaming Usage Opt-in

Streaming usage for the Chat Completions path requires `stream_options: { include_usage: true }`. This is configured per CAPI profile (`src/core/capi/profile.ts`): enabled for Claude models (`claudeProfile.includeUsageOnStream = true`), disabled for others.
