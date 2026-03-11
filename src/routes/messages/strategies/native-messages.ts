import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { ExecutionStrategy } from '~/lib/execution-strategy'
import type { AnthropicMessagesPayload } from '~/translator'

import { isAsyncIterable } from '~/lib/async-iterable'

interface MessagesStreamChunk {
  event?: string
  data?: string
}

type NativeMessagesResult = Awaited<ReturnType<CopilotClient['createMessages']>>

export function createNativeMessagesStrategy(
  copilotClient: CopilotClient,
  payload: AnthropicMessagesPayload,
  anthropicBetaHeader: string | undefined,
  options: {
    signal: AbortSignal
    requestContext: Partial<CapiRequestContext>
  },
): ExecutionStrategy<NativeMessagesResult, MessagesStreamChunk> {
  return {
    execute() {
      return copilotClient.createMessages(payload, anthropicBetaHeader, options)
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
