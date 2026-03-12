import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo } from '~/lib/request-logger'
import type { Model } from '~/types'
import consola from 'consola'

import { AnthropicMessagesAdapter, CopilotTransport } from '~/adapters'
import { CopilotClient } from '~/clients'
import { readCapiRequestContext } from '~/core/capi'
import { getReasoningEffortForModel } from '~/lib/config'
import { HTTPError } from '~/lib/error'
import { runStrategy } from '~/lib/execution-strategy'
import {
  findModelById,
  modelSupportsAdaptiveThinking,
  modelSupportsEndpoint,
} from '~/lib/model-capabilities'
import { getModelFallbackConfig, resolveModel } from '~/lib/model-resolver'
import { applyMessagesModelPolicy } from '~/lib/request-model-policy'
import { getClientConfig, state } from '~/lib/state'
import { createUpstreamSignal } from '~/lib/upstream-signal'
import { parseAnthropicMessagesPayload } from '~/lib/validation'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { translateAnthropicToResponsesPayload } from '~/translator/responses/anthropic-to-responses'
import { SignatureCodec } from '~/translator/responses/signature-codec'

import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from '../responses/context-management'
import { createMessagesViaChatCompletionsStrategy } from './strategies/chat-completions'
import { createNativeMessagesStrategy } from './strategies/native-messages'
import { createMessagesViaResponsesStrategy } from './strategies/responses-api'

const RESPONSES_ENDPOINT = '/responses'
const MESSAGES_ENDPOINT = '/v1/messages'

export interface MessagesCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
}

export interface MessagesCoreResult {
  result: ExecutionResult
  modelMapping?: ModelMappingInfo
}

function createAnthropicAdapter() {
  const knownModelIds = state.cache.models
    ? new Set(state.cache.models.data.map(model => model.id))
    : undefined
  const fallbackConfig = getModelFallbackConfig()

  return new AnthropicMessagesAdapter({
    modelResolver: (model: string) => resolveModel(model, knownModelIds, fallbackConfig),
    getModelCapabilities: model => ({
      supportsThinkingBudget: model.startsWith('claude'),
    }),
  })
}

function toHTTPError(error: TranslationFailure): HTTPError {
  return new HTTPError(
    error.message,
    new Response(error.message, {
      status: error.status,
    }),
  )
}

/**
 * Framework-agnostic handler for Anthropic messages endpoint.
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

  const upstreamSignal = createUpstreamSignal(
    signal,
    state.config.upstreamTimeoutSeconds !== undefined
      ? state.config.upstreamTimeoutSeconds * 1000
      : undefined,
  )

  const copilotClient = new CopilotClient(state.auth, getClientConfig())

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
        throw toHTTPError(error)
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
      throw toHTTPError(error)
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
