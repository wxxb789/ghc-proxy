import type {
  NormalizedAnthropicRequest,
  NormalizedBlock,
  NormalizedImageBlock,
  NormalizedTextBlock,
  NormalizedTurn,
} from './ir'

import type {
  AnthropicCountTokensPayload,
  AnthropicDocumentBlock,
  AnthropicMcpToolResultBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicSearchResultBlock,
  AnthropicServerToolResultBlock,
  AnthropicToolResultBlock,
  AnthropicToolResultContentBlock,
} from './types'

import { formatSearchResultBlock } from '~/translator/anthropic/search-result'
import { assertNever } from '~/util/assert-never'

function textBlock(text: string): NormalizedTextBlock {
  return { kind: 'text', text }
}

function imageBlock(
  mediaType: NormalizedImageBlock['mediaType'],
  data: string,
): NormalizedImageBlock {
  return { kind: 'image', mediaType, data }
}

function normalizeSystemBlocks(
  system: AnthropicMessagesPayload['system'],
): Array<NormalizedTurn> {
  if (!system) {
    return []
  }

  if (typeof system === 'string') {
    return [{ role: 'system', blocks: [textBlock(system)] }]
  }

  return [{
    role: 'system',
    blocks: system.map(block => textBlock(block.text)),
  }]
}

function normalizeToolResultContent(
  block: AnthropicToolResultBlock,
): Array<NormalizedTextBlock | NormalizedImageBlock> {
  return normalizeToolResultContentValue(block.content)
}

function normalizeToolResultContentValue(
  content: string | Array<AnthropicToolResultContentBlock>,
): Array<NormalizedTextBlock | NormalizedImageBlock> {
  if (typeof content === 'string') {
    return [textBlock(content)]
  }

  return content.map((contentBlock) => {
    switch (contentBlock.type) {
      case 'text':
        return textBlock(contentBlock.text)
      case 'image':
        return imageBlock(contentBlock.source.media_type, contentBlock.source.data)
      case 'search_result':
        return textBlock(formatSearchResultBlock(contentBlock))
      default:
        return assertNever(contentBlock)
    }
  })
}

function normalizeMcpToolResultContent(
  block: AnthropicMcpToolResultBlock,
): Array<NormalizedTextBlock | NormalizedImageBlock> {
  return normalizeToolResultContentValue(block.content)
}

function normalizeServerToolResultContent(
  block: AnthropicServerToolResultBlock,
): Array<NormalizedTextBlock> {
  return [textBlock(typeof block.content === 'string' ? block.content : (JSON.stringify(block.content) ?? ''))]
}

function describeDocumentBlock(block: AnthropicDocumentBlock): string {
  const sourceType = typeof block.source.type === 'string'
    ? block.source.type
    : 'unknown'
  return `[document attachment omitted: ${sourceType}]`
}

function normalizeSearchResultBlock(block: AnthropicSearchResultBlock): NormalizedTextBlock {
  return textBlock(formatSearchResultBlock(block))
}

function normalizeMessage(message: AnthropicMessage): NormalizedTurn {
  if (typeof message.content === 'string') {
    return {
      role: message.role,
      blocks: [textBlock(message.content)],
    }
  }

  const blocks: Array<NormalizedBlock> = message.content.map((block) => {
    switch (block.type) {
      case 'text':
        return textBlock(block.text)
      case 'image':
        return imageBlock(block.source.media_type, block.source.data)
      case 'search_result':
        return normalizeSearchResultBlock(block)
      case 'thinking':
        return {
          kind: 'thinking',
          thinking: block.thinking,
          signature: block.signature,
        }
      case 'redacted_thinking':
        return {
          kind: 'redacted_thinking',
          data: block.data,
        }
      case 'tool_use':
      case 'server_tool_use':
      case 'mcp_tool_use':
        return {
          kind: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        }
      case 'tool_result':
        return {
          kind: 'tool_result',
          toolUseId: block.tool_use_id,
          content: normalizeToolResultContent(block),
          isError: block.is_error,
        }
      case 'mcp_tool_result':
        return {
          kind: 'tool_result',
          toolUseId: block.tool_use_id,
          content: normalizeMcpToolResultContent(block),
          isError: block.is_error,
        }
      case 'server_tool_result':
      case 'web_search_tool_result':
      case 'web_fetch_tool_result':
      case 'code_execution_tool_result':
      case 'bash_code_execution_tool_result':
      case 'text_editor_code_execution_tool_result':
      case 'tool_search_tool_result':
        return {
          kind: 'tool_result',
          toolUseId: block.tool_use_id,
          content: normalizeServerToolResultContent(block),
          isError: block.is_error,
        }
      case 'document':
        return textBlock(describeDocumentBlock(block))
      default:
        return assertNever(block)
    }
  })

  return { role: message.role, blocks }
}

function normalizeToolChoice(
  toolChoice: AnthropicMessagesPayload['tool_choice'],
): NormalizedAnthropicRequest['toolChoice'] {
  if (!toolChoice) {
    return undefined
  }

  switch (toolChoice.type) {
    case 'none':
      return { type: 'none' }
    case 'auto':
      return { type: 'auto' }
    case 'any':
      return { type: 'required' }
    case 'tool':
      return toolChoice.name
        ? { type: 'tool', name: toolChoice.name }
        : undefined
  }
}

function normalizeThinking(
  thinking: AnthropicMessagesPayload['thinking'],
): NormalizedAnthropicRequest['thinking'] {
  if (!thinking) {
    return undefined
  }

  switch (thinking.type) {
    case 'disabled':
      return { type: 'disabled' }
    case 'adaptive':
      return { type: 'adaptive' }
    case 'enabled':
      return { type: 'enabled', budgetTokens: thinking.budget_tokens }
  }
}

export function normalizeAnthropicRequest(
  payload: AnthropicMessagesPayload | AnthropicCountTokensPayload,
): NormalizedAnthropicRequest {
  return {
    model: payload.model,
    turns: [
      ...normalizeSystemBlocks(payload.system),
      ...payload.messages.map(normalizeMessage),
    ],
    maxTokens: payload.max_tokens,
    stopSequences: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    topP: payload.top_p,
    topK: payload.top_k,
    userId: payload.metadata?.user_id,
    tools: payload.tools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    })),
    toolChoice: normalizeToolChoice(payload.tool_choice),
    thinking: normalizeThinking(payload.thinking),
    serviceTier: payload.service_tier,
  }
}
