import type { DashboardAuthentication, DashboardTarget, DashboardWindowId } from '@contract'
import type { QueryKey, UseQueryResult } from '@tanstack/react-query'
import type {
  AuthenticationResult,
  BehaviorResult,
  M365Result,
  MetricsResult,
  ModelsResult,
  OverviewResult,
  QuotaResult,
  RequestsResult,
  TargetsResult,
} from './api'
import type { DashboardQueryMeta, ReadDomain, RegionResult } from './poll'
import { useIsMutating, useQuery } from '@tanstack/react-query'
import { useDashboard } from '../app/context'
import { ApiError } from './api'
import { automaticReadsBlocked, deriveRegion, METRIC_INTERVALS, pollingInterval, queryMeta } from './poll'

export const dashboardKeys = {
  all: ['dashboard'] as const,
  overview: ['dashboard', 'overview'] as const,
  targets: ['dashboard', 'targets'] as const,
  requests: ['dashboard', 'requests'] as const,
  metrics: (window: DashboardWindowId, target?: string) => ['dashboard', 'metrics', window, target ?? null] as const,
  quota: (target: Pick<DashboardTarget, 'name' | 'runtimeId'>) => ['dashboard', 'quota', target.name, target.runtimeId] as const,
  models: ['dashboard', 'models'] as const,
  behavior: (window: DashboardWindowId) => ['dashboard', 'behavior', window] as const,
  m365: ['dashboard', 'm365'] as const,
  authentication: (id: string) => ['dashboard', 'authentication', id] as const,
}

export interface DashboardRead<T> extends UseQueryResultBase<T> {
  region: RegionResult<T>
}
type UseQueryResultBase<T> = Pick<UseQueryResult<T, Error>, 'data' | 'error' | 'isPending' | 'isFetching' | 'isError' | 'isSuccess' | 'refetch' | 'dataUpdatedAt'>

interface ReadOptions<T> {
  domain: ReadDomain
  key: QueryKey
  read: (signal: AbortSignal) => Promise<T>
  interval?: number
  empty?: (data: T) => boolean
  unavailable?: (data: T) => boolean
  enabled?: boolean
}

function useDashboardRead<T>({ domain, key, read, interval, empty, unavailable, enabled = true }: ReadOptions<T>): DashboardRead<T> {
  const runtime = useDashboard()
  const refreshPending = useIsMutating({ mutationKey: ['dashboard', 'refresh'] }) > 0
  const mutationPending = useIsMutating({ mutationKey: ['dashboard', 'mutation'], predicate: (mutation) => {
    const domains = mutation.meta?.domains
    return Array.isArray(domains) && domains.includes(domain)
  } }) > 0
  const existing = runtime.client.getQueryCache().find({ queryKey: key })
  const blocked = automaticReadsBlocked(existing?.state.error)
  const suspended = refreshPending || mutationPending
  const automatic = runtime.live && !suspended && !runtime.stopped && !runtime.schemaMismatch && !blocked
  const query = useQuery<T, Error>({
    queryKey: key,
    queryFn: ({ signal }) => read(signal),
    meta: { dashboard: true, domain, failures: queryMeta(existing)?.failures ?? 0 } satisfies DashboardQueryMeta,
    enabled: enabled && !runtime.stopped && !runtime.schemaMismatch && !blocked && !mutationPending,
    retry: false,
    staleTime: interval ?? Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: automatic,
    refetchOnReconnect: automatic,
    refetchInterval: query => automatic && interval !== undefined
      ? pollingInterval(interval, queryMeta(query)?.failures ?? 0, query.state.error)
      : false,
    refetchIntervalInBackground: false,
  })
  const failures = queryMeta(runtime.client.getQueryCache().find({ queryKey: key }))?.failures ?? 0
  return {
    ...query,
    region: deriveRegion(query, failures, query.data !== undefined && Boolean(empty?.(query.data)), query.data !== undefined && Boolean(unavailable?.(query.data))),
  }
}

