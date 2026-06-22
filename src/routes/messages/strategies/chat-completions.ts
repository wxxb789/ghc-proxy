import type { AnthropicMessagesAdapter } from '~/adapters'
import type { CopilotClient } from '~/clients'
import type { CapiChatCompletionChunk, CapiExecutionPlan } from '~/core/capi'
import type { ExecutionStrategy, SSEOutput, SSEStreamChunk } from '~/lib/execution-strategy'

import consola from 'consola'
import { isNonStreamingResponse } from '~/clients'
import { serializeAnthropicSSE } from '~/lib/sse-adapter'

type ChatCompletionsResult = Awaited<ReturnType<CopilotClient['createChatCompletions']>>

export function createMessagesViaChatCompletionsStrategy(
  client: CopilotClient,
  adapter: AnthropicMessagesAdapter,
  plan: CapiExecutionPlan,
  signal: AbortSignal,
): ExecutionStrategy<ChatCompletionsResult, SSEStreamChunk> {
  let streamTranslator: ReturnType<AnthropicMessagesAdapter['createStreamSerializer']>
  let done = false

  return {
    execute() {
      return client.createChatCompletions(plan.payload, {
        signal,
        initiator: plan.initiator,
        requestContext: plan.requestContext,
      })
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
        return serializeAnthropicSSE(finalEvents)
      }

      if (!chunk.data) {
        return null
      }

      const parsed = JSON.parse(chunk.data) as CapiChatCompletionChunk
      const events = streamTranslator.onChunk(parsed)

      return serializeAnthropicSSE(events)
    },

    onStreamDone() {
      // Safety net: if the upstream closes without sending [DONE],
      // ensure message_delta/message_stop are still emitted.
      // No-op when [DONE] already triggered onDone() (idempotent guard).
      if (!streamTranslator) {
        return null
      }
      const finalEvents = streamTranslator.onDone()
      return serializeAnthropicSSE(finalEvents)
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
      return serializeAnthropicSSE(errorEvents)
    },
  }
}
