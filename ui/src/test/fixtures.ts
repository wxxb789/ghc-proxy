import type { DashboardAuthentication, DashboardEnvelope, DashboardModel, DashboardRequest, DashboardTarget, DashboardWindowId } from '@contract'
import type {
  AuthenticationResult,
  BehaviorResult,
  Fetch,
  M365ReadinessResult,
  M365Result,
  M365SignInResult,
  MetricsResult,
  ModelsResult,
  OverviewResult,
  QuotaResult,
  RefreshResult,
  RequestsResult,
  RoutingResult,
  TargetsResult,
} from '../lib/api'
import { DASHBOARD_SCHEMA_VERSION, DASHBOARD_WINDOWS, LATENCY_BOUNDS_MS } from '@contract'

export const FIXTURE_STARTED_AT = '2026-11-04T00:00:00.000Z'
export const FIXTURE_GENERATED_AT = '2026-11-04T00:10:00.000Z'
export function envelope(overrides: Partial<DashboardEnvelope> = {}): DashboardEnvelope {
  return { schemaVersion: DASHBOARD_SCHEMA_VERSION, startedAt: FIXTURE_STARTED_AT, generatedAt: FIXTURE_GENERATED_AT, ...overrides }
}

export function targetFixture(overrides: Partial<DashboardTarget> = {}): DashboardTarget {
  return {
    runtimeId: 'target-work-1',
    name: 'work',
    hostname: 'work.localhost',
    isDefault: true,
    kind: 'github',
    identity: 'operator',
    tenant: 'github.com',
    health: { status: 'ok', github: { status: 'ok', login: 'operator' }, copilot: { status: 'ok', modelsLoaded: true } },
    queue: { active: 0, concurrency: 4, pending: 0, maxPending: 16, accountCooldown: false, modelCooldowns: 0 },
    actions: { canSetDefault: false, canRemove: false },
    client: { openAIBaseUrl: 'http://work.localhost:4141/v1', anthropicBaseUrl: 'http://work.localhost:4141' },
    ...overrides,
  }
}

export function targetsFixture(overrides: Partial<TargetsResult> = {}): TargetsResult {
  return { ...envelope(), hostTarget: 'work', routing: { baseHostname: 'localhost', defaultAccount: 'work', routingEnabled: true }, capabilities: { canAddAccount: true, canBootstrap: false, canManageM365: true, canRefreshMetadata: true }, targets: [targetFixture()], ...overrides }
}

export function overviewFixture(overrides: Partial<OverviewResult> = {}): OverviewResult {
  return { ...envelope(), status: 'ok', version: '1.2.3', uptimeMs: 600_000, hostTarget: 'work', capabilities: { canAddAccount: true, canBootstrap: false, canManageM365: true, canRefreshMetadata: true }, activity: { started: 4, completed: 3, failed: 1, aborted: 0, activeRequests: 1, recentRequests: 3, upstreamQueue: targetFixture().queue }, ...overrides }
}

export function requestFixture(overrides: Partial<DashboardRequest> = {}): DashboardRequest {
  return { requestId: 'request-1', accountName: 'work', method: 'POST', endpoint: '/v1/messages', state: 'completed', startedAt: '2026-11-04T00:09:00.000Z', durationMs: 850, status: 200, requestedModel: 'claude-sonnet', effectiveModel: 'claude-sonnet', modelTransforms: [], selectedStrategy: 'native', effects: [], ...overrides }
}

export function requestsFixture(overrides: Partial<RequestsResult> = {}): RequestsResult {
  return { ...envelope(), capacity: 256, active: [], recent: [requestFixture()], totals: { started: 1, completed: 1, failed: 0, aborted: 0 }, effectCounts: {}, ...overrides }
}

