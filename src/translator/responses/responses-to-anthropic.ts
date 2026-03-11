import type {
  AnthropicAssistantContentBlock,
  AnthropicResponse,
  AnthropicToolUseBlock,
} from '~/translator'
import type {
  ResponseOutputContentBlock,
  ResponseOutputFunctionCall,
  ResponseOutputReasoning,
  ResponseOutputRefusal,
  ResponseOutputText,
  ResponseReasoningBlock,
  ResponsesResult,
} from '~/types'

import consola from 'consola'

import { encodeCompactionCarrierSignature, THINKING_TEXT } from './anthropic-to-responses'

export function translateResponsesToAnthropic(
  response: ResponsesResult,
): AnthropicResponse {
  const contentBlocks = mapOutputToAnthropicContent(response.output)
  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    content: contentBlocks.length > 0 ? contentBlocks : fallbackContentBlocks(response.output_text),
    model: response.model,
    stop_reason: mapResponsesStopReason(response),
    stop_sequence: null,
    usage: mapResponsesUsage(response),
  }
}

function mapOutputToAnthropicContent(
  output: ResponsesResult['output'],
): Array<AnthropicAssistantContentBlock> {
  const blocks: Array<AnthropicAssistantContentBlock> = []

  for (const item of output) {
    switch (item.type) {
      case 'reasoning': {
        const thinking = extractReasoningText(item)
        if (thinking) {
          blocks.push({
            type: 'thinking',
            thinking,
            signature: `${item.encrypted_content ?? ''}@${item.id}`,
          })
        }
        break
      }
      case 'function_call': {
        const toolUseBlock = createToolUseContentBlock(item)
        if (toolUseBlock) {
          blocks.push(toolUseBlock)
        }
        break
      }
      case 'message': {
        const text = combineMessageTextContent(item.content)
        if (text) {
          blocks.push({ type: 'text', text })
        }
        break
      }
      case 'compaction': {
        if (item.id && item.encrypted_content) {
          blocks.push({
            type: 'thinking',
            thinking: THINKING_TEXT,
            signature: encodeCompactionCarrierSignature({
              id: item.id,
              encrypted_content: item.encrypted_content,
            }),
          })
        }
        break
      }
    }
  }

  return blocks
}

function combineMessageTextContent(
  content: Array<ResponseOutputContentBlock> | undefined,
): string {
  if (!Array.isArray(content)) {
    return ''
  }

  let aggregated = ''
  for (const block of content) {
    if (isResponseOutputText(block)) {
      aggregated += block.text
      continue
    }
    if (isResponseOutputRefusal(block)) {
      aggregated += block.refusal
      continue
    }
    if (typeof (block as { text?: unknown }).text === 'string') {
      aggregated += (block as { text: string }).text
    }
  }
  return aggregated
}

function extractReasoningText(item: ResponseOutputReasoning): string {
  if (!item.summary || item.summary.length === 0) {
    return THINKING_TEXT
  }

  const segments: Array<string> = []
  collectReasoningSegments(item.summary, segments)
  return segments.join('').trim()
}

function collectReasoningSegments(
  blocks: Array<ResponseReasoningBlock>,
  segments: Array<string>,
) {
  for (const block of blocks) {
    if (typeof block.text === 'string') {
      segments.push(block.text)
    }
  }
}

function createToolUseContentBlock(
  call: ResponseOutputFunctionCall,
): AnthropicToolUseBlock | null {
  if (!call.name || !call.call_id) {
    return null
  }

  return {
    type: 'tool_use',
    id: call.call_id,
    name: call.name,
    input: parseFunctionCallArguments(call.arguments),
  }
}

function parseFunctionCallArguments(
  rawArguments: string,
): Record<string, unknown> {
  if (!rawArguments.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(rawArguments) as unknown
    if (Array.isArray(parsed)) {
      return { arguments: parsed }
    }
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>
    }
  }
  catch (error) {
    consola.warn('Failed to parse function call arguments', {
      error,
      rawArguments,
    })
  }

  return { raw_arguments: rawArguments }
}

function fallbackContentBlocks(
  outputText: string,
): Array<AnthropicAssistantContentBlock> {
  if (!outputText) {
    return []
  }
  return [{
    type: 'text',
    text: outputText,
  }]
}

function mapResponsesStopReason(
  response: ResponsesResult,
): AnthropicResponse['stop_reason'] {
  if (response.status === 'completed') {
    return response.output.some(item => item.type === 'function_call')
      ? 'tool_use'
      : 'end_turn'
  }

  if (response.status === 'incomplete') {
    if (response.incomplete_details?.reason === 'max_output_tokens') {
      return 'max_tokens'
    }
    if (response.incomplete_details?.reason === 'content_filter') {
      return 'end_turn'
    }
  }

  return null
}

function mapResponsesUsage(
  response: ResponsesResult,
): AnthropicResponse['usage'] {
  const inputTokens = response.usage?.input_tokens ?? 0
  const outputTokens = response.usage?.output_tokens ?? 0
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens

  return {
    input_tokens: inputTokens - (cachedTokens ?? 0),
    output_tokens: outputTokens,
    ...(cachedTokens !== undefined ? { cache_read_input_tokens: cachedTokens } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isResponseOutputText(
  block: ResponseOutputContentBlock,
): block is ResponseOutputText {
  return isRecord(block) && block.type === 'output_text'
}

function isResponseOutputRefusal(
  block: ResponseOutputContentBlock,
): block is ResponseOutputRefusal {
  return isRecord(block) && block.type === 'refusal'
}
