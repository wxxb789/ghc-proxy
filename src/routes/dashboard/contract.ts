/**
 * Wire contract of the Dashboard JSON API, shared with the browser UI in
 * `ui/` via `import type`. Self-contained on purpose: the UI type program
 * must not pull in server modules. `tests/dashboard-contract.test.ts` checks
 * these shapes against the server's own types so the two cannot drift.
 */

export type IsoString = string
export type Upstream = 'github' | 'm365'

export interface DashboardEnvelope {
  schemaVersion: 1
  generatedAt: IsoString
}

export interface DashboardErrorBody {
  error: { message: string, type: string }
}

export interface DashboardQuotaDetail {
  entitlement: number
  remaining: number
  percentRemaining: number
  unlimited: boolean
  overagePermitted: boolean
}

export type DashboardQuotaStatus = 'ok' | 'stale' | 'unavailable' | 'not_applicable'

export interface DashboardQuota {
  status: DashboardQuotaStatus
  fetchedAt?: IsoString
  plan?: string
  resetDate?: string
  chat?: DashboardQuotaDetail
  completions?: DashboardQuotaDetail
  premiumInteractions?: DashboardQuotaDetail
}

export interface DashboardGithubHealth {
  status: 'ok' | 'unknown' | 'missing' | 'not_applicable'
  login?: string
  lastValidatedAt?: IsoString
  accountType: 'individual' | 'business' | 'enterprise'
}

export interface DashboardCopilotHealth {
  status: 'ok' | 'degraded' | 'missing'
  modelsLoaded: boolean
  expiresAt?: IsoString
  lastRefreshAt?: IsoString
  lastRefreshSucceeded?: boolean
}

export interface UpstreamQueueSnapshot {
  active: number
  concurrency: number
  pending: number
  maxPending: number
  accountCooldown: boolean
  modelCooldowns: number
}

export interface OverviewResponse extends DashboardEnvelope {
  status: 'ok' | 'degraded'
  version: string
  startedAt: IsoString
  uptimeMs: number
  auth: {
    upstream: Upstream
    identity?: string
    github: DashboardGithubHealth
    copilot: DashboardCopilotHealth
    accounts: {
      currentAccount: string
      defaultAccount: string
      totalAccounts: number
    }
  }
  quota: DashboardQuota
  activity: {
    activeRequests: number
    recentRequests: number
    started: number
    completed: number
    failed: number
    aborted: number
    upstreamQueue: UpstreamQueueSnapshot
  }
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
      supports: Record<string, boolean | string[] | undefined>
    }
    policy?: { state: string, terms: string }
  }
  effective: {
    defaultMessagesStrategy: string
    nativeMessagesAvailable: boolean
    responsesAvailable: boolean
    nativeResponsesAvailable: boolean
    defaultResponsesStrategy: 'responses-passthrough' | 'responses-chat-completions' | null
    outputConfig: boolean
    nativeStructuredOutput: boolean
    messagesStructuredOutput: boolean
    toolCalls: boolean
    vision: boolean
    adaptiveThinking: boolean
    reasoningEffort: string[]
    responsesParameterFilters: string[]
    contextManagement: boolean
    chatTokenParameter: string
  }
}

export interface ModelsResponse extends DashboardEnvelope {
  models: DashboardModel[]
}

export interface BehaviorEffect {
  id: string
  category: string
  label: string
  count: number
}