export function metricsFixture(overrides: Partial<MetricsResult> = {}): MetricsResult {
  const endMs = Date.parse(FIXTURE_GENERATED_AT)
  const window = overrides.window ?? '1h'
  const bucketMs = DASHBOARD_WINDOWS[window].bucketMs
  const counts = { completed: 6, failed: 1, aborted: 1 }
  const latency = { count: 6, sumMs: 3_000, p50: { valueMs: 500, kind: 'approximate' as const }, p95: { valueMs: 500, kind: 'approximate' as const } }
  return {
    ...envelope(),
    window,
    bucketMs,
    collectionStartedAt: FIXTURE_STARTED_AT,
    startMs: endMs - DASHBOARD_WINDOWS[window].durationMs,
    endMs,
    coveredMs: 600_000,
    counts,
    latency: { ...latency, histogram: [...LATENCY_BOUNDS_MS.map((_, index) => index === 10 ? 6 : 0), 0] },
    latencyBoundsMs: LATENCY_BOUNDS_MS,
    series: [{ startMs: endMs - bucketMs, endMs, coverage: 'full', counts, latency, effects: { rewrite: 2 } }],
    byModel: [{ kind: 'named', value: 'claude-sonnet', requests: 8, failures: 1 }],
    byTarget: [{ kind: 'named', value: 'work', requests: 8, failures: 1 }],
    byEndpoint: [{ kind: 'named', value: '/v1/messages', requests: 8, failures: 1 }],
    effects: { rewrite: 2 },
    ...overrides,
  }
}

export function quotaFixture(overrides: Partial<QuotaResult> = {}): QuotaResult {
  return { ...envelope(), target: 'work', runtimeId: 'target-work-1', quota: { status: 'ok', plan: 'business', fetchedAt: FIXTURE_GENERATED_AT, premiumInteractions: { entitlement: 300, remaining: 240, percentRemaining: 80, unlimited: false, overagePermitted: false } }, ...overrides }
}

export function modelFixture(overrides: Partial<DashboardModel> = {}): DashboardModel {
  return { id: 'claude-sonnet', name: 'Claude Sonnet', vendor: 'Anthropic', version: '4', preview: false, pickerEnabled: true, upstream: { endpoints: ['/v1/messages', '/responses', '/chat/completions'], capabilities: { family: 'claude', limits: { max_context_window_tokens: 200_000, max_output_tokens: 16_000 }, supports: { tool_calls: true, streaming: true, vision: true } } }, effective: { defaultMessagesStrategy: 'native-messages', nativeMessagesAvailable: true, responsesAvailable: true, nativeResponsesAvailable: true, defaultResponsesStrategy: 'responses-passthrough', outputConfig: true, nativeStructuredOutput: false, messagesStructuredOutput: true, toolCalls: true, vision: true, adaptiveThinking: false, reasoningEffort: [], responsesParameterFilters: [], contextManagement: true, chatTokenParameter: 'max_tokens' }, ...overrides }
}

export function modelsFixture(overrides: Partial<ModelsResult> = {}): ModelsResult {
  return { ...envelope(), hostTarget: 'work', apiBaseUrl: 'http://localhost:4141/v1', models: [modelFixture()], ...overrides }
}

export function behaviorFixture(overrides: Partial<BehaviorResult> = {}): BehaviorResult {
  return { ...envelope(), hostTarget: 'work', window: '1h', collectionStartedAt: FIXTURE_STARTED_AT, modelRouting: { rewrites: [], autoCorrect: { enabled: true }, compact: { enabled: false }, familyFallbacks: { claudeOpus: 'claude-opus', claudeSonnet: 'claude-sonnet', claudeHaiku: 'claude-haiku' }, overloadFallbacks: {} }, strategies: { messages: ['native', 'chat-completions'], responses: ['chat-completions'], chatCompletions: ['native'] }, parameterHandling: { responsesFiltersReplaceDefault: false, responsesFilters: [], responsesOutputTokenFloor: 0, chatMaxCompletionTokenModels: [] }, contextManagement: { enabled: true, models: [], autoCompactInput: false, defaultCompactThreshold: 0.8 }, toolCompatibility: { responsesChatCompletionsFallback: true, functionApplyPatch: true, remoteResponsesImageUrlsRejected: true, unresolvableResponsesItemsFiltered: true }, effects: [{ id: 'rewrite', category: 'routing', label: 'Model rewritten', count: 12, windowCount: 2 }], ...overrides }
}

export function m365Fixture(overrides: Partial<M365Result> = {}): M365Result {
  return { ...envelope(), platformSupported: true, registered: false, modelCount: 0, models: [], routing: [], onboarding: { status: 'available' }, ...overrides }
}

export function m365ReadinessFixture(overrides: Partial<M365ReadinessResult> = {}): M365ReadinessResult {
  return { ...envelope(), platformSupported: true, helperAvailable: true, accounts: [], accountCount: 0, ...overrides }
}

export function m365SignInFixture(overrides: Partial<M365SignInResult> = {}): M365SignInResult {
  return { ...envelope(), account: { upn: 'operator@example.com', homeAccountId: 'home-1', environment: 'login.microsoftonline.com' }, ...overrides }
}

