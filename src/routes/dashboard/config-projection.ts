import type { Model } from '~/types'
import type { DashboardBehavior, DashboardModel, DashboardWindowId } from '~/types/dashboard'

import { getModelFallbackConfig } from '~/lib/model-resolver'
import { PROXY_EFFECT_DEFINITIONS } from '~/observability/effects'
import { chatCompletionsStrategyRegistry } from '~/routes/chat-completions/strategy-registry'
import { defaultStrategyRegistry, resolveMessagesStrategyName } from '~/routes/messages/strategy-registry'
import { resolveResponsesStrategyName } from '~/routes/responses/capabilities'
import { responsesStrategyRegistry } from '~/routes/responses/strategy-registry'
import { configStore, getCurrentAccountName, MESSAGES_ENDPOINT, modelCache, RESPONSES_ENDPOINT, runtimeStore } from '~/state'
import { resolveResponsesCompactThreshold } from '~/transform/context-management'
import { getChatCompletionsTokenParameter, resolveStrippedResponsesParams, RESPONSES_MIN_OUTPUT_TOKENS } from '~/transform/parameter-filter'
import { RESPONSES_INPUT_POLICY } from '~/transform/responses-input'

export function getDashboardModels(): DashboardModel[] {
  return (modelCache.getModels()?.data ?? []).map(projectModel)
}

export function getDashboardBehavior(window: DashboardWindowId = '1h'): DashboardBehavior {
  const requestSummary = runtimeStore.requests.summary()
  const windowEffects = runtimeStore.requests.queryWindowEffects(window)
  const rewrites = configStore.getModelRewrites().map(rule => ({ ...rule }))
  const cachedModels = modelCache.getModels()
  const knownModelIds = cachedModels
    ? new Set(cachedModels.data.map(model => model.id))
    : undefined
  const effects = Object.entries(PROXY_EFFECT_DEFINITIONS).map(([id, definition]) => ({
    id,
    ...definition,
    count: requestSummary.effectCounts[id as keyof typeof requestSummary.effectCounts] ?? 0,
    windowCount: windowEffects.effects[id] ?? 0,
  }))

  return {
    hostTarget: getCurrentAccountName(),
    window,
    collectionStartedAt: windowEffects.collectionStartedAt,
    modelRouting: {
      rewrites,
      autoCorrect: { enabled: modelCache.getModelIds().length > 0 },
      compact: {
        enabled: configStore.isCompactSmallModelEnabled(),
        smallModel: configStore.getSmallModel(),
      },
      familyFallbacks: getModelFallbackConfig(knownModelIds),
      overloadFallbacks: configStore.getOverloadFallbacks(),
    },
    strategies: {
      messages: defaultStrategyRegistry.listNames(),
      responses: responsesStrategyRegistry.listNames(),
      chatCompletions: chatCompletionsStrategyRegistry.listNames(),
    },
    parameterHandling: {
      responsesFiltersReplaceDefault: configStore.shouldReplaceDefaultParameterFilters(),
      responsesFilters: configStore.getResponsesParameterFilters().map(rule => ({
        models: [...rule.models],
        params: [...rule.params],
      })),
      responsesOutputTokenFloor: RESPONSES_MIN_OUTPUT_TOKENS,
      chatMaxCompletionTokenModels: [...configStore.getChatCompletionsMaxCompletionTokensModels()],
    },
    contextManagement: {
      enabled: configStore.isContextManagementEnabled(),
      models: configStore.getContextManagementModels(),
      autoCompactInput: configStore.isAutoCompactResponsesInputEnabled(),
      defaultCompactThreshold: resolveResponsesCompactThreshold(),
    },
    toolCompatibility: {
      responsesChatCompletionsFallback: configStore.isResponsesChatCompletionsFallbackEnabled(),
      functionApplyPatch: configStore.isFunctionApplyPatchEnabled(),
      remoteResponsesImageUrlsRejected: RESPONSES_INPUT_POLICY.rejectsRemoteImageUrls,
      unresolvableResponsesItemsFiltered: RESPONSES_INPUT_POLICY.filtersUnresolvableItems,
    },
    effects,
  }
}

function projectModel(model: Model): DashboardModel {
  const nativeMessagesAvailable = modelCache.supportsEndpoint(model, MESSAGES_ENDPOINT)
  const responsesAvailable = modelCache.supportsEndpoint(model, RESPONSES_ENDPOINT)
  const nativeStructuredOutput = modelCache.supportsStructuredOutputs(model)
  const defaultResponsesStrategy = resolveResponsesStrategyName(model) ?? null
  const usesChatTranslation = defaultResponsesStrategy === 'responses-chat-completions'

  return {
    id: model.id,
    name: model.name,
    vendor: model.vendor,
    version: model.version,
    preview: model.preview,
    pickerEnabled: model.model_picker_enabled,
    upstream: {
      endpoints: (model.supported_endpoints ?? [])
        .filter(endpoint => endpoint.startsWith('/') && endpoint.length <= 128),
      capabilities: projectModelCapabilities(model.capabilities),
      ...(model.policy
        ? { policy: { state: model.policy.state, terms: model.policy.terms } }
        : {}),
    },
    effective: {
      defaultMessagesStrategy: resolveMessagesStrategyName(model),
      nativeMessagesAvailable,
      responsesAvailable,
      nativeResponsesAvailable: responsesAvailable,
      defaultResponsesStrategy,
      outputConfig: modelCache.supportsOutputConfig(model),
      nativeStructuredOutput,
      messagesStructuredOutput: nativeStructuredOutput || responsesAvailable,
      toolCalls: modelCache.supportsToolCalls(model),
      vision: modelCache.supportsVision(model),
      adaptiveThinking: modelCache.supportsAdaptiveThinking(model),
      reasoningEffort: model.capabilities?.supports?.reasoning_effort
        ? [...model.capabilities.supports.reasoning_effort]
        : [],
      responsesParameterFilters: usesChatTranslation ? [] : [...resolveStrippedResponsesParams(model)],
      contextManagement: !usesChatTranslation && configStore.isContextManagementModel(model.id),
      chatTokenParameter: getChatCompletionsTokenParameter(model.id),
    },
  }
}

function projectModelCapabilities(capabilities: Model['capabilities'] | undefined): DashboardModel['upstream']['capabilities'] {
  const limits = capabilities?.limits
  const supports = capabilities?.supports
  return {
    family: capabilities?.family,
    object: capabilities?.object,
    tokenizer: capabilities?.tokenizer,
    type: capabilities?.type,
    limits: {
      max_context_window_tokens: limits?.max_context_window_tokens,
      max_output_tokens: limits?.max_output_tokens,
      max_prompt_tokens: limits?.max_prompt_tokens,
      max_inputs: limits?.max_inputs,
      ...(limits?.vision
        ? {
            vision: {
              max_prompt_image_size: limits.vision.max_prompt_image_size,
              max_prompt_images: limits.vision.max_prompt_images,
              supported_media_types: limits.vision.supported_media_types
                ? [...limits.vision.supported_media_types]
                : undefined,
            },
          }
        : {}),
    },
    supports: {
      tool_calls: supports?.tool_calls,
      parallel_tool_calls: supports?.parallel_tool_calls,
      dimensions: supports?.dimensions,
      adaptive_thinking: supports?.adaptive_thinking,
      vision: supports?.vision,
      streaming: supports?.streaming,
      structured_outputs: supports?.structured_outputs,
      reasoning_effort: supports?.reasoning_effort
        ? [...supports.reasoning_effort]
        : undefined,
    },
  }
}
