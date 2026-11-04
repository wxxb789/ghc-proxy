import type { DashboardAuthentication } from '@contract'
import type { QueryClient } from '@tanstack/react-query'
import type { Dispatch, SetStateAction } from 'react'
import type { DashboardApi } from '../lib/api'
import type { DashboardUrlState } from '../lib/url-state'
import { createContext, use } from 'react'

export interface DashboardRuntime {
  api: DashboardApi
  client: QueryClient
  live: boolean
  setLive: Dispatch<SetStateAction<boolean>>
  stopped: boolean
  schemaMismatch: boolean
  notice: string
  announce: (message: string) => void
  authentication: DashboardAuthentication | null
  trackAuthentication: (authentication: DashboardAuthentication) => void
  stop: () => Promise<void>
}

export interface DashboardNavigation {
  url: DashboardUrlState
  navigate: (patch: Partial<DashboardUrlState>, mode?: 'push' | 'replace') => void
  goToHostname: (hostname: string) => Promise<void>
}

export const RuntimeContext = createContext<DashboardRuntime | null>(null)
export const NavigationContext = createContext<DashboardNavigation | null>(null)

export function useDashboard(): DashboardRuntime {
  const runtime = use(RuntimeContext)
  if (!runtime)
    throw new Error('Dashboard components must be mounted inside DashboardRoot.')
  return runtime
}

export function useDashboardUrl(): DashboardNavigation {
  const navigation = use(NavigationContext)
  if (!navigation)
    throw new Error('Dashboard navigation must be mounted inside DashboardRoot.')
  return navigation
}
