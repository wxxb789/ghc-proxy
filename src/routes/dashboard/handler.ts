import type { CopilotUsageResponse, Model, QuotaDetail } from '~/types'

import { getUpstreamRequestQueueSnapshot } from '~/clients/factory'
import { getModelFallbackConfig } from '~/lib/model-resolver'
import { PROXY_EFFECT_DEFINITIONS } from '~/observability/effects'
import { chatCompletionsStrategyRegistry } from '~/routes/chat-completions/strategy-registry'
import { defaultStrategyRegistry, resolveMessagesStrategyName } from '~/routes/messages/strategy-registry'
import { RESPONSES_INPUT_POLICY } from '~/routes/responses/handler'
import { responsesStrategyRegistry } from '~/routes/responses/strategy-registry'
import { handleUsageCore } from '~/routes/usage/handler'
import { authStore, configStore, MESSAGES_ENDPOINT, modelCache, RESPONSES_ENDPOINT, runtimeStore } from '~/state'
import { resolveResponsesCompactThreshold } from '~/transform/context-management'
import { getChatCompletionsTokenParameter, resolveStrippedResponsesParams, RESPONSES_MIN_OUTPUT_TOKENS } from '~/transform/parameter-filter'
import { VERSION } from '~/util/version'

const DEFAULT_QUOTA_TTL_MS = 60_000
const DEFAULT_QUOTA_TIMEOUT_MS = 5_000

export interface DashboardQuota {
  status: 'ok' | 'stale' | 'unavailable'
  fetchedAt?: string
  plan?: string
  resetDate?: string
  chat?: DashboardQuotaDetail
  completions?: DashboardQuotaDetail
  premiumInteractions?: DashboardQuotaDetail
}

interface DashboardQuotaDetail {
  entitlement: number
  remaining: number
  percentRemaining: number
  unlimited: boolean
  overagePermitted: boolean
}

export class DashboardQuotaCache {
  private cached?: { expiresAt: number, value: DashboardQuota }
  private inFlight?: Promise<DashboardQuota>
  private readonly load: (signal?: AbortSignal) => Promise<CopilotUsageResponse>
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly timeoutMs: number

  constructor(
    load: (signal?: AbortSignal) => Promise<CopilotUsageResponse> = handleUsageCore,
    now: () => number = Date.now,
    ttlMs = DEFAULT_QUOTA_TTL_MS,
    timeoutMs = DEFAULT_QUOTA_TIMEOUT_MS,
  ) {
    this.load = load
    this.now = now
    this.ttlMs = ttlMs
    this.timeoutMs = timeoutMs
  }

  get(): Promise<DashboardQuota> {
    const now = this.now()
    if (this.cached && now < this.cached.expiresAt)
      return Promise.resolve(this.cached.value)
    if (this.inFlight)
      return this.inFlight

    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new DOMException('Dashboard quota request timed out.', 'TimeoutError')
        controller.abort(error)
        reject(error)
      }, this.timeoutMs)
    })

    this.inFlight = Promise.race([this.load(controller.signal), timeoutPromise])
      .then((usage) => {
        const fetchedAt = this.now()
        const value = projectQuota(usage, fetchedAt)
        this.cached = { expiresAt: fetchedAt + this.ttlMs, value }
        return value
      })
      .catch(() => {
        const value: DashboardQuota = this.cached
          ? { ...this.cached.value, status: 'stale' }
          : { status: 'unavailable' }
        this.cached = {
          expiresAt: this.now() + this.ttlMs,
          value,
        }
        return value
      })
      .finally(() => {
        if (timeout !== undefined)
          clearTimeout(timeout)
        this.inFlight = undefined
      })
    return this.inFlight
  }

  reset(): void {
    this.cached = undefined
    this.inFlight = undefined
  }
}

export const dashboardQuotaCache = new DashboardQuotaCache()

export function getDashboardModels() {
  return (modelCache.getModels()?.data ?? []).map(projectModel)
}

export function getDashboardBehavior() {
  const requestSummary = runtimeStore.requests.summary()
  const rewrites = configStore.getModelRewrites().map(rule => ({ ...rule }))
  const effects = Object.entries(PROXY_EFFECT_DEFINITIONS).map(([id, definition]) => ({
    id,
    ...definition,
    count: requestSummary.effectCounts[id as keyof typeof requestSummary.effectCounts] ?? 0,
  }))

  return {
    modelRouting: {
      rewrites,
      autoCorrect: { enabled: modelCache.getModelIds().length > 0 },
      compact: {
        enabled: configStore.isCompactSmallModelEnabled(),
        smallModel: configStore.getSmallModel(),
      },
      familyFallbacks: getModelFallbackConfig(),
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
      functionApplyPatch: configStore.isFunctionApplyPatchEnabled(),
      remoteResponsesImageUrlsRejected: RESPONSES_INPUT_POLICY.rejectsRemoteImageUrls,
      unresolvableResponsesItemsFiltered: RESPONSES_INPUT_POLICY.filtersUnresolvableItems,
    },
    effects,
  }
}

