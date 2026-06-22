import type { OpenAIChatAdapter } from '~/adapters'
import type { CopilotClient } from '~/clients'
import type { CapiChatCompletionChunk, CapiExecutionPlan } from '~/core/capi'
import type { ExecutionStrategy, SSEStreamChunk } from '~/lib/execution-strategy'

import consola from 'consola'
import { isNonStreamingResponse } from '~/clients'
import { passthroughSSEChunk } from '~/lib/execution-strategy'

type ChatCompletionsResult = Awaited<ReturnType<CopilotClient['createChatCompletions']>>

export function createChatCompletionsStrategy(
  client: CopilotClient,
  adapter: OpenAIChatAdapter,
  plan: CapiExecutionPlan,
  signal: AbortSignal,
): ExecutionStrategy<ChatCompletionsResult, SSEStreamChunk> {
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
      consola.debug('Non-streaming response:', JSON.stringify(result))
      return adapter.fromCapiResponse(result as Exclude<ChatCompletionsResult, AsyncIterable<SSEStreamChunk>>)
    },

    translateStreamChunk(chunk) {
      consola.debug('Streaming chunk:', JSON.stringify(chunk))
      if (chunk.data === '[DONE]') {
        return passthroughSSEChunk(chunk, chunk.data)
      }

      if (!chunk.data) {
        return null
      }

      const sanitizedChunk = adapter.serializeStreamChunk(
        JSON.parse(chunk.data) as CapiChatCompletionChunk,
      )
      return passthroughSSEChunk(chunk, JSON.stringify(sanitizedChunk))
    },
  }
}
