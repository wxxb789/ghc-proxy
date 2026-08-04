import type { StrategyContext as MessagesStrategyContext } from './strategy-registry'
import type { PipelineResult } from '~/pipeline/runner'

import type { AnthropicMessagesPayload } from '~/translator'
import consola from 'consola'
import { HTTPError } from '~/lib/error'
import { runPipeline } from '~/pipeline/runner'

import { processAnthropicBetaHeader } from '~/transform'
import { defaultStrategyRegistry } from './strategy-registry'

export interface MessagesCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
  requestId: string
  callerRequestId?: string
}

export type MessagesCoreResult = PipelineResult

export async function handleMessagesCore(
  { body, signal, headers, requestId, callerRequestId }: MessagesCoreParams,
): Promise<MessagesCoreResult> {
  let anthropicBetaHeader: string | undefined

  try {
    return await runPipeline<AnthropicMessagesPayload, MessagesStrategyContext>(
      { body, signal, headers, requestId, callerRequestId },
      {
        protocol: 'anthropic-messages',
        applyModelPolicy: true,
        strategyRegistry: defaultStrategyRegistry,
        afterIngest({ payload, headers: reqHeaders }) {
          if (consola.level >= 4)
            consola.debug('Anthropic request payload:', JSON.stringify(payload))

          anthropicBetaHeader = processAnthropicBetaHeader(
            reqHeaders.get('anthropic-beta'),
          )
          // Side-effect-only hook: forward the ingested payload unchanged. The
          // runner requires a returned payload (replacement callers return a
          // different one); returning ctx.payload is the no-substitution case.
          return payload
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
  catch (error) {
    if (!(error instanceof HTTPError))
      throw error
    const body = 'type' in error.body
      ? error.body
      : { type: 'error', ...error.body }
    throw new HTTPError(error.status, body, { headers: error.headers })
  }
}
