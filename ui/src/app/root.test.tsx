import { focusManager } from '@tanstack/react-query'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Region } from '../components/primitives'
import { dashboardKeys, useMetrics, useRequests } from '../lib/queries'
import { authenticationFixture, createFakeFetch, deferred, FIXTURE_STARTED_AT, metricsFixture, overviewFixture, requestsFixture, targetsFixture } from '../test/fixtures'
import { renderDashboard } from '../test/render'
import { useDashboard, useDashboardUrl } from './context'

function PageReads() {
  const { url } = useDashboardUrl()
  return url.page === 'traffic' ? <MetricsReadout /> : url.page === 'requests' ? <RequestsReadout /> : <p>Configuration content</p>
}
function MetricsReadout() {
  const { url, navigate } = useDashboardUrl()
  const query = useMetrics(url.window, url.target)
  return (
    <>
      <button type="button" onClick={() => navigate({ window: '15m' })}>Short window</button>
      <button type="button" onClick={() => navigate({ window: '1h' })}>Hourly window</button>
      <Region title="Traffic data" result={query.region}>{data => <p aria-label="Current count">{data.counts.completed}</p>}</Region>
    </>
  )
}
function RequestsReadout() {
  const query = useRequests()
  return <Region title="Requests data" result={query.region}>{data => <p>{data.recent.length}</p>}</Region>
}
function AuthenticationStarter() {
  const { trackAuthentication } = useDashboard()
  return <button type="button" onClick={() => trackAuthentication(authenticationFixture().authentication)}>Connect account</button>
}
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-04T00:10:00.000Z'))
  focusManager.setFocused(true)
})
afterEach(() => {
  focusManager.setFocused(undefined)
  vi.useRealTimers()
})

