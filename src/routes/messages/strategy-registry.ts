import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo } from '~/lib/request-logger'
import type { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import type { AnthropicMessagesPayload } from '~/translator'

import type { Model } from '~/types'
import consola from 'consola'
import { CopilotTransport } from '~/adapters'
import { getReasoningEffortForModel } from '~/lib/config'
import { fromTranslationFailure } from '~/lib/error'
import { runStrategy } from '~/lib/execution-strategy'
import {
  MESSAGES_ENDPOINT,
  modelSupportsEndpoint,
  RESPONSES_ENDPOINT,
} from '~/lib/model-capabilities'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { translateAnthropicToResponsesPayload } from '~/translator/responses/anthropic-to-responses'
import { SignatureCodec } from '~/translator/responses/signature-codec'

import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from '../responses/context-management'
import { createAnthropicAdapter } from './shared'
import { createMessagesViaChatCompletionsStrategy } from './strategies/chat-completions'
import { createNativeMessagesStrategy } from './strategies/native-messages'
import { createMessagesViaResponsesStrategy } from './strategies/responses-api'

export interface StrategyContext {
  copilotClient: CopilotClient
  anthropicPayload: AnthropicMessagesPayload
  anthropicBetaHeader: string | undefined
  selectedModel: Model | undefined
  upstreamSignal: ReturnType<typeof createUpstreamSignalFromConfig>
  headers: Headers
  requestContext: Partial<CapiRequestContext>
  modelMapping: ModelMappingInfo
}

export interface StrategyResult {
  result: ExecutionResult
  modelMapping: ModelMappingInfo
}

export interface StrategyEntry {
  name: string
  canHandle: (model: Model | undefined) => boolean
  execute: (ctx: StrategyContext) => Promise<StrategyResult>
}

export function selectStrategy(
  registry: Array<StrategyEntry>,
  model: Model | undefined,
): StrategyEntry {
  for (const entry of registry) {
    if (entry.canHandle(model)) {
      return entry
    }
  }
  // Should never happen if registry has a fallback, but just in case
  return registry[registry.length - 1]
}

function filterThinkingBlocksForNativeMessages(
  anthropicPayload: AnthropicMessagesPayload,
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

const nativeMessagesEntry: StrategyEntry = {
  name: 'native-messages',
  canHandle: model => modelSupportsEndpoint(model, MESSAGES_ENDPOINT),
  async execute(ctx) {
    filterThinkingBlocksForNativeMessages(ctx.anthropicPayload)

    const strategy = createNativeMessagesStrategy(
      ctx.copilotClient,
      ctx.anthropicPayload,
      ctx.anthropicBetaHeader,
      {
        signal: ctx.upstreamSignal.signal,
        requestContext: ctx.requestContext,
      },
    )
    const result = await runStrategy(strategy, ctx.upstreamSignal)
    return { result, modelMapping: ctx.modelMapping }
  },
}

const responsesApiEntry: StrategyEntry = {
  name: 'responses-api',
  canHandle: model => modelSupportsEndpoint(model, RESPONSES_ENDPOINT),
  async execute(ctx) {
    let responsesPayload
    try {
      responsesPayload = translateAnthropicToResponsesPayload(ctx.anthropicPayload, {
        reasoningEffortResolver: getReasoningEffortForModel,
      })
    }
    catch (error) {
      if (error instanceof TranslationFailure) {
        throw fromTranslationFailure(error)
      }
      throw error
    }

    const modelMapping: ModelMappingInfo = {
      originalModel: ctx.modelMapping.originalModel,
      mappedModel: responsesPayload.model,
    }

    applyContextManagement(
      responsesPayload,
      ctx.selectedModel?.capabilities.limits.max_prompt_tokens,
    )
    compactInputByLatestCompaction(responsesPayload)

    const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
    const strategy = createMessagesViaResponsesStrategy(
      ctx.copilotClient,
      responsesPayload,
      {
        vision,
        initiator,
        signal: ctx.upstreamSignal.signal,
        requestContext: ctx.requestContext,
      },
    )
    const result = await runStrategy(strategy, ctx.upstreamSignal)
    return { result, modelMapping }
  },
}

const chatCompletionsEntry: StrategyEntry = {
  name: 'chat-completions',
  canHandle: () => true,
  async execute(ctx) {
    const adapter = createAnthropicAdapter()
    let plan
    try {
      plan = adapter.toCapiPlan(ctx.anthropicPayload, {
        requestContext: ctx.requestContext,
      })
    }
    catch (error) {
      if (error instanceof TranslationFailure) {
        throw fromTranslationFailure(error)
      }
      throw error
    }

    const modelMapping: ModelMappingInfo = {
      originalModel: ctx.modelMapping.originalModel,
      mappedModel: plan.resolvedModel,
    }

    consola.debug(
      'Claude Code requested model:',
      ctx.anthropicPayload.model,
      '-> Copilot model:',
      plan.resolvedModel,
    )
    if (consola.level >= 4) {
      consola.debug(
        'Planned Copilot request payload:',
        JSON.stringify(plan.payload),
      )
    }

    const transport = new CopilotTransport(ctx.copilotClient)
    const strategy = createMessagesViaChatCompletionsStrategy(
      transport,
      adapter,
      plan,
      ctx.upstreamSignal.signal,
    )
    const result = await runStrategy(strategy, ctx.upstreamSignal)
    return { result, modelMapping }
  },
}

export const defaultStrategyRegistry: Array<StrategyEntry> = [
  nativeMessagesEntry,
  responsesApiEntry,
  chatCompletionsEntry,
]
