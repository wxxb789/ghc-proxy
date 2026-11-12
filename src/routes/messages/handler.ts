import type { StrategyContext as MessagesStrategyContext } from './strategy-registry'
import type { PipelineResult } from '~/pipeline/runner'

import type { AnthropicMessagesPayload } from '~/translator'
import consola from 'consola'
import { HTTPError, throwInvalidRequestError } from '~/lib/error'
import { runPipeline } from '~/pipeline/runner'
import { modelCache } from '~/state'

import { processAnthropicBetaHeader } from '~/transform'
import { checkMessagesFallbackTarget } from './fallback-eligibility'
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
        checkFallbackTarget: checkMessagesFallbackTarget,
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
        afterTransform({ selectedModel }) {
          if (modelCache.isImageOnlyModel(selectedModel))
            throwInvalidRequestError('This model only supports Images. Use /v1/images/generations or /v1/images/edits.', 'model')
        },
        buildStrategyContext({ payload, meta, headers: reqHeaders, selectedModel, copilotClient, upstreamSignal, modelMapping, recovery }) {
          return {
            requestId: recovery.requestId,
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
