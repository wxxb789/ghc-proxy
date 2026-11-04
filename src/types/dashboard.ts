export const DASHBOARD_SCHEMA_VERSION = 2

export const DASHBOARD_PAGES = [
  'overview',
  'traffic',
  'requests',
  'targets',
  'models',
  'behavior',
] as const

export type DashboardPage = typeof DASHBOARD_PAGES[number]

export const DASHBOARD_WINDOWS = {
  '15m': { durationMs: 900_000, bucketMs: 10_000, slots: 90 },
  '1h': { durationMs: 3_600_000, bucketMs: 60_000, slots: 60 },
  '24h': { durationMs: 86_400_000, bucketMs: 900_000, slots: 96 },
} as const

export type DashboardWindowId = keyof typeof DASHBOARD_WINDOWS

export const LATENCY_BOUNDS_MS = [
  50,
  63,
  80,
  100,
  125,
  160,
  200,
  250,
  315,
  400,
  500,
  630,
  800,
  1000,
  1250,
  1600,
  2000,
  2500,
  3150,
  4000,
  5000,
  6300,
  8000,
  10000,
  12500,
  16000,
  20000,
  25000,
  31500,
  40000,
  50000,
  63000,
  80000,
  100000,
  125000,
  160000,
  200000,
  250000,
  315000,
  400000,
  500000,
  630000,
  800000,
  1000000,
  1250000,
  1600000,
  2000000,
] as const

export type DashboardTerminalState = 'completed' | 'failed' | 'aborted'

export interface DashboardStateCounts {
  completed: number
  failed: number
  aborted: number
}

export interface DashboardQuantile {
  valueMs: number
  kind: 'exact' | 'approximate' | 'at-most' | 'at-least'
}

export interface DashboardLatencySummary {
  count: number
  sumMs: number
  p50: DashboardQuantile | null
  p95: DashboardQuantile | null
}

export interface DashboardBreakdown {
  kind: 'named' | 'other' | 'none'
  value?: string
  requests: number
  failures: number
}

export interface DashboardMetricBucket {
  startMs: number
  endMs: number
  coverage: 'not-collected' | 'partial-start' | 'open' | 'full'
  counts: DashboardStateCounts
  latency: DashboardLatencySummary
  effects: Record<string, number>
}

export interface DashboardMetrics {
  window: DashboardWindowId
  bucketMs: number
  collectionStartedAt: string
  startMs: number
  endMs: number
  coveredMs: number
  counts: DashboardStateCounts
  latency: DashboardLatencySummary & { histogram: number[] }
  latencyBoundsMs: readonly number[]
  series: DashboardMetricBucket[]
  byModel: DashboardBreakdown[]
  byTarget: DashboardBreakdown[]
  byEndpoint: DashboardBreakdown[]
  effects: Record<string, number>
}

export interface DashboardEnvelope {
  schemaVersion: typeof DASHBOARD_SCHEMA_VERSION
  generatedAt: string
  startedAt: string
}

export type DashboardResponse<T> = T & DashboardEnvelope

export interface DashboardQueue {
  active: number
  concurrency: number
  pending: number
  maxPending: number
  accountCooldown: boolean
  modelCooldowns: number
}

export interface DashboardCapabilities {
  canAddAccount: boolean
  canBootstrap: boolean
  canManageM365: boolean
  canRefreshMetadata: boolean
  refreshUnavailableReason?: string
}

export interface DashboardRouting {
  baseHostname: string
  defaultAccount: string
  routingEnabled: boolean
}

export interface DashboardTarget {
  runtimeId: string
  name: string
  hostname: string
  isDefault: boolean
  kind: 'github' | 'm365'
  identity?: string
  tenant: string
  health: {
    status: 'ok' | 'degraded'
    github: {
      status: 'ok' | 'unknown' | 'missing' | 'not_applicable'
      login?: string
      lastValidatedAt?: string
      accountType?: string
    }
    copilot: {
      status: 'ok' | 'degraded' | 'missing'
      modelsLoaded: boolean
      expiresAt?: string
      lastRefreshAt?: string
      lastRefreshSucceeded?: boolean
    }
  }
  queue: DashboardQueue
  actions: { canSetDefault: boolean, canRemove: boolean }
  client: { openAIBaseUrl: string, anthropicBaseUrl: string, model?: string }
}

export interface DashboardTargets {
  hostTarget: string
  routing: DashboardRouting
  capabilities: DashboardCapabilities
  targets: DashboardTarget[]
}

export interface DashboardQuotaDetail {
  entitlement: number
  remaining: number
  percentRemaining: number
  unlimited: boolean
  overagePermitted: boolean
}

export interface DashboardQuota {
  status: 'ok' | 'stale' | 'unavailable' | 'not_applicable'
  fetchedAt?: string
  plan?: string
  resetDate?: string
  chat?: DashboardQuotaDetail
  completions?: DashboardQuotaDetail
  premiumInteractions?: DashboardQuotaDetail
}

export interface DashboardTargetQuota {
  target: string
  runtimeId: string
  quota: DashboardQuota
}

export interface DashboardRequestTotals {
  started: number
  completed: number
  failed: number
  aborted: number
}

export interface DashboardOverview {
  status: 'ok' | 'degraded'
  version: string
  startedAt: string
  uptimeMs: number
  hostTarget: string
  capabilities: DashboardCapabilities
  activity: DashboardRequestTotals & {
    activeRequests: number
    recentRequests: number
    upstreamQueue: DashboardQueue
  }
}

