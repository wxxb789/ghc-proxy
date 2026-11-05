// Contract-typed response factories. Every factory returns a complete payload;
// pass overrides for the fields a test cares about.
import type {
  AccountsResponse,
  BehaviorResponse,
  DashboardAccount,
  DashboardEnvelope,
  DashboardModel,
  DashboardQuota,
  M365Response,
  MetadataRefreshResponse,
  ModelsResponse,
  ObservedRequest,
  OverviewResponse,
  RequestsResponse,
} from '@contract'
import type { RouteHandler } from './fake-fetch.ts'
import { faults } from '../lib/store.svelte.ts'

const envelope: DashboardEnvelope = { schemaVersion: 1, generatedAt: '2026-11-05T14:02:11.000Z' }

export function quota(overrides: Partial<DashboardQuota> = {}): DashboardQuota {
  return {
    status: 'ok',
    fetchedAt: '2026-11-05T14:01:00.000Z',
    plan: 'individual',
    resetDate: '2026-12-01',
    premiumInteractions: { entitlement: 1000, remaining: 812, percentRemaining: 81.2, unlimited: false, overagePermitted: true },
    chat: { entitlement: 0, remaining: 0, percentRemaining: 100, unlimited: true, overagePermitted: false },
    completions: { entitlement: 0, remaining: 0, percentRemaining: 100, unlimited: true, overagePermitted: false },
    ...overrides,
  }
}

type OverviewOverrides = Partial<Omit<OverviewResponse, 'activity' | 'auth'>> & {
  activity?: Partial<OverviewResponse['activity']>
  queue?: Partial<OverviewResponse['activity']['upstreamQueue']>
  auth?: Partial<OverviewResponse['auth']>
}

export function overview(overrides: OverviewOverrides = {}): OverviewResponse {
  const { activity, queue, auth, ...rest } = overrides
  return {
    ...envelope,
    status: 'ok',
    version: '0.11.4',
    startedAt: '2026-11-05T10:50:04.000Z',
    uptimeMs: 11_527_000,
    auth: {
      upstream: 'github',
      github: { status: 'ok', login: 'octocat', lastValidatedAt: '2026-11-05T14:01:22.000Z', accountType: 'individual' },
      copilot: { status: 'ok', modelsLoaded: true, expiresAt: '2026-11-05T14:30:00.000Z', lastRefreshAt: '2026-11-05T14:01:55.000Z', lastRefreshSucceeded: true },
      accounts: { currentAccount: 'work', defaultAccount: 'personal', totalAccounts: 2 },
      ...auth,
    },
    quota: quota(),
    activity: {
      activeRequests: 0,
      recentRequests: 0,
      started: 0,
      completed: 0,
      failed: 0,
      aborted: 0,
      ...activity,
      upstreamQueue: { active: 0, concurrency: 4, pending: 0, maxPending: 64, accountCooldown: false, modelCooldowns: 0, ...queue },
    },
    ...rest,
  }
}

export function account(overrides: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    name: 'personal',
    hostname: 'personal.localhost',
    isDefault: false,
    upstream: 'github',
    tenant: 'github.com',
    github: { status: 'ok', login: 'octocat', lastValidatedAt: '2026-11-05T14:00:00.000Z', accountType: 'individual' },
    copilot: { status: 'ok', modelsLoaded: true, lastRefreshAt: '2026-11-05T14:02:00.000Z', lastRefreshSucceeded: true },
    quota: quota(),
    ...overrides,
  }
}

/** Routing mode: `personal` (default) and `work` (GHE). */
export function accountsRouting(overrides: Partial<AccountsResponse> = {}): AccountsResponse {
  return {
    ...envelope,
    baseHostname: 'localhost',
    defaultAccount: 'personal',
    routingEnabled: true,
    accounts: [
      account({ name: 'personal', hostname: 'personal.localhost', isDefault: true }),
      account({ name: 'work', hostname: 'work.localhost', tenant: 'company.ghe.com', github: { status: 'ok', login: 'octo-work', accountType: 'business' } }),
    ],
    ...overrides,
  }
}

/** Legacy mode (`routingEnabled: false`) with the default account on `default-account.localhost`. */
export function accountsLegacy(): AccountsResponse {
  return {
    ...envelope,
    baseHostname: 'localhost',
    defaultAccount: 'default',
    routingEnabled: false,
    accounts: [account({ name: 'default', hostname: 'default-account.localhost', isDefault: true })],
  }
}

/** Not registered; onboarding available unless overridden. */
export function m365Absent(overrides: Partial<M365Response> = {}): M365Response {
  return {
    ...envelope,
    registered: false,
    endpoint: 'https://substrate.office.com/m365Copilot/api/v1/llmapi',
    endpoints: ['https://substrate.office.com/m365Copilot/api/v1/llmapi'],
    modelCount: 0,
    models: [],
    routing: [],
    onboarding: { status: 'available' },
    ...overrides,
  }
}

