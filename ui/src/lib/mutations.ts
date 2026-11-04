import type { Query, UseMutationResult } from '@tanstack/react-query'
import type { DashboardApi, RefreshResult } from './api'
import type { ReadDomain } from './poll'
import { useMutation } from '@tanstack/react-query'
import { useDashboard } from '../app/context'
import { queryMeta } from './poll'

export function useMetadataRefresh(): UseMutationResult<RefreshResult, Error, void> {
  const { api, client, announce } = useDashboard()
  return useMutation<RefreshResult, Error, void>({
    mutationKey: ['dashboard', 'refresh'],
    retry: false,
    mutationFn: async () => {
      const loading = client.getQueryCache().findAll({ type: 'active', predicate: query => Boolean(queryMeta(query)) && queryMeta(query)?.domain !== 'authentication' }).flatMap(query => query.state.fetchStatus === 'fetching' && query.promise ? [query.promise] : [])
      await Promise.allSettled(loading)
      return api.refresh()
    },
    onMutate: () => { announce('Refreshing metadata.') },
    onSuccess: async (data) => {
      const active = client.getQueryCache().findAll({ type: 'active', predicate: query => Boolean(queryMeta(query)) && queryMeta(query)?.domain !== 'authentication' })
      await Promise.allSettled(active.map(query => query.fetch(undefined, { cancelRefetch: false })))
      const failures = data.accounts.flatMap(account => (['github', 'models', 'quota'] as const)
        .filter(source => account[source].status === 'stale' || account[source].status === 'unavailable')
        .map(source => `${account.name}: ${source} (${account[source].status})`))
      announce(data.status === 'ok' ? 'Metadata refreshed.' : `Metadata refresh was ${data.status}.${failures.length ? ` ${failures.join('; ')}` : ''}`)
    },
    onError: (error) => { announce(error.message) },
  })
}

export interface DashboardMutationOptions<TData, TVariables> {
  domains: readonly [ReadDomain, ...ReadDomain[]]
  mutation: (api: DashboardApi, variables: TVariables) => Promise<TData>
  successMessage?: string
  onSuccess?: (data: TData, variables: TVariables) => void | Promise<void>
}

export function useDashboardMutation<TData, TVariables = void>({ domains, mutation, successMessage = 'Changes saved.', onSuccess }: DashboardMutationOptions<TData, TVariables>): UseMutationResult<TData, Error, TVariables> {
  const { api, client, announce } = useDashboard()
  const matches = (query: Query) => {
    const meta = queryMeta(query)
    return meta !== undefined && domains.includes(meta.domain)
  }
  return useMutation<TData, Error, TVariables>({
    mutationKey: ['dashboard', 'mutation', domains[0]],
    meta: { domains },
    retry: false,
    onMutate: async () => {
      await client.cancelQueries({ predicate: matches })
      announce('Saving changes.')
    },
    mutationFn: variables => mutation(api, variables),
    onSuccess: async (data, variables) => {
      await onSuccess?.(data, variables)
      announce(successMessage)
    },
    onError: (error) => { announce(error.message) },
    onSettled: async () => {
      await client.invalidateQueries({ predicate: matches, refetchType: 'active' })
    },
  })
}
