import type { DashboardPage, DashboardRequestState, DashboardWindowId } from '@contract'
import { DASHBOARD_PAGES, DASHBOARD_WINDOWS } from '@contract'

export interface DashboardUrlState {
  page: DashboardPage | null
  window: DashboardWindowId
  target?: string
  request?: string
  state?: string
  endpoint?: string
  model?: string
}

export const DEFAULT_WINDOW: DashboardWindowId = '1h'
export const PAGE_LABELS: Record<DashboardPage, string> = {
  overview: 'Overview',
  traffic: 'Traffic',
  requests: 'Requests',
  targets: 'Targets',
  models: 'Models',
  behavior: 'Behavior',
}

export function parseUrl(input: string | URL): DashboardUrlState {
  const url = input instanceof URL ? input : new URL(input, 'http://localhost')
  const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname
  const segment = path === '/dashboard' ? 'overview' : path.slice('/dashboard/'.length)
  const page = DASHBOARD_PAGES.find(page => path === `/dashboard/${page}` && page === segment)
    ?? (path === '/dashboard' ? 'overview' : null)
  const window = url.searchParams.get('window')
  const value = (key: string) => url.searchParams.get(key) ?? undefined
  return {
    page,
    window: window !== null && Object.hasOwn(DASHBOARD_WINDOWS, window) ? window as DashboardWindowId : DEFAULT_WINDOW,
    target: value('target'),
    request: value('request'),
    state: value('state'),
    endpoint: value('endpoint'),
    model: value('model'),
  }
}

export function buildUrl(state: DashboardUrlState): string {
  const query = new URLSearchParams()
  if (state.target !== undefined)
    query.set('target', state.target)
  if (state.window !== DEFAULT_WINDOW)
    query.set('window', state.window)
  for (const key of ['request', 'state', 'endpoint', 'model'] as const) {
    if (state[key] !== undefined)
      query.set(key, state[key])
  }
  const suffix = query.toString()
  return `/dashboard/${state.page ?? 'not-found'}${suffix ? `?${suffix}` : ''}`
}

export function pageUrl(state: DashboardUrlState, page: DashboardPage): string {
  return buildUrl({ page, window: state.window, target: state.target })
}

export function redirectUrl(location: Pick<Location, 'protocol' | 'port'>, hostname: string, state: DashboardUrlState): string {
  const url = new URL(buildUrl({ page: state.page, window: state.window }), `${location.protocol}//${hostname}`)
  url.port = location.port
  return url.href
}

export function isMonitorPage(page: DashboardPage | null): boolean {
  return page === 'overview' || page === 'traffic' || page === 'requests'
}

export const REQUEST_STATES: readonly DashboardRequestState[] = ['in_flight', 'streaming', 'completed', 'failed', 'aborted']
