import type { RoutedAccountDescriptor } from '~/accounts/descriptor'
import type { AccountManagementSnapshot } from '~/accounts/manager'
import type { AccountRuntime } from '~/state/account-runtime'
import type { CopilotUsageResponse, Model, QuotaDetail } from '~/types'

import { getUpstreamRequestQueueSnapshot } from '~/clients/factory'
import { getModelFallbackConfig } from '~/lib/model-resolver'
import { PROXY_EFFECT_DEFINITIONS } from '~/observability/effects'
import { chatCompletionsStrategyRegistry } from '~/routes/chat-completions/strategy-registry'
import { defaultStrategyRegistry, resolveMessagesStrategyName } from '~/routes/messages/strategy-registry'
import { resolveResponsesStrategyName } from '~/routes/responses/capabilities'
import { responsesStrategyRegistry } from '~/routes/responses/strategy-registry'
import { handleUsageCore } from '~/routes/usage/handler'
import { authStore, configStore, getCurrentAccountName, MESSAGES_ENDPOINT, modelCache, RESPONSES_ENDPOINT, runtimeStore, runWithAccountRuntime } from '~/state'
import { getCurrentAccountRuntime, getTargetAvailability } from '~/state/account-runtime'
import { resolveResponsesCompactThreshold } from '~/transform/context-management'
import { getChatCompletionsTokenParameter, resolveStrippedResponsesParams, RESPONSES_MIN_OUTPUT_TOKENS } from '~/transform/parameter-filter'
import { RESPONSES_INPUT_POLICY } from '~/transform/responses-input'
import { VERSION } from '~/util/version'

const DEFAULT_QUOTA_TTL_MS = 60_000
const DEFAULT_QUOTA_TIMEOUT_MS = 5_000

export interface DashboardQuota {
  status: 'ok' | 'stale' | 'unavailable' | 'not_applicable'
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
  private cached = new WeakMap<AccountRuntime, { expiresAt: number, value: DashboardQuota }>()
  private inFlight = new WeakMap<AccountRuntime, Promise<DashboardQuota>>()
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
    return this.loadQuota(false)
  }

  refresh(): Promise<DashboardQuota> {
    return this.loadQuota(true)
  }

  private loadQuota(force: boolean): Promise<DashboardQuota> {
    const account = getCurrentAccountRuntime()
    const cache = this.cached
    const inFlightLoads = this.inFlight
    const now = this.now()
    const cached = cache.get(account)
    if (!force && cached && now < cached.expiresAt)
      return Promise.resolve(cached.value)
    const inFlight = inFlightLoads.get(account)
    if (inFlight)
      return inFlight

    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new DOMException('Dashboard quota request timed out.', 'TimeoutError')
        controller.abort(error)
        reject(error)
      }, this.timeoutMs)
    })

    const load = Promise.race([this.load(controller.signal), timeoutPromise])
      .then((usage) => {
        const fetchedAt = this.now()
        const value = projectQuota(usage, fetchedAt)
        cache.set(account, { expiresAt: fetchedAt + this.ttlMs, value })
        return value
      })
      .catch(() => {
        const lastValue = cache.get(account)
        const value: DashboardQuota = lastValue
          ? { ...lastValue.value, status: 'stale' }
          : { status: 'unavailable' }
        cache.set(account, {
          expiresAt: this.now() + this.ttlMs,
          value,
        })
        return value
      })
      .finally(() => {
        if (timeout !== undefined)
          clearTimeout(timeout)
        inFlightLoads.delete(account)
      })
    inFlightLoads.set(account, load)
    return load
  }

  reset(): void {
    this.cached = new WeakMap()
    this.inFlight = new WeakMap()
  }
}

export const dashboardQuotaCache = new DashboardQuotaCache()

