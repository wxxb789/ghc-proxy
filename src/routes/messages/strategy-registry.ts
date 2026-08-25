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
import { configStore, MESSAGES_ENDPOINT, modelCache, RESPONSES_ENDPOINT, runtimeStore } from '~/state'
import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from '~/transform/context-management'
import { applyResponsesParameterFilters, clampMessagesOutputTokens, clampResponsesOutputTokens } from '~/transform/parameter-filter'
import { stripPhaseFromInputMessages } from '~/transform/responses-input'
import { canReduceOutputFormatForNativeMessages, convertEnabledThinkingToAdaptive, filterThinkingBlocksForNativeMessages, hasOutputConfigFormat, reduceOutputFormatForNativeMessages, sanitizeCacheControl, sanitizeExclusiveSamplingParams, sanitizeOutputConfig } from '~/transform/sanitize'

import { translateAnthropicToResponsesPayload } from '~/translator/responses/anthropic-to-responses'
import { createAnthropicAdapter } from './shared'
import { createMessagesViaChatCompletionsStrategy } from './strategies/chat-completions'
import { createNativeMessagesStrategy } from './strategies/native-messages'
import { createMessagesViaResponsesStrategy } from './strategies/responses-api'

export interface StrategyContext {
  requestId: string
  copilotClient: CopilotClient
  anthropicPayload: AnthropicMessagesPayload
  anthropicBetaHeader: string | undefined
  selectedModel: Model | undefined
  upstreamSignal: ReturnType<typeof createUpstreamSignalFromConfig>
  headers: Headers
  requestContext: Partial<CapiRequestContext>
  modelMapping: ModelMappingInfo
}

export function canUseNativeMessages(
  model: Model | undefined,
  payload?: AnthropicMessagesPayload,
): boolean {
  return modelCache.supportsEndpoint(model, MESSAGES_ENDPOINT)
    && (!hasOutputConfigFormat(payload)
      || (modelCache.supportsStructuredOutputs(model)
        && canReduceOutputFormatForNativeMessages(payload)))
}

export function resolveMessagesStrategyName(
  model: Model | undefined,
  payload?: AnthropicMessagesPayload,
): 'native-messages' | 'responses-api' | 'chat-completions' {
  if (canUseNativeMessages(model, payload))
    return 'native-messages'
  if (modelCache.supportsEndpoint(model, RESPONSES_ENDPOINT))
    return 'responses-api'
  return 'chat-completions'
}

const nativeMessagesEntry: StrategyEntry<StrategyContext> = {
  name: 'native-messages',
  // Structured output is served natively when the model advertises
  // `structured_outputs` and the format carries nothing native drops — probed
  // 2026-07-26 (`scripts/probes/messages/output-format.ts`): 6 of 8 Messages
  // models return 200 for a bare `{ type, schema }`. The two that fail
  // (claude-opus-4.7, claude-sonnet-4.6) fail on a Vertex organization policy
  // rather than a protocol limit — they advertise the capability, so
  // `supportsStructuredOutputs` excludes them by ID rather than by flag.
  canHandle: (model, ctx) => canUseNativeMessages(model, ctx?.anthropicPayload),
  async execute(ctx) {
    if (convertEnabledThinkingToAdaptive(ctx.anthropicPayload, ctx.selectedModel))
      runtimeStore.requests.recordEffect(ctx.requestId, 'messages.thinking_adapted')
    const filteredThinkingBlocks = filterThinkingBlocksForNativeMessages(ctx.anthropicPayload)
    if (filteredThinkingBlocks > 0) {
      runtimeStore.requests.recordEffect(
        ctx.requestId,
        'messages.thinking_blocks_filtered',
        filteredThinkingBlocks,
      )
    }
    if (sanitizeOutputConfig(ctx.anthropicPayload, ctx.selectedModel))
      runtimeStore.requests.recordEffect(ctx.requestId, 'messages.output_config_sanitized')
    if (reduceOutputFormatForNativeMessages(ctx.anthropicPayload))
      runtimeStore.requests.recordEffect(ctx.requestId, 'messages.output_format_reduced')
    if (sanitizeExclusiveSamplingParams(ctx.anthropicPayload))
      runtimeStore.requests.recordEffect(ctx.requestId, 'messages.sampling_filtered')
    const sanitizedCacheControl = sanitizeCacheControl(ctx.anthropicPayload)
    if (sanitizedCacheControl > 0) {
      runtimeStore.requests.recordEffect(
        ctx.requestId,
        'messages.cache_control_sanitized',
        sanitizedCacheControl,
      )
    }
    if (clampMessagesOutputTokens(ctx.anthropicPayload, ctx.selectedModel))
      runtimeStore.requests.recordEffect(ctx.requestId, 'messages.output_tokens_lowered')

    const strategy = createNativeMessagesStrategy(
      ctx.copilotClient,
      ctx.anthropicPayload,
      ctx.anthropicBetaHeader,
      {
        signal: ctx.upstreamSignal.signal,
        requestContext: ctx.requestContext,
      },
    )
    return await runStrategy(strategy, ctx.upstreamSignal, {
      onStreamError: error => runtimeStore.recordStreamError(ctx.requestId, error),
    })
  },
}

