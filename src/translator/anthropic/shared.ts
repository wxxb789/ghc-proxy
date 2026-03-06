import type { AnthropicResponse } from './types'

export function mapOpenAIStopReasonToAnthropic(
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null,
): AnthropicResponse['stop_reason'] {
  if (finishReason === null) {
    return null
  }
  const stopReasonMap = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    content_filter: 'refusal',
  } as const
  return stopReasonMap[finishReason]
}

interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
  }
}

export function mapOpenAIUsageToAnthropic(usage?: OpenAIUsage) {
  return {
    input_tokens:
      (usage?.prompt_tokens ?? 0)
      - (usage?.prompt_tokens_details?.cached_tokens ?? 0),
    output_tokens: usage?.completion_tokens ?? 0,
    ...(usage?.prompt_tokens_details?.cached_tokens !== undefined && {
      cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens,
    }),
  }
}