export type DashboardRequestState = DashboardTerminalState | 'in_flight' | 'streaming'

export interface DashboardRequest {
  requestId: string
  accountName?: string
  method: string
  endpoint: string
  state: DashboardRequestState
  startedAt: string
  durationMs: number
  status?: number
  requestedModel?: string
  effectiveModel?: string
  modelTransforms: { tag: string, from: string, to: string }[]
  selectedStrategy?: string
  effects: { id: string, count: number }[]
  errorSummary?: string
}

export interface DashboardRequests {
  capacity: number
  active: DashboardRequest[]
  recent: DashboardRequest[]
  // Cumulative completed includes failed; window terminal counts are exclusive.
  totals: DashboardRequestTotals
  effectCounts: Partial<Record<string, number>>
}

export interface DashboardModel {
  id: string
  name: string
  vendor: string
  version: string
  preview: boolean
  pickerEnabled: boolean
  upstream: {
    endpoints: string[]
    policy?: { state: string, terms: string }
    capabilities: {
      family?: string
      object?: string
      tokenizer?: string
      type?: string
      limits: {
        max_context_window_tokens?: number
        max_output_tokens?: number
        max_prompt_tokens?: number
        max_inputs?: number
        vision?: {
          max_prompt_image_size?: number
          max_prompt_images?: number
          supported_media_types?: string[]
        }
      }
      supports: {
        tool_calls?: boolean
        parallel_tool_calls?: boolean
        dimensions?: boolean
        adaptive_thinking?: boolean
        vision?: boolean
        streaming?: boolean
        structured_outputs?: boolean
        reasoning_effort?: string[]
      }
    }
  }
  effective: {
    defaultMessagesStrategy: string
    nativeMessagesAvailable: boolean
    responsesAvailable: boolean
    nativeResponsesAvailable: boolean
    defaultResponsesStrategy: string | null
    outputConfig: boolean
    nativeStructuredOutput: boolean
    messagesStructuredOutput: boolean
    toolCalls: boolean
    vision: boolean
    adaptiveThinking: boolean
    reasoningEffort: string[]
    responsesParameterFilters: string[]
    contextManagement: boolean
    chatTokenParameter: 'max_tokens' | 'max_completion_tokens'
  }
}

export interface DashboardModels {
  hostTarget: string
  apiBaseUrl: string
  models: DashboardModel[]
}

export interface DashboardBehavior {
  hostTarget: string
  window: DashboardWindowId
  collectionStartedAt: string
  modelRouting: {
    rewrites: { from: string, to: string }[]
    autoCorrect: { enabled: boolean }
    compact: { enabled: boolean, smallModel?: string }
    familyFallbacks: { claudeOpus: string, claudeSonnet: string, claudeHaiku: string }
    overloadFallbacks: Record<string, string>
  }
  strategies: { messages: string[], responses: string[], chatCompletions: string[] }
  parameterHandling: {
    responsesFiltersReplaceDefault: boolean
    responsesFilters: { models: string[], params: string[] }[]
    responsesOutputTokenFloor: number
    chatMaxCompletionTokenModels: string[]
  }
  contextManagement: {
    enabled: boolean
    models: string[]
    autoCompactInput: boolean
    defaultCompactThreshold: number
  }
  toolCompatibility: {
    responsesChatCompletionsFallback: boolean
    functionApplyPatch: boolean
    remoteResponsesImageUrlsRejected: boolean
    unresolvableResponsesItemsFiltered: boolean
  }
  effects: { id: string, category: string, label: string, count: number, windowCount: number }[]
}

export type DashboardMetadataStatus = 'ok' | 'stale' | 'unavailable' | 'not_applicable'

export interface DashboardAccountMetadataRefresh {
  github: { status: DashboardMetadataStatus }
  models: { status: DashboardMetadataStatus }
  name: string
  quota: { status: DashboardQuota['status'] }
}

export interface DashboardMetadataRefresh {
  accounts: DashboardAccountMetadataRefresh[]
  status: 'ok' | 'partial' | 'unavailable'
}

export interface DashboardAddAccount {
  accountName: string
  hostname: string
  gheDomain?: string
}

export interface DashboardAuthentication {
  accountName: string
  authorization: {
    expiresAt: string
    pollIntervalSeconds: number
    userCode: string
    verificationUri: string
  }
  hostname: string
  id: string
  message?: string
  state: 'pending' | 'succeeded' | 'failed'
}

export interface DashboardAuthenticationResult {
  authentication: DashboardAuthentication
}

export interface DashboardM365Account {
  upn: string
  homeAccountId: string
  environment: string
}

export interface DashboardM365Readiness {
  platformSupported: boolean
  helperAvailable: boolean
  accountCount?: number
  accounts?: DashboardM365Account[]
  failedStep?: 'platform' | 'helper' | 'accounts'
  error?: string
}

export interface DashboardM365 {
  platformSupported: boolean
  registered: boolean
  hostname?: string
  account?: string
  username?: string
  tenant?: string
  tokenExpiresAt?: string
  modelCount: number
  models: string[]
  availability?: { status: 'ready' | 'unavailable', cause?: string, updatedAt: number }
  routing: { target: string, hostname: string, kind: 'github' | 'm365', isDefault: boolean }[]
  client?: { baseUrl: string, model: string }
  onboarding: { status: 'available' | 'unavailable', reason?: string }
}

export interface DashboardM365Input {
  account?: string | null
  hostname?: string
}

export interface DashboardM365SignIn {
  account: DashboardM365Account
}
