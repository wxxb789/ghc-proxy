import type { ObservedRequest } from '@contract'

export type StateFilter = 'all' | 'active' | 'completed' | 'failed' | 'aborted' | 'errors'

export const STATE_LABEL: Record<StateFilter, string> = {
  all: 'All',
  active: 'Active',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Aborted',
  errors: 'Errors',
}

/** Whether a row belongs to a state filter; `isActive` = the row came from the `active` array. */
export function inState(filter: StateFilter, row: ObservedRequest, isActive: boolean): boolean {
  if (filter === 'all')
    return true
  if (filter === 'active')
    return isActive
  if (filter === 'errors')
    return row.state === 'failed' || (row.status ?? 0) >= 400
  return row.state === filter
}

/** Case-insensitive substring search over the listed request fields (spec §5.2). */
export function matchesQuery(row: ObservedRequest, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle)
    return true
  return [row.endpoint, row.method, row.effectiveModel, row.requestedModel, row.selectedStrategy, row.accountName, row.requestId, row.errorSummary, row.status?.toString()]
    .some(field => field?.toLowerCase().includes(needle))
}

/** Rows still running: their duration advances on the shared clock. */
export const isTicking = (row: ObservedRequest) => row.state === 'in_flight' || row.state === 'streaming'

/** Shown duration: running rows add the time since the snapshot was fetched. */
export function elapsed(row: ObservedRequest, now: number, fetchedAt: number): number {
  return isTicking(row) ? row.durationMs + Math.max(0, now - fetchedAt) : row.durationMs
}
