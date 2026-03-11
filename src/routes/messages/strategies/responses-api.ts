import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { ExecutionStrategy, SSEOutput, SSEStreamChunk } from '~/lib/execution-strategy'
import type { ResponsesPayload, ResponsesResult, ResponseStreamEvent } from '~/types'

import consola from 'consola'
import { isAsyncIterable } from '~/lib/async-iterable'
import { ResponsesStreamTranslator } from '~/translator/responses/responses-stream-translator'
import { translateResponsesToAnthropic } from '~/translator/responses/responses-to-anthropic'

type ResponsesApiResult = ResponsesResult | AsyncIterable<SSEStreamChunk>

export function createMessagesViaResponsesStrategy(
  copilotClient: CopilotClient,
  responsesPayload: ResponsesPayload,
  options: {
    vision: boolean
    initiator: 'user' | 'agent'
    signal: AbortSignal
    requestContext: Partial<CapiRequestContext>
  },
): ExecutionStrategy<ResponsesApiResult, SSEStreamChunk> {
  const translator = new ResponsesStreamTranslator()

  return {
    execute() {
      return copilotClient.createResponses(responsesPayload, options) as Promise<ResponsesApiResult>
    },

    isStream(result): result is AsyncIterable<SSEStreamChunk> {
      return Boolean(responsesPayload.stream) && isAsyncIterable(result)
    },

    translateResult(result) {
      return translateResponsesToAnthropic(result as ResponsesResult)
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

      const events = translator.onEvent(
        JSON.parse(chunk.data) as ResponseStreamEvent,
      )

      return events.map(event => ({
        event: event.type,
        data: JSON.stringify(event),
      }))
    },

    shouldBreakStream() {
      return translator.isCompleted
    },

    onStreamDone() {
      if (translator.isCompleted) {
        return null
      }
      const events = translator.onDone()
      return events.map(event => ({
        event: event.type,
        data: JSON.stringify(event),
      }))
    },

    onStreamError(error) {
      consola.error('Error streaming Anthropic response via Responses API:', error)
      const events = translator.onError(error)
      return events.map(event => ({
        event: event.type,
        data: JSON.stringify(event),
      }))
    },
  }
}
