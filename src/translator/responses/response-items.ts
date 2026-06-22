import type {
  AnthropicAssistantContentBlock,
  AnthropicAssistantMessage,
  AnthropicDocumentBlock,
  AnthropicImageBlock,
  AnthropicMcpToolResultBlock,
  AnthropicMcpToolUseBlock,
  AnthropicRedactedThinkingBlock,
  AnthropicSearchResultBlock,
  AnthropicServerToolResultBlock,
  AnthropicServerToolUseBlock,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUserContentBlock,
} from '~/translator'
import type {
  ResponseFunctionCallOutputItem,
  ResponseFunctionToolCallItem,
  ResponseInputCompaction,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseInputReasoning,
  ResponseInputText,
} from '~/types'
import { formatSearchResultBlock } from '~/translator/anthropic/search-result'

import { SignatureCodec } from './signature-codec'

const MESSAGE_TYPE = 'message'

export const THINKING_TEXT = 'Thinking...'

export function translateUserContentBlock(
  block: AnthropicUserContentBlock,
): ResponseInputContent | undefined {
  switch (block.type) {
    case 'text':
      return createTextContent(block.text)
    case 'image':
      return createImageContent(block)
    case 'search_result':
      return createTextContent(formatSearchResultBlock(block))
    case 'document':
      return createDocumentContent(block)
    default:
      return undefined
  }
}

export function translateAssistantContentBlock(
  block: AnthropicAssistantContentBlock,
): ResponseInputContent | undefined {
  switch (block.type) {
    case 'text':
      return createOutputTextContent(block.text)
    default:
      return undefined
  }
}

export function flushPendingContent(
  pendingContent: Array<ResponseInputContent>,
  target: Array<ResponseInputItem>,
  message: Pick<ResponseInputMessage, 'role' | 'phase'>,
) {
  if (pendingContent.length === 0) {
    return
  }

  target.push(createMessage(message.role, [...pendingContent], message.phase))
  pendingContent.length = 0
}

export function createMessage(
  role: ResponseInputMessage['role'],
  content: string | Array<ResponseInputContent>,
  phase?: ResponseInputMessage['phase'],
): ResponseInputMessage {
  return {
    type: MESSAGE_TYPE,
    role,
    content,
    ...(role === 'assistant' && phase ? { phase } : {}),
  }
}

export function resolveAssistantPhase(
  content: AnthropicAssistantMessage['content'],
): ResponseInputMessage['phase'] | undefined {
  if (typeof content === 'string') {
    return 'final_answer'
  }
  if (!Array.isArray(content)) {
    return undefined
  }

  let hasText = false
  let hasToolUse = false
  for (const block of content) {
    if (block.type === 'text')
      hasText = true
    else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use')
      hasToolUse = true
    if (hasText && hasToolUse)
      break
  }

  if (!hasText) {
    return undefined
  }
  return hasToolUse ? 'commentary' : 'final_answer'
}

export function createTextContent(text: string): ResponseInputText {
  return { type: 'input_text', text }
}

function createOutputTextContent(text: string): ResponseInputText {
  return { type: 'output_text', text }
}

export function createImageContent(block: AnthropicImageBlock): ResponseInputImage {
  return {
    type: 'input_image',
    image_url: `data:${block.source.media_type};base64,${block.source.data}`,
    detail: 'auto',
  }
}

function createDocumentContent(block: AnthropicDocumentBlock): ResponseInputContent {
  const source = block.source
  if (source.type === 'file' && typeof source.file_id === 'string') {
    return {
      type: 'input_file',
      file_id: source.file_id,
    }
  }

  if (source.type === 'url' && typeof source.url === 'string') {
    return {
      type: 'input_file',
      file_url: source.url,
    }
  }

  if (
    source.type === 'base64'
    && typeof source.media_type === 'string'
    && typeof source.data === 'string'
  ) {
    return {
      type: 'input_file',
      file_data: `data:${source.media_type};base64,${source.data}`,
    }
  }

  if (source.type === 'text' && typeof source.data === 'string') {
    return createTextContent(source.data)
  }

  return createTextContent('[document attachment omitted]')
}

export function createReasoningContent(
  block: AnthropicThinkingBlock,
): ResponseInputReasoning {
  const { encryptedContent, id } = SignatureCodec.decodeReasoning(block.signature ?? '')
  const thinking = block.thinking === THINKING_TEXT ? '' : block.thinking
  return {
    id,
    type: 'reasoning',
    summary: thinking ? [{ type: 'summary_text', text: thinking }] : [],
    encrypted_content: encryptedContent,
  }
}

export function createRedactedReasoningContent(
  block: AnthropicRedactedThinkingBlock,
): ResponseInputReasoning {
  return {
    type: 'reasoning',
    summary: [],
    encrypted_content: block.data,
  }
}

export function createCompactionContent(
  block: AnthropicThinkingBlock,
): ResponseInputCompaction | undefined {
  const compaction = SignatureCodec.decodeCompaction(block.signature ?? '')
  if (!compaction) {
    return undefined
  }
  return {
    id: compaction.id,
    type: 'compaction',
    encrypted_content: compaction.encrypted_content,
  }
}

export function createFunctionToolCall(
  block: AnthropicToolUseBlock | AnthropicServerToolUseBlock | AnthropicMcpToolUseBlock,
): ResponseFunctionToolCallItem {
  return {
    type: 'function_call',
    call_id: block.id,
    name: block.name,
    arguments: JSON.stringify(block.input),
    status: 'completed',
  }
}

export function createFunctionCallOutput(
  block: AnthropicToolResultBlock | AnthropicMcpToolResultBlock,
): ResponseFunctionCallOutputItem {
  return {
    type: 'function_call_output',
    call_id: block.tool_use_id,
    output: convertToolResultContent(block.content),
    status: block.is_error ? 'incomplete' : 'completed',
  }
}

export function createServerFunctionCallOutput(
  block: AnthropicServerToolResultBlock,
): ResponseFunctionCallOutputItem {
  return {
    type: 'function_call_output',
    call_id: block.tool_use_id,
    output: typeof block.content === 'string' ? block.content : (JSON.stringify(block.content) ?? ''),
    status: block.is_error ? 'incomplete' : 'completed',
  }
}

export function isServerToolResultBlock(
  block: AnthropicUserContentBlock | AnthropicAssistantContentBlock,
): block is AnthropicServerToolResultBlock {
  return block.type === 'server_tool_result'
    || block.type === 'web_search_tool_result'
    || block.type === 'web_fetch_tool_result'
    || block.type === 'code_execution_tool_result'
    || block.type === 'bash_code_execution_tool_result'
    || block.type === 'text_editor_code_execution_tool_result'
    || block.type === 'tool_search_tool_result'
}

function convertToolResultContent(
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock | AnthropicSearchResultBlock>,
): string | Array<ResponseInputContent> {
  if (typeof content === 'string') {
    return content
  }

  const result: Array<ResponseInputContent> = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        result.push(createTextContent(block.text))
        break
      case 'image':
        result.push(createImageContent(block))
        break
      case 'search_result':
        result.push(createTextContent(formatSearchResultBlock(block)))
        break
      default:
        break
    }
  }

  return result
}
