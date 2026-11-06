import type {
  AccountAuthenticationResponse,
  AccountsResponse,
  AddAccountBody,
  BehaviorResponse,
  BootstrapRoutingBody,
  M365EndpointBody,
  M365ProbeResponse,
  M365Response,
  M365SignInBody,
  M365SignInResponse,
  M365TargetBody,
  MetadataRefreshResponse,
  ModelsResponse,
  OverviewResponse,
  RequestsResponse,
  RoutingSummaryResponse,
  SetDefaultAccountBody,
} from '@contract'

/** An HTTP failure carrying the server's error message and status. */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type Fetch = typeof fetch

async function request<T>(fetchImpl: Fetch, path: string, method = 'GET', body?: object): Promise<T> {
  // Body-less mutations must not send a JSON content type: the server rejects an empty JSON body.
  const init: RequestInit = { method, cache: 'no-store', credentials: 'same-origin' }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const response = await fetchImpl(path, init)
  let data: unknown = {}
  try {
    data = await response.json()
  }
  catch {
    data = {}
  }
  if (!response.ok) {
    const message = (data as { error?: { message?: unknown } } | null)?.error?.message
    throw new ApiError(typeof message === 'string' && message ? message : `Dashboard request failed: ${response.status}`, response.status)
  }
  return data as T
}

/** Typed client for the Dashboard JSON API. `fetch` is injected so tests can observe every request. */
export function createApi(fetchImpl: Fetch = (input, init) => fetch(input, init)) {
  const get = <T>(path: string) => request<T>(fetchImpl, path)
  const post = <T>(path: string, body?: object) => request<T>(fetchImpl, path, 'POST', body)
  return {
    overview: () => get<OverviewResponse>('/dashboard/api/overview'),
    models: (target?: string) => get<ModelsResponse>(`/dashboard/api/models${target ? `?target=${encodeURIComponent(target)}` : ''}`),
    behavior: () => get<BehaviorResponse>('/dashboard/api/behavior'),
    requests: () => get<RequestsResponse>('/dashboard/api/requests'),
    accounts: () => get<AccountsResponse>('/dashboard/api/accounts'),
    m365: () => get<M365Response>('/dashboard/api/m365'),
    accountAuth: (id: string) => get<AccountAuthenticationResponse>(`/dashboard/api/account-auth/${encodeURIComponent(id)}`),
    addAccount: (body: AddAccountBody) => post<AccountAuthenticationResponse>('/dashboard/api/accounts', body),
    bootstrap: (body: BootstrapRoutingBody) => post<RoutingSummaryResponse>('/dashboard/api/accounts/bootstrap', body),
    setDefault: (body: SetDefaultAccountBody) => post<RoutingSummaryResponse>('/dashboard/api/accounts/default', body),
    removeAccount: (name: string) => request<RoutingSummaryResponse>(fetchImpl, `/dashboard/api/accounts/${encodeURIComponent(name)}`, 'DELETE'),
    refreshMetadata: () => post<MetadataRefreshResponse>('/dashboard/api/refresh'),
    m365Probe: () => post<M365ProbeResponse>('/dashboard/api/m365/probe'),
    m365SignIn: (body: M365SignInBody) => post<M365SignInResponse>('/dashboard/api/m365/sign-in', body),
    m365Register: (body: M365TargetBody) => post<M365Response>('/dashboard/api/m365/register', body),
    m365Account: (body: M365TargetBody) => post<M365Response>('/dashboard/api/m365/account', body),
    m365Hostname: (body: { hostname: string }) => post<M365Response>('/dashboard/api/m365/hostname', body),
    m365Endpoint: (body: M365EndpointBody) => post<M365Response>('/dashboard/api/m365/endpoint', body),
  }
}

export type DashboardApi = ReturnType<typeof createApi>

/** The app-wide client. It resolves the global `fetch` per call, so tests can stub it. */
export const api = createApi()