export interface BehaviorResponse extends DashboardEnvelope {
  modelRouting: {
    rewrites: Array<{ from: string, to: string }>
    autoCorrect: { enabled: boolean }
    compact: { enabled: boolean, smallModel?: string }
    familyFallbacks: { claudeOpus: string, claudeSonnet: string, claudeHaiku: string }
    overloadFallbacks: Record<string, string>
  }
  strategies: {
    messages: string[]
    responses: string[]
    chatCompletions: string[]
  }
  parameterHandling: {
    responsesFiltersReplaceDefault: boolean
    responsesFilters: Array<{ models: string[], params: string[] }>
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
  effects: BehaviorEffect[]
}

export type ObservedRequestState = 'in_flight' | 'streaming' | 'completed' | 'failed' | 'aborted'

export interface ObservedRequest {
  requestId: string
  accountName?: string
  method: string
  endpoint: string
  state: ObservedRequestState
  startedAt: IsoString
  durationMs: number
  status?: number
  requestedModel?: string
  effectiveModel?: string
  modelTransforms: Array<{ tag: string, from: string, to: string }>
  selectedStrategy?: string
  effects: Array<{ id: string, count: number }>
  errorSummary?: string
}

export interface RequestsResponse extends DashboardEnvelope {
  capacity: number
  active: ObservedRequest[]
  recent: ObservedRequest[]
  totals: { started: number, completed: number, failed: number, aborted: number }
  effectCounts: Record<string, number | undefined>
}

export interface AccountRoutingSummary {
  baseHostname: string
  defaultAccount: string
  routingEnabled: boolean
}

export interface DashboardAccount {
  name: string
  hostname: string
  isDefault: boolean
  upstream: Upstream
  identity?: string
  tenant: string
  github: DashboardGithubHealth
  copilot: DashboardCopilotHealth
  quota: DashboardQuota
}

export interface AccountsResponse extends DashboardEnvelope, AccountRoutingSummary {
  accounts: DashboardAccount[]
}

export interface RoutingSummaryResponse extends DashboardEnvelope, AccountRoutingSummary {}

export interface AccountAuthenticationSession {
  id: string
  state: 'pending' | 'succeeded' | 'failed'
  accountName: string
  hostname: string
  authorization: {
    expiresAt: IsoString
    pollIntervalSeconds: number
    userCode: string
    verificationUri: string
  }
  message?: string
}

export interface AccountAuthenticationResponse extends DashboardEnvelope {
  authentication: AccountAuthenticationSession
}

export interface MscAccount {
  upn: string
  homeAccountId: string
  environment: string
}

export interface M365RoutingRow {
  target: string
  hostname: string
  kind: Upstream
  isDefault: boolean
}

export interface M365DashboardState {
  registered: boolean
  endpoint: string
  endpoints: string[]
  hostname?: string
  account?: string
  username?: string
  tenant?: string
  tokenExpiresAt?: IsoString
  modelCount: number
  models: string[]
  availability?: { status: 'ready' | 'unavailable', cause?: string, updatedAt: number }
  routing: M365RoutingRow[]
  client?: { baseUrl: string, model: string }
  onboarding: { status: 'available' | 'unavailable', reason?: string }
}

export interface M365Response extends DashboardEnvelope, M365DashboardState {}

export interface M365ProbeResponse extends DashboardEnvelope {
  platformSupported: boolean
  helperAvailable: boolean
  accountCount?: number
  accounts?: MscAccount[]
  failedStep?: 'platform' | 'helper' | 'accounts'
  error?: string
}

export interface M365SignInResponse extends DashboardEnvelope {
  account: MscAccount
}

export type DashboardMetadataStatus = 'ok' | 'stale' | 'unavailable' | 'not_applicable'

export interface MetadataRefreshResponse extends DashboardEnvelope {
  status: 'ok' | 'partial' | 'unavailable'
  accounts: Array<{
    name: string
    github: { status: DashboardMetadataStatus }
    models: { status: DashboardMetadataStatus }
    quota: { status: DashboardQuotaStatus }
  }>
}

/** Request bodies accepted by the mutating endpoints (route.ts zod schemas are strict). */
export interface AddAccountBody { accountName: string, hostname: string, gheDomain?: string }
export interface BootstrapRoutingBody { hostname: string }
export interface SetDefaultAccountBody { accountName: string }
export interface M365TargetBody { account?: string | null, hostname?: string, endpoint?: string }
export interface M365SignInBody { upn?: string }
export interface M365EndpointBody { endpoint: string, endpoints?: string[] }
