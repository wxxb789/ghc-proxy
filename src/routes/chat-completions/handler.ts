import type { ChatCompletionsStrategyContext } from './strategy-registry'
import type { PipelineResult } from '~/pipeline/runner'
import type { ChatCompletionsPayload } from '~/types'

import consola from 'consola'
import { getTokenCount } from '~/lib/tokenizer'
import { runPipeline } from '~/pipeline/runner'
import { chatCompletionsModelChain } from '~/transform'

import { chatCompletionsStrategyRegistry } from './strategy-registry'

export interface CompletionCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
}

export type CompletionCoreResult = PipelineResult

export async function handleCompletionCore(
  { body, signal, headers }: CompletionCoreParams,
): Promise<CompletionCoreResult> {
  return runPipeline<ChatCompletionsPayload, ChatCompletionsStrategyContext>(
    { body, signal, headers },
    {
      protocol: 'openai-chat',
      transformChain: chatCompletionsModelChain,
      strategyRegistry: chatCompletionsStrategyRegistry,
      afterIngest({ payload }) {
        consola.debug('Request payload:', JSON.stringify(payload).slice(-400))
        // Side-effect-only hook: forward the ingested payload unchanged (the
        // runner requires a returned payload; this is the no-substitution case).
        return payload
      },
      async afterTransform({ payload, selectedModel }) {
        try {
          if (selectedModel) {
            const tokenCount = await getTokenCount(payload, selectedModel)
            consola.info('Current token count:', tokenCount)
          }
          else {
            consola.warn('No model selected, skipping token count calculation')
          }
        }
        catch (error) {
          consola.warn('Failed to calculate token count:', error)
        }

        if (payload.max_tokens == null) {
          payload.max_tokens = selectedModel?.capabilities.limits.max_output_tokens
          consola.debug('Set max_tokens to:', JSON.stringify(payload.max_tokens))
        }
      },
      buildStrategyContext({ payload, meta, copilotClient, upstreamSignal, modelMapping }) {
        return {
          copilotClient,
          payload,
          upstreamSignal,
          requestContext: meta.requestContext ?? {},
          modelMapping,
        }
      },
    },
  )
}