export function useOverview(): DashboardRead<OverviewResult> {
  const { api } = useDashboard()
  return useDashboardRead({ domain: 'overview', key: dashboardKeys.overview, read: signal => api.overview(signal), interval: 3_000 })
}

export function useTargets(enabled = true): DashboardRead<TargetsResult> {
  const { api } = useDashboard()
  return useDashboardRead({ domain: 'targets', key: dashboardKeys.targets, read: signal => api.targets(signal), interval: 3_000, enabled, empty: data => data.targets.length === 0 })
}

export function useRequests(): DashboardRead<RequestsResult> {
  const { api } = useDashboard()
  return useDashboardRead({ domain: 'requests', key: dashboardKeys.requests, read: signal => api.requests(signal), interval: 3_000, empty: data => data.active.length + data.recent.length === 0 })
}

export function useMetrics(window: DashboardWindowId, target?: string): DashboardRead<MetricsResult> {
  const { api } = useDashboard()
  return useDashboardRead({ domain: 'metrics', key: dashboardKeys.metrics(window, target), read: signal => api.metrics(window, target, signal), interval: METRIC_INTERVALS[window], empty: data => data.coveredMs === 0 })
}

export function useTargetQuota(target: DashboardTarget): DashboardRead<QuotaResult> {
  const { api } = useDashboard()
  const result = useDashboardRead({ domain: 'quota', key: dashboardKeys.quota(target), read: signal => api.quota(target.name, signal), interval: 30_000, unavailable: data => data.quota.status === 'unavailable' || data.quota.status === 'not_applicable' })
  if (result.data !== undefined && result.data.runtimeId !== target.runtimeId)
    return { ...result, data: undefined, region: { state: 'unavailable', data: undefined, error: null, explanation: 'Quota belongs to a previous instance of this target.' } }
  if (result.data?.quota.status === 'stale' && !result.error)
    return { ...result, region: { ...result.region, state: 'stale' } }
  return result
}

export function useModels(): DashboardRead<ModelsResult> {
  const { api } = useDashboard()
  return useDashboardRead({ domain: 'models', key: dashboardKeys.models, read: signal => api.models(signal), empty: data => data.models.length === 0 })
}

export function useBehavior(window: DashboardWindowId): DashboardRead<BehaviorResult> {
  const { api } = useDashboard()
  return useDashboardRead({ domain: 'behavior', key: dashboardKeys.behavior(window), read: signal => api.behavior(window, signal), interval: METRIC_INTERVALS[window] })
}

export function useM365(): DashboardRead<M365Result> {
  const { api } = useDashboard()
  return useDashboardRead({ domain: 'm365', key: dashboardKeys.m365, read: signal => api.m365(signal) })
}

export function useAuthenticationTask(authentication: DashboardAuthentication | null): UseQueryResult<AuthenticationResult, Error> {
  const runtime = useDashboard()
  const key = dashboardKeys.authentication(authentication?.id ?? '')
  const existing = runtime.client.getQueryCache().find({ queryKey: key })
  const terminalError = existing?.state.error instanceof ApiError && [403, 404, 421].includes(existing.state.error.status)
  return useQuery<AuthenticationResult, Error>({
    queryKey: key,
    queryFn: ({ signal }) => runtime.api.authentication(authentication!.id, signal),
    meta: { dashboard: true, domain: 'authentication', failures: queryMeta(existing)?.failures ?? 0 } satisfies DashboardQueryMeta,
    enabled: authentication?.state === 'pending' && !runtime.stopped && !runtime.schemaMismatch && !terminalError,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) => {
      const error = query.state.error
      if (query.state.data?.authentication.state !== 'pending' && query.state.data !== undefined)
        return false
      if (error instanceof ApiError && [403, 404, 421].includes(error.status))
        return false
      return pollingInterval(1_000, queryMeta(query)?.failures ?? 0, error)
    },
    refetchIntervalInBackground: true,
  })
}
