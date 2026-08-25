import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { ExecutionStrategy, SSEOutput, SSEStreamChunk } from '~/lib/execution-strategy'
import type { ResponsesPayload, ResponsesResult, ResponseStreamEvent } from '~/types'

import consola from 'consola'
import { serializeAnthropicSSE } from '~/lib/sse-adapter'
import { ResponsesStreamTranslator } from '~/translator/responses/responses-stream-translator'
import { translateResponsesToAnthropic } from '~/translator/responses/responses-to-anthropic'
import { isAsyncIterable } from '~/util/async-iterable'

type ResponsesApiResult = ResponsesResult | AsyncIterable<SSEStreamChunk>

export function createMessagesViaResponsesStrategy(
  copilotClient: CopilotClient,
  responsesPayload: ResponsesPayload,
  options: {
    vision: boolean
    initiator: 'user' | 'agent'
    signal: AbortSignal
    requestContext: Partial<CapiRequestContext>
    onTerminalResponse?: (response: ResponsesResult) => void
    onStreamEndWithoutTerminal?: () => void
  },
): ExecutionStrategy<ResponsesApiResult, SSEStreamChunk> {
  const translator = new ResponsesStreamTranslator()
  let terminalResponseSeen = false

  return {
    execute() {
      return copilotClient.createResponses(responsesPayload, options) as Promise<ResponsesApiResult>
    },

    isStream(result): result is AsyncIterable<SSEStreamChunk> {
      return Boolean(responsesPayload.stream) && isAsyncIterable(result)
    },

    translateResult(result) {
      const response = result as ResponsesResult
      options.onTerminalResponse?.(response)
      return translateResponsesToAnthropic(response)
    },

    translateStreamChunk(chunk): SSEOutput | SSEOutput[] | null {
      if (chunk.event === 'ping') {
        return {
          event: 'ping',
          data: '{"type":"ping"}',
        }
      }

      if (!chunk.data) {
        return null
      }

      const event = JSON.parse(chunk.data) as ResponseStreamEvent
      if (
        event.type === 'response.completed'
        || event.type === 'response.incomplete'
        || event.type === 'response.failed'
      ) {
        terminalResponseSeen = true
        options.onTerminalResponse?.(event.response)
      }
      const events = translator.onEvent(event)

      return serializeAnthropicSSE(events)
    },

    shouldBreakStream() {
      return translator.isCompleted
    },

    onStreamDone() {
      if (!terminalResponseSeen)
        options.onStreamEndWithoutTerminal?.()
      if (translator.isCompleted) {
        return null
      }
      const events = translator.onDone()
      return serializeAnthropicSSE(events)
    },

    onStreamError(error) {
      consola.error('Error streaming Anthropic response via Responses API:', error)
      const events = translator.onError(error)
      return serializeAnthropicSSE(events)
    },
  }
}