export async function getDashboardOverview(
  quotaCache: DashboardQuotaCache = dashboardQuotaCache,
) {
  const requests = runtimeStore.requests.summary()
  const modelsLoaded = modelCache.getModels() !== undefined
  const githubConfigured = Boolean(authStore.githubToken)
  const copilotConfigured = Boolean(authStore.copilotToken)
  const copilotExpired = authStore.copilotTokenExpiresAt !== undefined
    && authStore.copilotTokenExpiresAt <= Date.now()
  const copilotHealthy = copilotConfigured
    && modelsLoaded
    && !copilotExpired
    && authStore.copilotTokenLastRefreshSucceeded !== false
  const quota = githubConfigured
    ? await quotaCache.get()
    : { status: 'unavailable' as const }

  return {
    status: copilotHealthy ? 'ok' : 'degraded',
    version: VERSION,
    startedAt: runtimeStore.startedAt,
    uptimeMs: Math.max(0, Date.now() - Date.parse(runtimeStore.startedAt)),
    auth: {
      github: {
        status: githubConfigured
          ? authStore.githubValidatedAt ? 'ok' : 'unknown'
          : 'missing',
        login: authStore.githubLogin,
        lastValidatedAt: toIso(authStore.githubValidatedAt),
        accountType: authStore.accountType,
      },
      copilot: {
        status: copilotConfigured
          ? copilotHealthy ? 'ok' : 'degraded'
          : 'missing',
        modelsLoaded,
        expiresAt: toIso(authStore.copilotTokenExpiresAt),
        lastRefreshAt: toIso(authStore.copilotTokenLastRefreshAt),
        lastRefreshSucceeded: authStore.copilotTokenLastRefreshSucceeded,
      },
    },
    quota,
    activity: {
      activeRequests: requests.active,
      recentRequests: requests.recent,
      ...requests.totals,
      upstreamQueue: getUpstreamRequestQueueSnapshot(),
    },
  }
}

export function getDashboardRequests() {
  return runtimeStore.requests.snapshot()
}

function projectModel(model: Model) {
  const nativeMessagesAvailable = modelCache.supportsEndpoint(model, MESSAGES_ENDPOINT)
  const responsesAvailable = modelCache.supportsEndpoint(model, RESPONSES_ENDPOINT)
  const nativeStructuredOutput = modelCache.supportsStructuredOutputs(model)

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
      outputConfig: modelCache.supportsOutputConfig(model),
      nativeStructuredOutput,
      messagesStructuredOutput: nativeStructuredOutput || responsesAvailable,
      toolCalls: modelCache.supportsToolCalls(model),
      vision: modelCache.supportsVision(model),
      adaptiveThinking: modelCache.supportsAdaptiveThinking(model),
      reasoningEffort: model.capabilities?.supports?.reasoning_effort
        ? [...model.capabilities.supports.reasoning_effort]
        : [],
      responsesParameterFilters: [...resolveStrippedResponsesParams(model)],
      contextManagement: configStore.isContextManagementModel(model.id),
      chatTokenParameter: getChatCompletionsTokenParameter(model.id),
    },
  }
}

function projectModelCapabilities(capabilities: Model['capabilities'] | undefined) {
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

function projectQuota(usage: CopilotUsageResponse, fetchedAt: number): DashboardQuota {
  return {
    status: 'ok',
    fetchedAt: new Date(fetchedAt).toISOString(),
    plan: usage.copilot_plan,
    resetDate: usage.quota_reset_date,
    chat: projectQuotaDetail(usage.quota_snapshots.chat),
    completions: projectQuotaDetail(usage.quota_snapshots.completions),
    premiumInteractions: projectQuotaDetail(usage.quota_snapshots.premium_interactions),
  }
}

function projectQuotaDetail(quota: QuotaDetail): DashboardQuotaDetail {
  return {
    entitlement: quota.entitlement,
    remaining: quota.remaining,
    percentRemaining: quota.percent_remaining,
    unlimited: quota.unlimited,
    overagePermitted: quota.overage_permitted,
  }
}

function toIso(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined)
    return undefined
  const value = new Date(timestamp)
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
}
