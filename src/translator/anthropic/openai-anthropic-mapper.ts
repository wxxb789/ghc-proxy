import type { NormalizedOpenAIResponse } from './ir'

import type { AnthropicAssistantContentBlock, AnthropicResponse } from './types'

import { mapOpenAIStopReasonToAnthropic, mapOpenAIUsageToAnthropic } from './shared'

function assertNever(value: never): never {
  throw new Error(`Unexpected normalized value: ${JSON.stringify(value)}`)
}

function mapBlocks(
  response: NormalizedOpenAIResponse,
): Array<AnthropicAssistantContentBlock> {
  return response.turn.blocks.map((block) => {
    switch (block.kind) {
      case 'text':
        return { type: 'text', text: block.text }
      case 'thinking':
        return {
          type: 'thinking',
          thinking: block.thinking,
          signature: block.signature,
        }
      case 'tool_use':
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        }
      case 'image':
        return {
          type: 'text',
          text: `[unsupported image content omitted: ${block.mediaType}]`,
        }
      case 'tool_result':
        return {
          type: 'text',
          text: `[unsupported tool_result omitted: ${block.toolUseId}]`,
        }
      default:
        return assertNever(block)
    }
  })
}

export function mapOpenAIResponseToAnthropic(
  response: NormalizedOpenAIResponse,
): AnthropicResponse {
  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content: mapBlocks(response),
    stop_reason: mapOpenAIStopReasonToAnthropic(response.finishReason),
    stop_sequence: null,
    usage: mapOpenAIUsageToAnthropic(response.usage),
  }
}
