import type { DashboardWindowId } from '@contract'
import type { Query, UseQueryResult } from '@tanstack/react-query'
import { ApiError, SchemaMismatchError } from './api'

export type ReadDomain = 'overview' | 'targets' | 'requests' | 'metrics' | 'quota' | 'models' | 'behavior' | 'm365' | 'authentication'
export interface DashboardQueryMeta extends Record<string, unknown> {
  dashboard: true
  domain: ReadDomain
  failures: number
}
export type RegionState = 'loading' | 'ready' | 'refreshing' | 'empty' | 'stale' | 'unavailable' | 'error'
export interface RegionResult<T> {
  state: RegionState
  data: T | undefined
  error: Error | null
  explanation?: string
}

export function automaticReadsBlocked(error: unknown): boolean {
  return error instanceof SchemaMismatchError || (error instanceof ApiError && (error.status === 403 || error.status === 421))
}

export function pollingInterval(base: number, failures: number, error: unknown): number | false {
  if (automaticReadsBlocked(error))
    return false
  const transient = error !== null && (!(error instanceof ApiError) || error.status >= 500)
  return transient ? Math.max(base, Math.min(30_000, base * 2 ** Math.min(failures, 10))) : base
}

export const METRIC_INTERVALS: Record<DashboardWindowId, number> = { '15m': 10_000, '1h': 30_000, '24h': 60_000 }

export function queryMeta(query: Pick<Query, 'meta'> | undefined): DashboardQueryMeta | undefined {
  return query?.meta?.dashboard === true ? query.meta as DashboardQueryMeta : undefined
}

export function deriveRegion<T>(query: Pick<UseQueryResult<T, Error>, 'data' | 'error' | 'isPending' | 'isFetching'>, failures: number, empty = false, unavailable = false): RegionResult<T> {
  const { data, error, isPending, isFetching } = query
  const explanation = automaticReadsBlocked(error)
    ? error instanceof SchemaMismatchError ? error.message : 'Automatic updates stopped. Open this Dashboard on its local target hostname and reload.'
    : undefined
  const state: RegionState = error
    ? data !== undefined && failures >= 2 ? 'stale' : 'error'
    : unavailable
      ? 'unavailable'
      : isPending
        ? 'loading'
        : empty
          ? 'empty'
          : isFetching ? 'refreshing' : 'ready'
  return { state, data, error, explanation }
}