export function authenticationFixture(overrides: Partial<DashboardAuthentication> = {}, identity: Partial<DashboardEnvelope> = {}): AuthenticationResult {
  return { ...envelope(identity), authentication: { id: 'auth-1', accountName: 'personal', hostname: 'personal.localhost', state: 'pending', authorization: { expiresAt: '2026-11-04T01:00:00.000Z', pollIntervalSeconds: 1, userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device' }, ...overrides } }
}

export function refreshFixture(overrides: Partial<RefreshResult> = {}): RefreshResult {
  return { ...envelope(), status: 'ok', accounts: [{ name: 'work', github: { status: 'ok' }, models: { status: 'ok' }, quota: { status: 'ok' } }], ...overrides }
}

export function routingFixture(overrides: Partial<RoutingResult> = {}): RoutingResult {
  return { ...envelope(), baseHostname: 'localhost', defaultAccount: 'work', routingEnabled: true, ...overrides }
}

export interface FakeRequest { method: string, url: URL, body: unknown, signal: AbortSignal | null }
export type FakeHandler = (request: FakeRequest) => Response | Promise<Response>
export interface FakeFetchFixture {
  fetch: Fetch
  requests: FakeRequest[]
  on: (method: string, path: string, handler: FakeHandler) => void
  count: (method: string, path: string) => number
}

export function createFakeFetch(): FakeFetchFixture {
  const requests: FakeRequest[] = []
  const handlers = new Map<string, FakeHandler>()
  const defaults: Record<string, () => object> = {
    'GET /dashboard/api/overview': overviewFixture,
    'GET /dashboard/api/targets': targetsFixture,
    'GET /dashboard/api/requests': requestsFixture,
    'GET /dashboard/api/models': modelsFixture,
    'GET /dashboard/api/m365': m365Fixture,
    'POST /dashboard/api/refresh': refreshFixture,
    'POST /dashboard/api/accounts': authenticationFixture,
    'POST /dashboard/api/accounts/bootstrap': routingFixture,
    'POST /dashboard/api/accounts/default': routingFixture,
    'POST /dashboard/api/m365/register': m365Fixture,
    'POST /dashboard/api/m365/account': m365Fixture,
    'POST /dashboard/api/m365/hostname': m365Fixture,
    'POST /dashboard/api/m365/remove': m365Fixture,
    'POST /dashboard/api/m365/probe': m365ReadinessFixture,
    'POST /dashboard/api/m365/sign-in': m365SignInFixture,
  }
  return {
    requests,
    on: (method, path, handler) => { handlers.set(`${method.toUpperCase()} ${path}`, handler) },
    count: (method, path) => requests.filter(request => request.method === method && request.url.pathname === path).length,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      const request: FakeRequest = { method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined, signal: init?.signal ?? null }
      requests.push(request)
      const key = `${method} ${url.pathname}`
      const handler = handlers.get(key)
      if (handler)
        return handler(request)
      if (method === 'GET' && (url.pathname === '/dashboard/api/metrics' || url.pathname === '/dashboard/api/behavior')) {
        const window = url.searchParams.get('window') ?? '1h'
        if (!Object.hasOwn(DASHBOARD_WINDOWS, window))
          return Response.json({ error: { message: 'Unknown metric window.', type: 'invalid_request_error' } }, { status: 400 })
        return Response.json(url.pathname.endsWith('/metrics') ? metricsFixture({ window: window as DashboardWindowId }) : behaviorFixture({ window: window as DashboardWindowId }))
      }
      const fixture = defaults[key]
      if (fixture)
        return Response.json(fixture())
      if (method === 'GET' && url.pathname.endsWith('/quota'))
        return Response.json(quotaFixture())
      if (method === 'GET' && url.pathname.startsWith('/dashboard/api/account-auth/'))
        return Response.json(authenticationFixture())
      if (method === 'DELETE' && url.pathname.startsWith('/dashboard/api/accounts/'))
        return Response.json(routingFixture())
      return Response.json({ error: { message: 'Fixture route not found.', type: 'invalid_request_error' } }, { status: 404 })
    },
  }
}

export interface Deferred<T> { promise: Promise<T>, resolve: (value: T) => void, reject: (error: Error) => void }
export function deferred<T>(): Deferred<T> {
  return Promise.withResolvers<T>()
}