const responsesApiEntry: StrategyEntry<StrategyContext> = {
  name: 'responses-api',
  canHandle: model => modelCache.supportsEndpoint(model, RESPONSES_ENDPOINT),
  async execute(ctx) {
    const responsesPayload = withTranslationErrors(() =>
      translateAnthropicToResponsesPayload(ctx.anthropicPayload, {
        reasoningEffortResolver: model => configStore.getReasoningEffort(model),
        supportedEfforts: ctx.selectedModel?.capabilities.supports.reasoning_effort,
      }),
    )

    const contextThreshold = applyContextManagement(
      responsesPayload,
      ctx.selectedModel?.capabilities.limits.max_prompt_tokens,
    )
    if (contextThreshold !== undefined)
      runtimeStore.requests.recordEffect(ctx.requestId, 'responses.context_management')
    const compactedItems = compactInputByLatestCompaction(responsesPayload)
    if (compactedItems > 0) {
      runtimeStore.requests.recordEffect(
        ctx.requestId,
        'responses.input_compacted',
        compactedItems,
      )
    }

    // The translator emits `phase` on assistant messages, and some models
    // reject it as input with a 400. Strip it here for the same reason
    // /responses does — this path generates the field rather than receiving
    // it, so it is if anything more exposed.
    const strippedPhases = stripPhaseFromInputMessages(responsesPayload)
    if (strippedPhases > 0) {
      runtimeStore.requests.recordEffect(
        ctx.requestId,
        'responses.phase_filtered',
        strippedPhases,
      )
    }

    // Runs last so it can strip any request parameter — including fields
    // injected above (e.g. context_management) — that the model rejects.
    const removedParams = applyResponsesParameterFilters(responsesPayload, ctx.selectedModel)
    if (removedParams.length > 0) {
      runtimeStore.requests.recordEffect(
        ctx.requestId,
        'responses.parameter_filter',
        removedParams.length,
      )
    }
    if (clampResponsesOutputTokens(responsesPayload))
      runtimeStore.requests.recordEffect(ctx.requestId, 'responses.output_tokens_raised')

    const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
    const strategy = createMessagesViaResponsesStrategy(
      ctx.copilotClient,
      responsesPayload,
      {
        vision,
        initiator,
        signal: ctx.upstreamSignal.signal,
        requestContext: ctx.requestContext,
        onTerminalResponse(response) {
          if (response.status === 'failed' || response.error) {
            runtimeStore.requests.recordError(
              ctx.requestId,
              'Upstream HTTP 200 (response_failed)',
            )
          }
        },
      },
    )
    return await runStrategy(strategy, ctx.upstreamSignal, {
      onStreamError: error => runtimeStore.recordStreamError(ctx.requestId, error),
    })
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
    return await runStrategy(strategy, ctx.upstreamSignal, {
      onStreamError: error => runtimeStore.recordStreamError(ctx.requestId, error),
    })
  },
}

export const defaultStrategyRegistry = new StrategyRegistry<StrategyContext>()
defaultStrategyRegistry.register(nativeMessagesEntry)
defaultStrategyRegistry.register(responsesApiEntry)
defaultStrategyRegistry.register(chatCompletionsEntry)
