import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo } from '~/lib/request-logger'
import consola from 'consola'

import { CopilotTransport, OpenAIChatAdapter } from '~/adapters'
import { readCapiRequestContext } from '~/core/capi'
import { runStrategy } from '~/lib/execution-strategy'
import { findModelById } from '~/lib/model-capabilities'
import { createCopilotClient } from '~/lib/state'
import { getTokenCount } from '~/lib/tokenizer'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { parseOpenAIChatPayload } from '~/lib/validation'

import { createChatCompletionsStrategy } from './strategy'

export interface CompletionCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
}

export interface CompletionCoreResult {
  result: ExecutionResult
  modelMapping?: ModelMappingInfo
}

/**
 * Core handler for chat completions.
 */
export async function handleCompletionCore(
  { body, signal, headers }: CompletionCoreParams,
): Promise<CompletionCoreResult> {
  const adapter = new OpenAIChatAdapter()
  let payload = parseOpenAIChatPayload(body)
  consola.debug('Request payload:', JSON.stringify(payload).slice(-400))

  const originalModel = payload.model
  const selectedModel = findModelById(payload.model)

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
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug('Set max_tokens to:', JSON.stringify(payload.max_tokens))
  }

  const upstreamSignal = createUpstreamSignalFromConfig(signal)

  const plan = adapter.toCapiPlan(payload, {
    requestContext: readCapiRequestContext(headers),
  })

  const modelMapping: ModelMappingInfo = {
    originalModel,
    mappedModel: plan.resolvedModel,
  }

  const copilotClient = createCopilotClient()
  const transport = new CopilotTransport(copilotClient)

  consola.debug('Streaming response')
  const strategy = createChatCompletionsStrategy(transport, adapter, plan, upstreamSignal.signal)
  const result = await runStrategy(strategy, upstreamSignal)
  return { result, modelMapping }
}
