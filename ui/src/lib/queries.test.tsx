import type { DashboardTarget } from '@contract'
import { focusManager } from '@tanstack/react-query'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDashboard, useDashboardUrl } from '../app/context'
import { Region } from '../components/primitives'
import { createFakeFetch, deferred, metricsFixture, overviewFixture, quotaFixture, refreshFixture, requestsFixture, targetFixture, targetsFixture } from '../test/fixtures'
import { renderDashboard } from '../test/render'
import { useDashboardMutation } from './mutations'
import { dashboardKeys, useMetrics, useRequests, useTargetQuota } from './queries'

function MetricsPanel() {
  const { url } = useDashboardUrl()
  const metrics = useMetrics(url.window, url.target)
  const [draft, setDraft] = useState('')
  return (
    <>
      <label>
        Operator note
        <input value={draft} onChange={event => setDraft(event.target.value)} />
      </label>
      <Region title="Metrics" result={metrics.region}>{data => <p aria-label="Completed count">{data.counts.completed}</p>}</Region>
    </>
  )
}

it('keeps controlled draft input intact when accepted polling data rerenders its region', async () => {
  renderDashboard({ children: <MetricsPanel /> })
  await advance()
  fireEvent.change(screen.getByRole('textbox', { name: 'Operator note' }), { target: { value: 'keep this draft' } })
  await advance(30_000)
  expect(screen.getByRole('textbox', { name: 'Operator note' })).toHaveValue('keep this draft')
})

function TrafficReadout() {
  const { url } = useDashboardUrl()
  const metrics = useMetrics(url.window, url.target)
  return <Region title="Metrics" result={metrics.region}>{data => <p aria-label="Completed count">{data.counts.completed}</p>}</Region>
}

function RequestsReadout() {
  const requests = useRequests()
  return <Region title="Requests data" result={requests.region}>{data => <p aria-label="Retained count">{data.recent.length}</p>}</Region>
}

function QuotaReadout({ target }: { target: DashboardTarget }) {
  const quota = useTargetQuota(target)
  return <Region title="Quota" result={quota.region}>{data => <p aria-label="Remaining quota">{data.quota.premiumInteractions?.remaining}</p>}</Region>
}

function MutationControl() {
  const mutation = useDashboardMutation({ domains: ['requests'], mutation: api => api.setDefault({ accountName: 'work' }) })
  return <button type="button" onClick={() => mutation.mutate(undefined)}>Set default</button>
}

