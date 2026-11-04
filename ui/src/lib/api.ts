import type {
  DashboardAddAccount,
  DashboardAuthenticationResult,
  DashboardBehavior,
  DashboardM365,
  DashboardM365Input,
  DashboardM365Readiness,
  DashboardM365SignIn,
  DashboardMetadataRefresh,
  DashboardMetrics,
  DashboardModels,
  DashboardOverview,
  DashboardRequests,
  DashboardResponse,
  DashboardRouting,
  DashboardTargetQuota,
  DashboardTargets,
  DashboardWindowId,
} from '@contract'
import { DASHBOARD_SCHEMA_VERSION } from '@contract'

export type OverviewResult = DashboardResponse<DashboardOverview>
export type TargetsResult = DashboardResponse<DashboardTargets>
export type RequestsResult = DashboardResponse<DashboardRequests>
export type MetricsResult = DashboardResponse<DashboardMetrics>
export type QuotaResult = DashboardResponse<DashboardTargetQuota>
export type ModelsResult = DashboardResponse<DashboardModels>
export type BehaviorResult = DashboardResponse<DashboardBehavior>
export type M365Result = DashboardResponse<DashboardM365>
export type AuthenticationResult = DashboardResponse<DashboardAuthenticationResult>
export type RefreshResult = DashboardResponse<DashboardMetadataRefresh>
export type RoutingResult = DashboardResponse<DashboardRouting>
export type M365ReadinessResult = DashboardResponse<DashboardM365Readiness>
export type M365SignInResult = DashboardResponse<DashboardM365SignIn>
export type AddAccountBody = DashboardAddAccount
export interface BootstrapBody { hostname: string }
export interface DefaultAccountBody { accountName: string }
export interface M365SignInBody { upn?: string }
export type M365RegisterBody = DashboardM365Input
export interface M365AccountBody { account?: string | null }
export interface M365HostnameBody { hostname: string }
export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class ApiError extends Error {
  readonly status: number
  readonly type: string
  constructor(message: string, status: number, type = 'request_error') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.type = type
  }
}

export class SchemaMismatchError extends ApiError {
  constructor() {
    super('This Dashboard and proxy use different API versions. Reload to continue.', 0, 'schema_mismatch')
    this.name = 'SchemaMismatchError'
  }
}

export interface DashboardApi {
  overview: (signal?: AbortSignal) => Promise<OverviewResult>
  targets: (signal?: AbortSignal) => Promise<TargetsResult>
  requests: (signal?: AbortSignal) => Promise<RequestsResult>
  metrics: (window: DashboardWindowId, target?: string, signal?: AbortSignal) => Promise<MetricsResult>
  quota: (name: string, signal?: AbortSignal) => Promise<QuotaResult>
  models: (signal?: AbortSignal) => Promise<ModelsResult>
  behavior: (window: DashboardWindowId, signal?: AbortSignal) => Promise<BehaviorResult>
  m365: (signal?: AbortSignal) => Promise<M365Result>
  authentication: (id: string, signal?: AbortSignal) => Promise<AuthenticationResult>
  refresh: () => Promise<RefreshResult>
  addAccount: (body: AddAccountBody) => Promise<AuthenticationResult>
  bootstrap: (body: BootstrapBody) => Promise<RoutingResult>
  setDefault: (body: DefaultAccountBody) => Promise<RoutingResult>
  removeAccount: (name: string) => Promise<RoutingResult>
  probeM365: () => Promise<M365ReadinessResult>
  signInM365: (body: M365SignInBody) => Promise<M365SignInResult>
  registerM365: (body: M365RegisterBody) => Promise<M365Result>
  selectM365Account: (body: M365AccountBody) => Promise<M365Result>
  setM365Hostname: (body: M365HostnameBody) => Promise<M365Result>
  removeM365: () => Promise<M365Result>
}

export function createDashboardApi(fetch: Fetch): DashboardApi {
  async function request<T>(path: string, method = 'GET', body?: object, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`/dashboard/api/${path}`, {
      method,
      signal,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const data: unknown = await response.json()
    if (!response.ok) {
      const error = typeof data === 'object' && data !== null && 'error' in data ? data.error : undefined
      const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
        ? error.message
        : `Request failed (${response.status}).`
      const type = typeof error === 'object' && error !== null && 'type' in error && typeof error.type === 'string'
        ? error.type
        : 'request_error'
      throw new ApiError(message, response.status, type)
    }
    if (typeof data !== 'object' || data === null || !('schemaVersion' in data) || data.schemaVersion !== DASHBOARD_SCHEMA_VERSION)
      throw new SchemaMismatchError()
    return data as T
  }
  return {
    overview: signal => request('overview', 'GET', undefined, signal),
    targets: signal => request('targets', 'GET', undefined, signal),
    requests: signal => request('requests', 'GET', undefined, signal),
    metrics: (window, target, signal) => {
      const query = new URLSearchParams({ window })
      if (target !== undefined)
        query.set('target', target)
      return request(`metrics?${query}`, 'GET', undefined, signal)
    },
    quota: (name, signal) => request(`targets/${encodeURIComponent(name)}/quota`, 'GET', undefined, signal),
    models: signal => request('models', 'GET', undefined, signal),
    behavior: (window, signal) => request(`behavior?${new URLSearchParams({ window })}`, 'GET', undefined, signal),
    m365: signal => request('m365', 'GET', undefined, signal),
    authentication: (id, signal) => request(`account-auth/${encodeURIComponent(id)}`, 'GET', undefined, signal),
    refresh: () => request('refresh', 'POST'),
    addAccount: body => request('accounts', 'POST', body),
    bootstrap: body => request('accounts/bootstrap', 'POST', body),
    setDefault: body => request('accounts/default', 'POST', body),
    removeAccount: name => request(`accounts/${encodeURIComponent(name)}`, 'DELETE'),
    probeM365: () => request('m365/probe', 'POST'),
    signInM365: body => request('m365/sign-in', 'POST', body),
    registerM365: body => request('m365/register', 'POST', body),
    selectM365Account: body => request('m365/account', 'POST', body),
    setM365Hostname: body => request('m365/hostname', 'POST', body),
    removeM365: () => request('m365/remove', 'POST'),
  }
}
