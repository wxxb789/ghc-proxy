import { QueryClient } from '@tanstack/react-query'

export function createDashboardQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 300_000 }, mutations: { retry: false } } })
}