/** Registered and ready, routed as `m365 → m365.localhost`. */
export function m365Ready(overrides: Partial<M365Response> = {}): M365Response {
  return m365Absent({
    registered: true,
    hostname: 'm365.localhost',
    account: 'home-account-id-1234567890',
    username: 'user@corp.com',
    tenant: 'contoso.onmicrosoft.com',
    tokenExpiresAt: '2026-11-05T15:00:00.000Z',
    modelCount: 2,
    models: ['claude-opus-5.5', 'gpt-5.4'],
    availability: { status: 'ready', updatedAt: 1 },
    routing: [
      { target: 'personal', hostname: 'personal.localhost', kind: 'github', isDefault: true },
      { target: 'm365', hostname: 'm365.localhost', kind: 'm365', isDefault: false },
    ],
    client: { baseUrl: 'http://m365.localhost:4141', model: 'claude-opus-5.5' },
    ...overrides,
  })
}

export function model(overrides: Partial<DashboardModel> & { id: string }): DashboardModel {
  return {
    name: overrides.id,
    vendor: 'Anthropic',
    version: '2026-09-01',
    preview: false,
    pickerEnabled: true,
    upstream: {
      endpoints: ['/v1/messages', '/chat/completions'],
      capabilities: {
        limits: { max_context_window_tokens: 200_000, max_prompt_tokens: 168_000, max_output_tokens: 64_000 },
        supports: { tool_calls: true, vision: true, reasoning_effort: ['low', 'high'], streaming: false, parallel: [] },
      },
    },
    effective: {
      defaultMessagesStrategy: 'native-messages',
      nativeMessagesAvailable: true,
      responsesAvailable: true,
      nativeResponsesAvailable: true,
      defaultResponsesStrategy: 'responses-passthrough',
      outputConfig: true,
      nativeStructuredOutput: true,
      messagesStructuredOutput: true,
      toolCalls: true,
      vision: true,
      adaptiveThinking: false,
      reasoningEffort: [],
      responsesParameterFilters: [],
      contextManagement: true,
      chatTokenParameter: 'max_tokens',
    },
    ...overrides,
  }
}

export function models(list: DashboardModel[] = []): ModelsResponse {
  return { ...envelope, models: list }
}

export function behavior(overrides: Partial<BehaviorResponse> = {}): BehaviorResponse {
  return {
    ...envelope,
    modelRouting: {
      rewrites: [],
      autoCorrect: { enabled: true },
      compact: { enabled: false },
      familyFallbacks: { claudeOpus: 'claude-opus-5.5', claudeSonnet: 'claude-sonnet-5', claudeHaiku: 'claude-haiku-4.5' },
      overloadFallbacks: {},
    },
    strategies: { messages: ['native-messages'], responses: ['responses-passthrough'], chatCompletions: ['chat-completions'] },
    parameterHandling: { responsesFiltersReplaceDefault: false, responsesFilters: [], responsesOutputTokenFloor: 16, chatMaxCompletionTokenModels: [] },
    contextManagement: { enabled: true, models: [], autoCompactInput: true, defaultCompactThreshold: 0.8 },
    toolCompatibility: { responsesChatCompletionsFallback: true, functionApplyPatch: true, remoteResponsesImageUrlsRejected: true, unresolvableResponsesItemsFiltered: true },
    effects: [{ id: 'recovery.retry', category: 'Recovery', label: 'Retry', count: 0 }],
    ...overrides,
  }
}

export function request(requestId: string, overrides: Partial<ObservedRequest> = {}): ObservedRequest {
  return {
    requestId,
    method: 'POST',
    endpoint: '/v1/messages',
    state: 'completed',
    startedAt: '2026-11-05T14:01:51.000Z',
    durationMs: 1100,
    status: 200,
    modelTransforms: [],
    effects: [],
    ...overrides,
  }
}

export function requests(overrides: Partial<RequestsResponse> = {}): RequestsResponse {
  return {
    ...envelope,
    capacity: 256,
    active: [],
    recent: [],
    totals: { started: 0, completed: 0, failed: 0, aborted: 0 },
    effectCounts: {},
    ...overrides,
  }
}

export function refreshResult(overrides: Partial<MetadataRefreshResponse> = {}): MetadataRefreshResponse {
  return { ...envelope, status: 'ok', accounts: [], ...overrides }
}

/** Fake routes answering every read-only Dashboard GET (routing accounts, absent M365). */
export function dashboardRoutes(overrides: Record<string, RouteHandler> = {}): Record<string, RouteHandler> {
  return {
    '/dashboard/api/overview': () => overview(),
    '/dashboard/api/accounts': () => accountsRouting(),
    '/dashboard/api/m365': () => m365Absent(),
    '/dashboard/api/models': () => models(),
    '/dashboard/api/behavior': () => behavior(),
    '/dashboard/api/requests': () => requests(),
    'POST /dashboard/api/refresh': () => refreshResult(),
    'POST /dashboard/api/m365/probe': () => ({ ...envelope, platformSupported: true, helperAvailable: true, accountCount: 0, accounts: [] }),
    ...overrides,
  }
}

/** Empties the fault store (a `$state` record, so keys are deleted in place). */
export function clearFaults(): void {
  for (const scope of Object.keys(faults) as Array<keyof typeof faults>)
    delete faults[scope]
}
