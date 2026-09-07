import type { ChatCompletionsStrategyContext } from './strategy-registry'
import type { PipelineResult } from '~/pipeline/runner'
import type { ChatCompletionsPayload } from '~/types'

import consola from 'consola'
import { runPipeline } from '~/pipeline/runner'
import { runtimeStore } from '~/state'
import { applyChatCompletionsTokenParam } from '~/transform/parameter-filter'

import { chatCompletionsStrategyRegistry } from './strategy-registry'

export interface CompletionCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
  requestId: string
  callerRequestId?: string
}

export type CompletionCoreResult = PipelineResult

export async function handleCompletionCore(
  { body, signal, headers, requestId, callerRequestId }: CompletionCoreParams,
): Promise<CompletionCoreResult> {
  return runPipeline<ChatCompletionsPayload, ChatCompletionsStrategyContext>(
    { body, signal, headers, requestId, callerRequestId },
    {
      protocol: 'openai-chat',
      strategyRegistry: chatCompletionsStrategyRegistry,
      afterIngest({ payload }) {
        consola.debug('Request payload:', JSON.stringify(payload).slice(-400))
        // Side-effect-only hook: forward the ingested payload unchanged (the
        // runner requires a returned payload; this is the no-substitution case).
        return payload
      },
      afterTransform({ payload, selectedModel }) {
        if (payload.max_tokens == null) {
          payload.max_tokens = selectedModel?.capabilities.limits.max_output_tokens
          consola.debug('Set max_tokens to:', JSON.stringify(payload.max_tokens))
          if (payload.max_tokens != null)
            runtimeStore.requests.recordEffect(requestId, 'chat.max_tokens_defaulted')
        }

        // Runs last: some models reject `max_tokens` outright and want
        // `max_completion_tokens`, so the rename has to see the final value —
        // including the default injected just above.
        if (applyChatCompletionsTokenParam(payload, selectedModel))
          runtimeStore.requests.recordEffect(requestId, 'chat.max_tokens_renamed')
      },
      buildStrategyContext({ payload, meta, copilotClient, upstreamSignal, modelMapping, recovery }) {
        return {
          requestId: recovery.requestId,
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