function StopControl() {
  const { stop } = useDashboard()
  return (
    <button
      type="button"
      onClick={() => {
        void stop()
      }}
    >
      Stop all reads
    </button>
  )
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

describe('query-owned live data lifecycle', () => {
  it('loads once while paused, polls only reads, pauses hidden and refetches stale data on visibility return', async () => {
    const { api } = renderDashboard({ children: <TrafficReadout /> })
    await advance()
    expect(api.requests.every(request => request.method === 'GET')).toBe(true)
    expect(api.count('GET', '/dashboard/api/metrics')).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: /Live/ }))
    await advance(60_000)
    expect(api.count('GET', '/dashboard/api/metrics')).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: /Live/ }))
    await advance()
    act(() => focusManager.setFocused(false))
    await advance(60_000)
    expect(api.count('GET', '/dashboard/api/metrics')).toBe(1)
    act(() => focusManager.setFocused(true))
    await advance()
    expect(api.count('GET', '/dashboard/api/metrics')).toBe(2)
    expect(api.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  })

  it('never overlaps a slow region read with its recurring tick', async () => {
    const api = createFakeFetch()
    const pending = deferred<Response>()
    api.on('GET', '/dashboard/api/metrics', () => pending.promise)
    renderDashboard({ api, children: <TrafficReadout /> })
    await advance(120_000)
    expect(api.count('GET', '/dashboard/api/metrics')).toBe(1)
    pending.resolve(Response.json(metricsFixture()))
    await advance()
    expect(screen.getByLabelText('Completed count')).toHaveTextContent('6')
  })

  it('refreshes the current target list and drops a selected target removed by another client', async () => {
    const api = createFakeFetch()
    let removed = false
    const personal = targetFixture({ name: 'personal', hostname: 'personal.localhost', runtimeId: 'target-personal' })
    const work = targetFixture({ isDefault: false, actions: { canSetDefault: true, canRemove: true } })
    api.on('GET', '/dashboard/api/targets', () => Response.json(targetsFixture({
      hostTarget: 'personal',
      routing: { baseHostname: 'localhost', defaultAccount: 'personal', routingEnabled: true },
      targets: removed ? [personal] : [personal, work],
    })))
    renderDashboard({ api, url: '/dashboard/traffic?target=work', children: <TrafficReadout /> })
    await advance()
    expect(screen.getByRole('combobox', { name: 'Route target' })).toHaveValue('work')
    removed = true
    await advance(3_000)
    expect(api.count('GET', '/dashboard/api/targets')).toBe(2)
    expect(new URL(window.location.href).searchParams.has('target')).toBe(false)
    expect(screen.queryByRole('combobox', { name: 'Route target' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/no longer exists/i)
  })

  it('queues exactly one explicit metadata POST behind current Query promises', async () => {
    const api = createFakeFetch()
    const pending = deferred<Response>()
    let first = true
    api.on('GET', '/dashboard/api/metrics', () => {
      if (first) {
        first = false
        return pending.promise
      }
      return Response.json(metricsFixture())
    })
    renderDashboard({ api, children: <TrafficReadout /> })
    await advance()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await advance(10_000)
    expect(api.count('POST', '/dashboard/api/refresh')).toBe(0)
    expect(screen.getByRole('button', { name: /Refreshing/ })).toBeDisabled()
    pending.resolve(Response.json(metricsFixture()))
    await advance()
    expect(api.count('POST', '/dashboard/api/refresh')).toBe(1)
    expect(api.count('GET', '/dashboard/api/metrics')).toBe(2)
    expect(api.requests.filter(request => request.method === 'POST')).toHaveLength(1)
  })

  it('retains a failed region, becomes stale on its second failure and recovers only on its own success', async () => {
    const api = createFakeFetch()
    let failures = false
    api.on('GET', '/dashboard/api/metrics', () => failures
      ? Response.json({ error: { message: 'Metrics offline', type: 'upstream_error' } }, { status: 503 })
      : Response.json(metricsFixture()))
    renderDashboard({
      api,
      children: (
        <>
          <TrafficReadout />
          <RequestsReadout />
        </>
      ),
    })
    await advance()
    failures = true
    await advance(30_000)
    const metrics = screen.getByRole('region', { name: 'Metrics' })
    expect(within(metrics).getByLabelText('Completed count')).toHaveTextContent('6')
    expect(within(metrics).getByText(/Metrics offline/)).toBeVisible()
    await advance(30_000)
    expect(within(metrics).getByText(/last known data/i)).toBeVisible()
    expect(api.count('GET', '/dashboard/api/requests')).toBeGreaterThan(2)
    await advance(3_000)
    expect(within(metrics).getByText(/Metrics offline/)).toBeVisible()
    failures = false
    await advance(30_000)
    expect(within(metrics).queryByText(/Metrics offline/)).not.toBeInTheDocument()
    expect(within(metrics).getByLabelText('Completed count')).toHaveTextContent('6')
  })

  it.each([403, 421])('stops automatic retries for permanent boundary status %s', async (status) => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/metrics', () => Response.json({ error: { message: 'Host boundary rejected', type: 'invalid_request_error' } }, { status }))
    renderDashboard({ api, children: <TrafficReadout /> })
    await advance()
    await advance(120_000)
    expect(api.count('GET', '/dashboard/api/metrics')).toBe(1)
    expect(within(screen.getByRole('region', { name: 'Metrics' })).getByText(/Automatic updates stopped/)).toBeVisible()
  })

  it('cancels a region before its mutation and reads it again after settling', async () => {
    const api = createFakeFetch()
    const pending = deferred<Response>()
    let first = true
    api.on('GET', '/dashboard/api/requests', () => {
      if (first) {
        first = false
        return pending.promise
      }
      return Response.json(requestsFixture())
    })
    const change = deferred<Response>()
    api.on('POST', '/dashboard/api/accounts/default', () => change.promise)
    renderDashboard({
      api,
      children: (
        <>
          <RequestsReadout />
          <MutationControl />
        </>
      ),
    })
    await advance()
    const originalSignal = api.requests.find(request => request.url.pathname.endsWith('/requests'))?.signal
    fireEvent.click(screen.getByRole('button', { name: 'Set default' }))
    await advance(10_000)
    expect(originalSignal?.aborted).toBe(true)
    expect(api.count('GET', '/dashboard/api/requests')).toBe(1)
    change.resolve(Response.json({ ...overviewFixture(), baseHostname: 'localhost', defaultAccount: 'work', routingEnabled: true }))
    await advance()
    expect(api.count('GET', '/dashboard/api/requests')).toBe(2)
    pending.resolve(Response.json(requestsFixture({ recent: [] })))
    await advance()
    expect(screen.getByLabelText('Retained count')).toHaveTextContent('1')
  })

  it('isolates quota by runtime identity and never displays a predecessor response', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/targets/work/quota', () => Response.json(quotaFixture({ runtimeId: 'old-runtime' })))
    const target = targetFixture({ runtimeId: 'new-runtime' })
    const { client } = renderDashboard({ api, children: <QuotaReadout target={target} /> })
    await advance()
    expect(client.getQueryData(dashboardKeys.quota(target))).toBeDefined()
    expect(screen.queryByLabelText('Remaining quota')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Quota' })).toHaveTextContent(/previous instance/)
  })

  it('cancels all Query-owned reads before a host-changing navigation can occur', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/metrics', () => deferred<Response>().promise)
    renderDashboard({
      api,
      children: (
        <>
          <TrafficReadout />
          <StopControl />
        </>
      ),
    })
    await advance()
    const signal = api.requests.find(request => request.url.pathname.endsWith('/metrics'))?.signal
    fireEvent.click(screen.getByRole('button', { name: 'Stop all reads' }))
    await advance(120_000)
    expect(signal?.aborted).toBe(true)
    expect(api.count('GET', '/dashboard/api/metrics')).toBe(1)
    expect(screen.getByRole('button', { name: /Live/ })).toBeDisabled()
  })

  it('applies consecutive-failure backoff across separate fast-source polling cycles', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/requests', () => Response.json({ error: { message: 'Activity offline', type: 'upstream_error' } }, { status: 503 }))
    renderDashboard({ api, children: <RequestsReadout /> })
    await advance()
    expect(api.count('GET', '/dashboard/api/requests')).toBe(1)
    await advance(5_999)
    expect(api.count('GET', '/dashboard/api/requests')).toBe(1)
    await advance(1)
    expect(api.count('GET', '/dashboard/api/requests')).toBe(2)
    await advance(11_999)
    expect(api.count('GET', '/dashboard/api/requests')).toBe(2)
    await advance(1)
    expect(api.count('GET', '/dashboard/api/requests')).toBe(3)
    await advance(24_000)
    expect(api.count('GET', '/dashboard/api/requests')).toBe(4)
    await advance(30_000)
    expect(api.count('GET', '/dashboard/api/requests')).toBe(5)
  })

  it('keeps a partial metadata outcome partial and preserves a separately failing region', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/metrics', () => Response.json({ error: { message: 'Metrics remain unavailable', type: 'upstream_error' } }, { status: 503 }))
    api.on('POST', '/dashboard/api/refresh', () => Response.json(refreshFixture({ status: 'partial' })))
    renderDashboard({ api, children: <TrafficReadout /> })
    await advance()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await advance()
    expect(api.count('POST', '/dashboard/api/refresh')).toBe(1)
    expect(screen.getByRole('status')).toHaveTextContent(/partial/i)
    expect(screen.getByRole('region', { name: 'Metrics' })).toHaveTextContent(/Metrics remain unavailable/)
  })
})
