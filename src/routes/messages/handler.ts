import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo } from '~/lib/request-logger'
import type { Model } from '~/types'
import consola from 'consola'

import { CopilotTransport } from '~/adapters'
import { readCapiRequestContext } from '~/core/capi'
import { getReasoningEffortForModel } from '~/lib/config'
import { fromTranslationFailure } from '~/lib/error'
import { runStrategy } from '~/lib/execution-strategy'
import {
  findModelById,
  MESSAGES_ENDPOINT,
  modelSupportsAdaptiveThinking,
  modelSupportsEndpoint,
  RESPONSES_ENDPOINT,
} from '~/lib/model-capabilities'
import { applyMessagesModelPolicy } from '~/lib/request-model-policy'
import { createCopilotClient } from '~/lib/state'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { parseAnthropicMessagesPayload } from '~/lib/validation'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { translateAnthropicToResponsesPayload } from '~/translator/responses/anthropic-to-responses'
import { SignatureCodec } from '~/translator/responses/signature-codec'

import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from '../responses/context-management'
import { createAnthropicAdapter } from './shared'
import { createMessagesViaChatCompletionsStrategy } from './strategies/chat-completions'
import { createNativeMessagesStrategy } from './strategies/native-messages'
import { createMessagesViaResponsesStrategy } from './strategies/responses-api'

export interface MessagesCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
}

export interface MessagesCoreResult {
  result: ExecutionResult
  modelMapping?: ModelMappingInfo
}

/**
 * Core handler for Anthropic messages endpoint.
 * Returns both the execution result and model mapping info.
 */
export async function handleMessagesCore(
  { body, signal, headers }: MessagesCoreParams,
): Promise<MessagesCoreResult> {
  const anthropicPayload = parseAnthropicMessagesPayload(body)
  consola.debug('Anthropic request payload:', JSON.stringify(anthropicPayload))

  const anthropicBetaHeader = headers.get('anthropic-beta') ?? undefined
  const modelRouting = applyMessagesModelPolicy(
    anthropicPayload,
    anthropicBetaHeader,
  )
  let modelMapping: ModelMappingInfo = {
    originalModel: modelRouting.originalModel,
    mappedModel: modelRouting.routedModel,
  }

  if (modelRouting.reason) {
    consola.debug(
      `Routed anthropic request to small model via ${modelRouting.reason}:`,
      `${modelRouting.originalModel} -> ${modelRouting.routedModel}`,
    )
  }

  const selectedModel = findModelById(anthropicPayload.model)

  const upstreamSignal = createUpstreamSignalFromConfig(signal)

  const copilotClient = createCopilotClient()

  if (shouldUseMessagesApi(selectedModel)) {
    filterThinkingBlocksForNativeMessages(anthropicPayload)

    if (modelSupportsAdaptiveThinking(selectedModel)) {
      if (!anthropicPayload.thinking) {
        anthropicPayload.thinking = { type: 'adaptive' }
      }

      if (anthropicPayload.thinking.type !== 'disabled' && !anthropicPayload.output_config?.effort) {
        anthropicPayload.output_config = {
          ...anthropicPayload.output_config,
          effort: getAnthropicEffortForModel(anthropicPayload.model),
        }
      }
    }

    const strategy = createNativeMessagesStrategy(
      copilotClient,
      anthropicPayload,
      anthropicBetaHeader,
      {
        signal: upstreamSignal.signal,
        requestContext: readCapiRequestContext(headers),
      },
    )
    const result = await runStrategy(strategy, upstreamSignal)
    return { result, modelMapping }
  }

  if (shouldUseResponsesApi(selectedModel)) {
    let responsesPayload
    try {
      responsesPayload = translateAnthropicToResponsesPayload(anthropicPayload, {
        reasoningEffortResolver: getReasoningEffortForModel,
      })
    }
    catch (error) {
      if (error instanceof TranslationFailure) {
        throw fromTranslationFailure(error)
      }
      throw error
    }
    modelMapping = {
      originalModel: modelRouting.originalModel,
      mappedModel: responsesPayload.model,
    }

    applyContextManagement(
      responsesPayload,
      selectedModel?.capabilities.limits.max_prompt_tokens,
    )
    compactInputByLatestCompaction(responsesPayload)

    const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
    const strategy = createMessagesViaResponsesStrategy(
      copilotClient,
      responsesPayload,
      {
        vision,
        initiator,
        signal: upstreamSignal.signal,
        requestContext: readCapiRequestContext(headers),
      },
    )
    const result = await runStrategy(strategy, upstreamSignal)
    return { result, modelMapping }
  }

  const adapter = createAnthropicAdapter()
  let plan
  try {
    plan = adapter.toCapiPlan(anthropicPayload, {
      requestContext: readCapiRequestContext(headers),
    })
  }
  catch (error) {
    if (error instanceof TranslationFailure) {
      throw fromTranslationFailure(error)
    }
    throw error
  }

  modelMapping = {
    originalModel: modelRouting.originalModel,
    mappedModel: plan.resolvedModel,
  }
  consola.debug(
    'Claude Code requested model:',
    anthropicPayload.model,
    '-> Copilot model:',
    plan.resolvedModel,
  )
  consola.debug(
    'Planned Copilot request payload:',
    JSON.stringify(plan.payload),
  )

  const transport = new CopilotTransport(copilotClient)
  const strategy = createMessagesViaChatCompletionsStrategy(
    transport,
    adapter,
    plan,
    upstreamSignal.signal,
  )
  const result = await runStrategy(strategy, upstreamSignal)
  return { result, modelMapping }
}

function filterThinkingBlocksForNativeMessages(
  anthropicPayload: ReturnType<typeof parseAnthropicMessagesPayload>,
) {
  for (const message of anthropicPayload.messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue
    }
    message.content = message.content.filter((block) => {
      if (block.type !== 'thinking') {
        return true
      }
      return Boolean(
        block.thinking
        && block.thinking !== 'Thinking...'
        && block.signature
        && !SignatureCodec.isReasoningSignature(block.signature)
        && !SignatureCodec.isCompactionSignature(block.signature),
      )
    })
  }
}

function getAnthropicEffortForModel(
  model: string,
): 'low' | 'medium' | 'high' | 'max' {
  const reasoningEffort = getReasoningEffortForModel(model)
  if (reasoningEffort === 'xhigh') {
    return 'max'
  }
  if (reasoningEffort === 'none' || reasoningEffort === 'minimal') {
    return 'low'
  }
  return reasoningEffort
}

function shouldUseResponsesApi(
  selectedModel: Model | undefined,
): boolean {
  return modelSupportsEndpoint(selectedModel, RESPONSES_ENDPOINT)
}

function shouldUseMessagesApi(
  selectedModel: Model | undefined,
): boolean {
  return modelSupportsEndpoint(selectedModel, MESSAGES_ENDPOINT)
}
