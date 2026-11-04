import type { QueryClient } from '@tanstack/react-query'
import type { RenderResult } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { FakeFetchFixture } from './fixtures'
import { render } from '@testing-library/react'
import { afterEach } from 'vitest'
import { DashboardRoot } from '../app/root'
import { Shell } from '../app/shell'
import { createDashboardQueryClient } from '../lib/query-client'
import { createFakeFetch } from './fixtures'

const clients = new Set<QueryClient>()
afterEach(() => {
  for (const client of clients)
    client.clear()
  clients.clear()
})

export interface DashboardRenderOptions { children: ReactNode, api?: FakeFetchFixture, url?: string, shell?: boolean }
export interface DashboardRenderResult extends RenderResult { api: FakeFetchFixture, client: QueryClient }

export function renderDashboard({ children, api = createFakeFetch(), url = '/dashboard/overview', shell = true }: DashboardRenderOptions): DashboardRenderResult {
  window.history.replaceState(null, '', url)
  const client = createDashboardQueryClient()
  clients.add(client)
  const result = render(<DashboardRoot fetch={api.fetch} queryClient={client}>{shell ? <Shell>{children}</Shell> : children}</DashboardRoot>)
  return { ...result, api, client }
}