describe('dashboard root session and task lifetime', () => {
  it('unmounts page reads on navigation while the shell header stays live', async () => {
    const { api } = renderDashboard({ url: '/dashboard/traffic', children: <PageReads /> })
    await advance()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Dashboard navigation' })).getByRole('link', { name: 'Targets' }))
    await advance(60_000)
    expect(api.count('GET', '/dashboard/api/metrics')).toBe(1)
    expect(api.count('GET', '/dashboard/api/overview')).toBeGreaterThan(1)
    expect(api.requests.some(request => request.method !== 'GET')).toBe(false)
  })

  it('still loads a newly opened page and allows explicit Refresh while Live is paused', async () => {
    const { api } = renderDashboard({ url: '/dashboard/targets', children: <PageReads /> })
    await advance()
    fireEvent.click(screen.getByRole('button', { name: /Live/ }))
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Dashboard navigation' })).getByRole('link', { name: 'Traffic' }))
    await advance(60_000)
    expect(api.count('GET', '/dashboard/api/metrics')).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await advance()
    expect(api.count('POST', '/dashboard/api/refresh')).toBe(1)
    expect(api.count('GET', '/dashboard/api/metrics')).toBe(2)
  })

  it('keeps pending device authentication alive hidden and across routes, then stops at success', async () => {
    const api = createFakeFetch()
    let polls = 0
    api.on('GET', '/dashboard/api/account-auth/auth-1', () => Response.json(authenticationFixture({ state: ++polls >= 3 ? 'succeeded' : 'pending' })))
    renderDashboard({
      api,
      url: '/dashboard/traffic',
      children: (
        <>
          <AuthenticationStarter />
          <PageReads />
        </>
      ),
    })
    await advance()
    fireEvent.click(screen.getByRole('button', { name: 'Connect account' }))
    await advance()
    act(() => focusManager.setFocused(false))
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Dashboard navigation' })).getByRole('link', { name: 'Targets' }))
    await advance(2_000)
    expect(api.count('GET', '/dashboard/api/account-auth/auth-1')).toBe(3)
    await advance(20_000)
    expect(api.count('GET', '/dashboard/api/account-auth/auth-1')).toBe(3)
    expect(screen.getByRole('status')).toHaveTextContent(/connected/i)
  })

  it.each([403, 404, 421])('stops a task permanently on session status %s', async (status) => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/account-auth/auth-1', () => Response.json({ error: { message: 'Session unavailable', type: 'invalid_request_error' } }, { status }))
    renderDashboard({ api, children: <AuthenticationStarter /> })
    await advance()
    fireEvent.click(screen.getByRole('button', { name: 'Connect account' }))
    await advance(20_000)
    expect(api.count('GET', '/dashboard/api/account-auth/auth-1')).toBe(1)
    expect(screen.getByRole('status')).toHaveTextContent(/Session unavailable/)
  })

  it.each(['startedAt', 'collectionStartedAt'] as const)('clears selection and cached series after an accepted %s change', async (identityField) => {
    const api = createFakeFetch()
    let currentSession = FIXTURE_STARTED_AT
    let collection = FIXTURE_STARTED_AT
    api.on('GET', '/dashboard/api/overview', () => Response.json(overviewFixture({ startedAt: currentSession })))
    api.on('GET', '/dashboard/api/targets', () => Response.json(targetsFixture({ startedAt: currentSession })))
    api.on('GET', '/dashboard/api/metrics', request => Response.json(metricsFixture({ window: request.url.searchParams.get('window') === '15m' ? '15m' : '1h', startedAt: currentSession, collectionStartedAt: collection })))
    const { client } = renderDashboard({ api, url: '/dashboard/traffic?window=15m&request=selected', children: <PageReads /> })
    await advance()
    fireEvent.click(screen.getByRole('button', { name: 'Hourly window' }))
    await advance()
    expect(client.getQueryData(dashboardKeys.metrics('15m'))).toBeDefined()
    if (identityField === 'startedAt')
      currentSession = '2026-11-04T00:11:00.000Z'
    else
      collection = '2026-11-04T00:11:00.000Z'
    await advance(30_000)
    expect(new URL(window.location.href).searchParams.has('request')).toBe(false)
    expect(client.getQueryData(dashboardKeys.metrics('15m'))).toBeUndefined()
    expect(screen.getByRole('status')).toHaveTextContent(/session changed/i)
  })

  it('ignores a canceled old response instead of restoring the previous session', async () => {
    const api = createFakeFetch()
    const old = deferred<Response>()
    let session = FIXTURE_STARTED_AT
    let calls = 0
    api.on('GET', '/dashboard/api/overview', () => Response.json(overviewFixture({ startedAt: session })))
    api.on('GET', '/dashboard/api/targets', () => Response.json(targetsFixture({ startedAt: session })))
    api.on('GET', '/dashboard/api/metrics', () => ++calls === 1 ? old.promise : Response.json(metricsFixture({ startedAt: session })))
    const { client } = renderDashboard({ api, url: '/dashboard/traffic?window=15m&request=selected', children: <PageReads /> })
    await advance()
    session = '2026-11-04T00:11:00.000Z'
    fireEvent.click(screen.getByRole('button', { name: 'Hourly window' }))
    await advance()
    const oldRequest = api.requests.find(request => request.url.pathname.endsWith('/metrics'))
    expect(oldRequest?.signal?.aborted).toBe(true)
    old.resolve(Response.json(metricsFixture()))
    await advance()
    expect(client.getQueryData(dashboardKeys.metrics('15m'))).toBeUndefined()
    expect(new URL(window.location.href).searchParams.has('request')).toBe(false)
  })

  it('stops normal rendering and polling on a schema mismatch', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/metrics', () => Response.json({ ...metricsFixture(), schemaVersion: 999 }))
    renderDashboard({ api, url: '/dashboard/traffic', children: <PageReads /> })
    await advance()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Reload/)
    expect(screen.getByRole('button', { name: 'Reload Dashboard' })).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Traffic data' })).not.toBeInTheDocument()
    const reads = api.requests.length
    await advance(60_000)
    expect(api.requests).toHaveLength(reads)
  })

  it('announces one connection transition when every active source fails', async () => {
    const api = createFakeFetch()
    const unavailable = () => Response.json({ error: { message: 'Offline', type: 'upstream_error' } }, { status: 503 })
    api.on('GET', '/dashboard/api/overview', unavailable)
    api.on('GET', '/dashboard/api/targets', unavailable)
    api.on('GET', '/dashboard/api/requests', unavailable)
    renderDashboard({ api, url: '/dashboard/requests', children: <PageReads /> })
    await advance()
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent(/Connection lost/)
    await advance(12_000)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent(/Connection lost/)
    api.on('GET', '/dashboard/api/requests', () => Response.json(requestsFixture()))
    await advance(30_000)
    expect(screen.getByRole('status')).toHaveTextContent(/Connection restored/)
  })
})
