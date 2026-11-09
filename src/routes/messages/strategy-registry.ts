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
import { getResponsesRequestOptions } from '~/transform/context-management'
import { clampMessagesOutputTokens } from '~/transform/parameter-filter'
import { createResponsesTerminalObservers, shapeResponsesUpstreamPayload } from '~/transform/responses-upstream'
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

// Structured output is served natively when the model advertises
// `structured_outputs` and the format carries nothing native drops — probed
// 2026-07-26 (`scripts/probes/messages/output-format.ts`): 6 of 8 Messages
// models return 200 for a bare `{ type, schema }`. The two that fail
// (claude-opus-4.7, claude-sonnet-4.6) fail on a Vertex organization policy
// rather than a protocol limit — they advertise the capability, so
// `supportsStructuredOutputs` excludes them by ID rather than by flag.
function canUseNativeMessages(
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

const BARE_OUTPUT_FORMAT_PROBE: AnthropicMessagesPayload = {
  model: '',
  max_tokens: 1,
  messages: [],
  output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
}

/**
 * Whether `/v1/messages` serves a bare `output_config.format` (`{ type, schema }`)
 * for this model: the Chat Completions fallback rejects every format. A format
 * carrying `description` or `strict` additionally keeps native Messages out, so
 * a native-only model can still reject one — a payload-dependent case this
 * per-model answer does not cover.
 */
export function canServeMessagesOutputFormat(model: Model | undefined): boolean {
  return resolveMessagesStrategyName(model, BARE_OUTPUT_FORMAT_PROBE) !== 'chat-completions'
}

const nativeMessagesEntry: StrategyEntry<StrategyContext> = {
  name: 'native-messages',
  canHandle: (model, ctx) => resolveMessagesStrategyName(model, ctx?.anthropicPayload) === 'native-messages',
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
  canHandle: (model, ctx) => resolveMessagesStrategyName(model, ctx?.anthropicPayload) === 'responses-api',
  async execute(ctx) {
    const responsesPayload = withTranslationErrors(() =>
      translateAnthropicToResponsesPayload(ctx.anthropicPayload, {
        reasoningEffortResolver: model => configStore.getReasoningEffort(model),
        supportedEfforts: ctx.selectedModel?.capabilities.supports.reasoning_effort,
      }),
    )

    shapeResponsesUpstreamPayload(responsesPayload, ctx.selectedModel, ctx.requestId)

    const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
    const strategy = createMessagesViaResponsesStrategy(
      ctx.copilotClient,
      responsesPayload,
      {
        vision,
        initiator,
        signal: ctx.upstreamSignal.signal,
        requestContext: ctx.requestContext,
        ...createResponsesTerminalObservers(ctx.requestId, ctx.upstreamSignal),
      },
    )
    return await runStrategy(strategy, ctx.upstreamSignal, {
      onStreamError: error => runtimeStore.recordStreamError(ctx.requestId, error),
    })
  },
}

const chatCompletionsEntry: StrategyEntry<StrategyContext> = {
  name: 'chat-completions',
  canHandle: (model, ctx) => resolveMessagesStrategyName(model, ctx?.anthropicPayload) === 'chat-completions',
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
