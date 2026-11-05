import type { DashboardAuthentication, DashboardEnvelope } from '@contract'
import type { QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { Fetch } from '../lib/api'
import type { DashboardUrlState } from '../lib/url-state'
import { QueryClientProvider } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearch } from 'wouter'
import { ApiError, createDashboardApi, SchemaMismatchError } from '../lib/api'
import { navigateToHostname } from '../lib/navigation'
import { queryMeta } from '../lib/poll'
import { useAuthenticationTask } from '../lib/queries'
import { createDashboardQueryClient } from '../lib/query-client'
import { buildUrl, parseUrl } from '../lib/url-state'
import { NavigationContext, RuntimeContext, useDashboard } from './context'

export interface DashboardRootProps {
  fetch: Fetch
  children: ReactNode
  queryClient?: QueryClient
}

function AuthenticationObserver() {
  const { authentication } = useDashboard()
  useAuthenticationTask(authentication)
  return null
}

export function DashboardRoot({ fetch, children, queryClient }: DashboardRootProps) {
  const [client] = useState(() => queryClient ?? createDashboardQueryClient())
  const api = useMemo(() => createDashboardApi(fetch), [fetch])
  const [live, setLive] = useState(true)
  const [stopped, setStopped] = useState(false)
  const [schemaMismatch, setSchemaMismatch] = useState(false)
  const [notice, setNotice] = useState('')
  const [authentication, setAuthentication] = useState<DashboardAuthentication | null>(null)
  const [path, setLocation] = useLocation()
  const search = useSearch()
  const url = useMemo(() => parseUrl(`${path}${search ? `?${search}` : ''}`), [path, search])
  const identityRef = useRef<{ startedAt: string, collectionStartedAt?: string } | null>(null)
  const stoppingRef = useRef(false)

  const navigate = useCallback((patch: Partial<DashboardUrlState>, mode: 'push' | 'replace' = 'replace') => {
    setLocation(buildUrl({ ...url, ...patch }), { replace: mode === 'replace' })
  }, [setLocation, url])

  const stop = useCallback(async () => {
    stoppingRef.current = true
    setStopped(true)
    setLive(false)
    await client.cancelQueries({ predicate: query => Boolean(queryMeta(query)) })
  }, [client])

  const goToHostname = useCallback(async (hostname: string) => {
    await navigateToHostname({
      assign: url => window.location.assign(url),
      hostname,
      location: window.location,
      state: url,
      stop,
    })
  }, [stop, url])

  useEffect(() => {
    if (url.page && buildUrl(url) !== `${path}${search ? `?${search}` : ''}`)
      setLocation(buildUrl(url), { replace: true })
  }, [url, path, search, setLocation])

  useEffect(() => client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || stoppingRef.current)
      return
    const meta = queryMeta(event.query)
    if (!meta)
      return
    if (event.action.type === 'error') {
      meta.failures += 1
      if (event.action.error instanceof SchemaMismatchError) {
        setSchemaMismatch(true)
        void client.cancelQueries({ predicate: query => Boolean(queryMeta(query)) })
      }
      if (meta.domain === 'authentication' && event.action.error instanceof ApiError && [403, 404, 421].includes(event.action.error.status)) {
        const error = event.action.error
        setNotice(error.message)
        setAuthentication(current => current?.state === 'pending' ? { ...current, state: 'failed', message: error.message } : current)
      }
      return
    }
    if (event.action.type !== 'success' || event.action.manual)
      return
    meta.failures = 0
    const data = event.query.state.data as (DashboardEnvelope & { collectionStartedAt?: string, authentication?: DashboardAuthentication }) | undefined
    if (!data || !data.startedAt)
      return
    if (meta.domain === 'authentication' && data.authentication) {
      const task = data.authentication
      setAuthentication(task)
      if (task.state !== 'pending') {
        setNotice(task.message ?? (task.state === 'succeeded' ? 'Account connected.' : 'Account authentication failed.'))
        if (task.state === 'succeeded')
          void client.invalidateQueries({ predicate: query => ['targets', 'overview', 'models'].includes(queryMeta(query)?.domain ?? '') })
      }
    }
    const previous = identityRef.current
    const changed = previous !== null && (previous.startedAt !== data.startedAt
      || (previous.collectionStartedAt !== undefined && data.collectionStartedAt !== undefined && previous.collectionStartedAt !== data.collectionStartedAt))
    identityRef.current = {
      startedAt: data.startedAt,
      collectionStartedAt: data.collectionStartedAt ?? (previous?.startedAt === data.startedAt ? previous.collectionStartedAt : undefined),
    }
    if (changed) {
      navigate({ request: undefined })
      setNotice('The proxy session changed. Request selection and cached charts were cleared.')
      const otherReads = { predicate: (query: typeof event.query) => query !== event.query && Boolean(queryMeta(query)) }
      void client.cancelQueries(otherReads).then(() => {
        client.removeQueries({ type: 'inactive', predicate: query => query !== event.query && queryMeta(query)?.domain === 'metrics' })
        void client.resetQueries({ type: 'active', predicate: query => query !== event.query && queryMeta(query)?.domain === 'metrics' })
        void client.invalidateQueries({ predicate: query => otherReads.predicate(query) && queryMeta(query)?.domain !== 'metrics', refetchType: 'active' })
      })
    }
  }), [client, navigate])

  useEffect(() => client.getMutationCache().subscribe((event) => {
    if (event.type === 'updated' && event.mutation.state.error instanceof SchemaMismatchError) {
      setSchemaMismatch(true)
      void client.cancelQueries({ predicate: query => Boolean(queryMeta(query)) })
    }
  }), [client])

  const runtime = useMemo(() => ({ api, client, live, setLive, stopped, schemaMismatch, notice, announce: setNotice, authentication, trackAuthentication: setAuthentication, stop }), [api, client, live, stopped, schemaMismatch, notice, authentication, stop])
  const navigation = useMemo(() => ({ url, navigate, goToHostname }), [url, navigate, goToHostname])
  return (
    <QueryClientProvider client={client}>
      <RuntimeContext value={runtime}>
        <NavigationContext value={navigation}>
          <AuthenticationObserver />
          {children}
        </NavigationContext>
      </RuntimeContext>
    </QueryClientProvider>
  )
}
