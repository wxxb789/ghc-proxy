import type { AnthropicMessagesAdapter, CopilotTransport } from '~/adapters'
import type { CapiChatCompletionChunk, CapiExecutionPlan } from '~/core/capi'
import type { ExecutionStrategy, SSEOutput, SSEStreamChunk } from '~/lib/execution-strategy'

import consola from 'consola'
import { isNonStreamingResponse } from '~/clients'

type ChatCompletionsResult = Awaited<ReturnType<CopilotTransport['execute']>>

export function createMessagesViaChatCompletionsStrategy(
  transport: CopilotTransport,
  adapter: AnthropicMessagesAdapter,
  plan: CapiExecutionPlan,
  signal: AbortSignal,
): ExecutionStrategy<ChatCompletionsResult, SSEStreamChunk> {
  let streamTranslator: ReturnType<AnthropicMessagesAdapter['createStreamSerializer']>
  let done = false

  return {
    execute() {
      return transport.execute(plan, { signal })
    },

    isStream(result): result is ChatCompletionsResult & AsyncIterable<SSEStreamChunk> {
      return !isNonStreamingResponse(result)
    },

    translateResult(result) {
      consola.debug(
        'Non-streaming response from Copilot (full):',
        JSON.stringify(result, null, 2),
      )
      const anthropicResponse = adapter.fromCapiResponse(
        result as Exclude<ChatCompletionsResult, AsyncIterable<SSEStreamChunk>>,
      )
      consola.debug(
        'Translated Anthropic response:',
        JSON.stringify(anthropicResponse),
      )
      return anthropicResponse
    },

    translateStreamChunk(chunk): SSEOutput | SSEOutput[] | null {
      if (!streamTranslator) {
        streamTranslator = adapter.createStreamSerializer()
      }

      consola.debug('Copilot raw stream event:', JSON.stringify(chunk))

      if (chunk.data === '[DONE]') {
        const finalEvents = streamTranslator.onDone()
        done = true
        return finalEvents.map(event => ({
          event: event.type,
          data: JSON.stringify(event),
        }))
      }

      if (!chunk.data) {
        return null
      }

      const parsed = JSON.parse(chunk.data) as CapiChatCompletionChunk
      const events = streamTranslator.onChunk(parsed)

      return events.map(event => ({
        event: event.type,
        data: JSON.stringify(event),
      }))
    },

    shouldBreakStream() {
      return done
    },

    onStreamError(error) {
      consola.error('Error streaming Anthropic response:', error)
      if (!streamTranslator) {
        streamTranslator = adapter.createStreamSerializer()
      }
      const errorEvents = streamTranslator.onError(error)
      return errorEvents.map(event => ({
        event: event.type,
        data: JSON.stringify(event),
      }))
    },
  }
}
