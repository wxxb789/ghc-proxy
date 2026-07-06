import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { StrategyEntry } from '~/dispatch'
import type { ModelMappingInfo } from '~/lib/request-logger'
import type { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import type { AnthropicMessagesPayload } from '~/translator'
import type { Model } from '~/types'

import consola from 'consola'
import { StrategyRegistry } from '~/dispatch'
import { throwInvalidRequestError, withTranslationErrors } from '~/lib/error'
import { runStrategy } from '~/lib/execution-strategy'
import { appendModelStepInPlace } from '~/lib/request-logger'
import { configStore, MESSAGES_ENDPOINT, modelCache, RESPONSES_ENDPOINT } from '~/state'
import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from '~/transform/context-management'
import { applyResponsesParameterFilters } from '~/transform/parameter-filter'
import { filterThinkingBlocksForNativeMessages, hasOutputConfigFormat, sanitizeCacheControl, sanitizeOutputConfig } from '~/transform/sanitize'

import { translateAnthropicToResponsesPayload } from '~/translator/responses/anthropic-to-responses'
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

const nativeMessagesEntry: StrategyEntry<StrategyContext> = {
  name: 'native-messages',
  canHandle: (model, ctx) => modelCache.supportsEndpoint(model, MESSAGES_ENDPOINT)
    && !hasOutputConfigFormat(ctx?.anthropicPayload),
  async execute(ctx) {
    filterThinkingBlocksForNativeMessages(ctx.anthropicPayload)
    sanitizeOutputConfig(ctx.anthropicPayload, ctx.selectedModel)
    sanitizeCacheControl(ctx.anthropicPayload)

    const strategy = createNativeMessagesStrategy(
      ctx.copilotClient,
      ctx.anthropicPayload,
      ctx.anthropicBetaHeader,
      {
        signal: ctx.upstreamSignal.signal,
        requestContext: ctx.requestContext,
      },
    )
    return await runStrategy(strategy, ctx.upstreamSignal)
  },
}

const responsesApiEntry: StrategyEntry<StrategyContext> = {
  name: 'responses-api',
  canHandle: model => modelCache.supportsEndpoint(model, RESPONSES_ENDPOINT),
  async execute(ctx) {
    const responsesPayload = withTranslationErrors(() =>
      translateAnthropicToResponsesPayload(ctx.anthropicPayload, {
        reasoningEffortResolver: model => configStore.getReasoningEffort(model),
      }),
    )

    applyResponsesParameterFilters(responsesPayload, ctx.selectedModel)

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
    return await runStrategy(strategy, ctx.upstreamSignal)
  },
}

const chatCompletionsEntry: StrategyEntry<StrategyContext> = {
  name: 'chat-completions',
  canHandle: () => true,
  async execute(ctx) {
    if (hasOutputConfigFormat(ctx.anthropicPayload)) {
      throwInvalidRequestError(
        'Anthropic output_config.format requires a model with Responses endpoint support.',
        'output_config.format',
        'unsupported_output_config_format',
      )
    }

    const adapter = createAnthropicAdapter()
    const plan = withTranslationErrors(() =>
      adapter.toCapiPlan(ctx.anthropicPayload, {
        requestContext: ctx.requestContext,
      }),
    )

    appendModelStepInPlace(ctx.modelMapping, 'MODEL_RESOLVE', plan.resolvedModel)

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

    const strategy = createMessagesViaChatCompletionsStrategy(
      ctx.copilotClient,
      adapter,
      plan,
      ctx.upstreamSignal.signal,
    )
    return await runStrategy(strategy, ctx.upstreamSignal)
  },
}

export const defaultStrategyRegistry = new StrategyRegistry<StrategyContext>()
defaultStrategyRegistry.register(nativeMessagesEntry)
defaultStrategyRegistry.register(responsesApiEntry)
defaultStrategyRegistry.register(chatCompletionsEntry)
