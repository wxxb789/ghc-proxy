import type { StrategyContext as MessagesStrategyContext } from './strategy-registry'
import type { PipelineResult } from '~/pipeline/runner'

import type { AnthropicMessagesPayload } from '~/translator'
import consola from 'consola'
import { runPipeline } from '~/pipeline/runner'

import { messagesModelChain, processAnthropicBetaHeader } from '~/transform'
import { defaultStrategyRegistry } from './strategy-registry'

export interface MessagesCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
}

export type MessagesCoreResult = PipelineResult

export async function handleMessagesCore(
  { body, signal, headers }: MessagesCoreParams,
): Promise<MessagesCoreResult> {
  let anthropicBetaHeader: string | undefined

  return runPipeline<AnthropicMessagesPayload, MessagesStrategyContext>(
    { body, signal, headers },
    {
      protocol: 'anthropic-messages',
      transformChain: messagesModelChain,
      strategyRegistry: defaultStrategyRegistry,
      afterIngest({ payload, headers: reqHeaders }) {
        if (consola.level >= 4)
          consola.debug('Anthropic request payload:', JSON.stringify(payload))

        const betaResult = processAnthropicBetaHeader(
          reqHeaders.get('anthropic-beta'),
        )
        anthropicBetaHeader = betaResult.header
      },
      buildStrategyContext({ payload, meta, headers: reqHeaders, selectedModel, copilotClient, upstreamSignal, modelMapping }) {
        return {
          copilotClient,
          anthropicPayload: payload,
          anthropicBetaHeader,
          selectedModel,
          upstreamSignal,
          headers: reqHeaders,
          requestContext: meta.requestContext ?? {},
          modelMapping,
        }
      },
    },
  )
}
