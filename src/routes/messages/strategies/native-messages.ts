import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { ExecutionStrategy } from '~/lib/execution-strategy'
import type {
  AnthropicAssistantContentBlock,
  AnthropicMessagesPayload,
  AnthropicToolResultContentBlock,
  AnthropicUserContentBlock,
} from '~/translator'

import { formatSearchResultBlock } from '~/translator/anthropic/search-result'
import { isAsyncIterable } from '~/util/async-iterable'

interface MessagesStreamChunk {
  event?: string
  data?: string
}

type NativeMessagesResult = Awaited<ReturnType<CopilotClient['createMessages']>>

type RuntimeAnthropicMessagesPayload = AnthropicMessagesPayload & {
  citations?: unknown
}

export function sanitizeNativeMessagesPayloadForCopilot(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  const { citations: _citations, ...rest } = payload as RuntimeAnthropicMessagesPayload

  return {
    ...rest,
    messages: rest.messages.map((message) => {
      if (typeof message.content === 'string') {
        return message
      }

      if (message.role === 'user') {
        return {
          ...message,
          content: message.content.map(sanitizeUserContentBlock),
        }
      }

      if (message.role === 'system') {
        return message
      }

      return {
        ...message,
        content: message.content.map(sanitizeAssistantContentBlock),
      }
    }),
  }
}

function sanitizeUserContentBlock(block: AnthropicUserContentBlock): AnthropicUserContentBlock {
  return sanitizeToolResultContentBlock(block)
}

function sanitizeAssistantContentBlock(block: AnthropicAssistantContentBlock): AnthropicAssistantContentBlock {
  return sanitizeToolResultContentBlock(block)
}

function sanitizeToolResultContentBlock<T extends AnthropicUserContentBlock | AnthropicAssistantContentBlock>(block: T): T {
  if (
    (block.type === 'tool_result' || block.type === 'mcp_tool_result')
    && Array.isArray(block.content)
    && hasMixedSearchResultContent(block.content)
  ) {
    return {
      ...block,
      content: [{ type: 'text', text: stringifyToolResultContent(block.content) }],
    } as T
  }

  return block
}

function hasMixedSearchResultContent(content: Array<AnthropicToolResultContentBlock>): boolean {
  const hasSearchResult = content.some(block => block.type === 'search_result')
  return hasSearchResult && content.some(block => block.type !== 'search_result')
}

function stringifyToolResultContent(content: Array<AnthropicToolResultContentBlock>): string {
  return content.map((block) => {
    switch (block.type) {
      case 'text':
        return block.text
      case 'image':
        return `[image omitted: ${block.source.media_type}]`
      case 'search_result':
        return formatSearchResultBlock(block)
    }
    return ''
  }).filter(Boolean).join('\n\n')
}

export function createNativeMessagesStrategy(
  copilotClient: CopilotClient,
  payload: AnthropicMessagesPayload,
  anthropicBetaHeader: string | undefined,
  options: {
    signal: AbortSignal
    requestContext: Partial<CapiRequestContext>
  },
): ExecutionStrategy<NativeMessagesResult, MessagesStreamChunk> {
  const sanitizedPayload = sanitizeNativeMessagesPayloadForCopilot(payload)

  return {
    execute() {
      return copilotClient.createMessages(sanitizedPayload, anthropicBetaHeader, options)
    },

    isStream(result): result is NativeMessagesResult & AsyncIterable<MessagesStreamChunk> {
      return isAsyncIterable(result)
    },

    translateResult(result) {
      return result
    },

    translateStreamChunk(chunk) {
      return {
        ...(chunk.event ? { event: chunk.event } : {}),
        data: chunk.data ?? '',
      }
    },
  }
}