export async function getDashboardAccount(
  account: RoutedAccountDescriptor,
  quotaCache: DashboardQuotaCache = dashboardQuotaCache,
) {
  return runWithAccountRuntime(account.runtime, async () => {
    const health = await getDashboardAccountHealth(quotaCache)
    return {
      name: account.name,
      hostname: account.hostname,
      isDefault: account.isDefault,
      upstream: authStore.upstream,
      identity: authStore.upstream === 'm365'
        ? authStore.mscAuthUsername ?? authStore.mscAuthUpn
        : authStore.githubLogin,
      tenant: authStore.upstream === 'm365'
        ? authStore.mscAuthTenant || 'Microsoft 365'
        : authStore.gheDomain ?? 'github.com',
      github: health.github,
      copilot: health.copilot,
      quota: health.quota,
    }
  })
}

export function getDashboardModels() {
  return (modelCache.getModels()?.data ?? []).map(projectModel)
}

export function getDashboardBehavior() {
  const requestSummary = runtimeStore.requests.summary()
  const rewrites = configStore.getModelRewrites().map(rule => ({ ...rule }))
  const cachedModels = modelCache.getModels()
  const knownModelIds = cachedModels
    ? new Set(cachedModels.data.map(model => model.id))
    : undefined
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

export async function getDashboardOverview(
  quotaCache: DashboardQuotaCache = dashboardQuotaCache,
  accountSnapshot?: AccountManagementSnapshot,
) {
  const requests = runtimeStore.requests.summary()
  const account = await getDashboardAccountHealth(quotaCache)

  return {
    status: account.status,
    version: VERSION,
    startedAt: runtimeStore.startedAt,
    uptimeMs: Math.max(0, Date.now() - Date.parse(runtimeStore.startedAt)),
    auth: {
      upstream: authStore.upstream,
      identity: authStore.upstream === 'm365'
        ? authStore.mscAuthUsername ?? authStore.mscAuthUpn
        : authStore.githubLogin,
      github: account.github,
      copilot: account.copilot,
      accounts: {
        currentAccount: getCurrentAccountName(),
        defaultAccount: accountSnapshot?.routing.defaultAccount ?? getCurrentAccountName(),
        totalAccounts: accountSnapshot?.accounts.length ?? 1,
      },
    },
    quota: account.quota,
    activity: {
      activeRequests: requests.active,
      recentRequests: requests.recent,
      ...requests.totals,
      upstreamQueue: getUpstreamRequestQueueSnapshot(),
    },
  }
}

async function getDashboardAccountHealth(
  quotaCache: DashboardQuotaCache,
) {
  const modelsLoaded = modelCache.getModels() !== undefined
  const isM365 = authStore.upstream === 'm365'
  const githubConfigured = Boolean(authStore.githubToken)
  const copilotConfigured = Boolean(authStore.copilotToken)
  const copilotExpired = authStore.copilotTokenExpiresAt !== undefined
    && authStore.copilotTokenExpiresAt <= Date.now()
  const copilotHealthy = copilotConfigured
    && modelsLoaded
    && !copilotExpired
    && authStore.copilotTokenLastRefreshSucceeded !== false
    && (!isM365 || getTargetAvailability(getCurrentAccountRuntime())?.status !== 'unavailable')
  const quota: DashboardQuota = isM365
    ? { status: 'not_applicable' }
    : githubConfigured
      ? await quotaCache.get()
      : { status: 'unavailable' }

  return {
    status: copilotHealthy ? 'ok' as const : 'degraded' as const,
    github: {
      status: isM365
        ? 'not_applicable' as const
        : githubConfigured
          ? authStore.githubValidatedAt ? 'ok' as const : 'unknown' as const
          : 'missing' as const,
      login: authStore.githubLogin,
      lastValidatedAt: toIso(authStore.githubValidatedAt),
      accountType: authStore.accountType,
    },
    copilot: {
      status: copilotConfigured
        ? copilotHealthy ? 'ok' as const : 'degraded' as const
        : 'missing' as const,
      modelsLoaded,
      expiresAt: toIso(authStore.copilotTokenExpiresAt),
      lastRefreshAt: toIso(authStore.copilotTokenLastRefreshAt),
      lastRefreshSucceeded: authStore.copilotTokenLastRefreshSucceeded,
    },
    quota,
  }
}

export function getDashboardRequests() {
  return runtimeStore.requests.snapshot()
}

function projectModel(model: Model) {
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
