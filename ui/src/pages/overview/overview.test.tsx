import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createFakeFetch, metricsFixture, quotaFixture, requestFixture, requestsFixture, targetFixture, targetsFixture } from '../../test/fixtures'
import { renderDashboard } from '../../test/render'
import { OverviewPage } from './index'

function overviewApi() {
  const api = createFakeFetch()
  const m365 = targetFixture({ name: 'office', runtimeId: 'office-1', kind: 'm365', health: { status: 'degraded', github: { status: 'not_applicable' }, copilot: { status: 'degraded', modelsLoaded: true } }, queue: { active: 2, concurrency: 3, pending: 4, maxPending: 8, accountCooldown: true, modelCooldowns: 1 } })
  api.on('GET', '/dashboard/api/targets', () => Response.json(targetsFixture({ targets: [targetFixture(), m365] })))
  api.on('GET', '/dashboard/api/targets/office/quota', () => Response.json(quotaFixture({ target: 'office', runtimeId: 'office-1', quota: { status: 'not_applicable' } })))
  api.on('GET', '/dashboard/api/metrics', ({ url }) => {
    const latency = { count: 1, sumMs: 100, p50: { valueMs: 100, kind: 'at-most' as const }, p95: { valueMs: 100, kind: 'at-most' as const } }
    return Response.json(metricsFixture(url.searchParams.get('target') === 'office'
      ? {
          counts: { completed: 1, failed: 1, aborted: 2 },
          coveredMs: 2_000,
          latency: { ...latency, histogram: [1, 0] },
          latencyBoundsMs: [100],
          series: [{ ...metricsFixture().series[0]!, counts: { completed: 1, failed: 1, aborted: 2 }, latency }],
        }
      : {}))
  })
  api.on('GET', '/dashboard/api/requests', () => Response.json(requestsFixture({ active: [requestFixture({ requestId: 'stream', accountName: 'office', state: 'streaming' }), requestFixture({ requestId: 'work-active', state: 'in_flight' })], recent: [requestFixture({ requestId: 'office-error', accountName: 'office', state: 'failed', errorSummary: 'Office failed' }), requestFixture({ requestId: 'work-error', state: 'failed', errorSummary: 'Work failed' })] })))
  return api
}

describe('overview Monitor', () => {
  it('scopes every projection to M365 and counts streaming as active', async () => {
    const api = overviewApi()
    renderDashboard({ api, url: '/dashboard/overview?target=office', children: <OverviewPage /> })
    const kpis = await screen.findByRole('region', { name: 'Window health and performance' })
    await waitFor(() => expect(within(kpis).getByLabelText('Terminal requests')).toHaveTextContent('4'))
    expect(within(kpis).getByLabelText('Request rate')).toHaveTextContent('2 /s')
    expect(within(kpis).getByLabelText('Error rate')).toHaveTextContent('50%')
    expect(within(kpis).getByLabelText('p95 latency')).toHaveTextContent('≤ 100 ms')
    const active = await screen.findByRole('region', { name: 'Active request activity' })
    await waitFor(() => expect(within(active).getByLabelText('Active requests')).toHaveTextContent('1'))
    const queue = await screen.findByRole('region', { name: 'Selected-target queue' })
    expect(within(queue).getByLabelText('Queue slots')).toHaveTextContent('2 / 3')
    expect(within(queue).getByLabelText('Pending requests')).toHaveTextContent('4')
    const health = await screen.findByRole('region', { name: 'Target health' })
    expect(within(health).getByRole('heading', { name: 'office' })).toBeVisible()
    expect(within(health).queryByRole('heading', { name: 'work' })).not.toBeInTheDocument()
    const failures = await screen.findByRole('region', { name: 'Recent failures' })
    await waitFor(() => expect(within(failures).getByRole('link', { name: 'office-error' })).toBeVisible())
    expect(within(failures).queryByRole('link', { name: 'work-error' })).not.toBeInTheDocument()
    expect(within(failures).getByRole('link', { name: 'office-error' })).toHaveAttribute('href', '/dashboard/requests?target=office&request=office-error&state=failed')
    const trend = screen.getByRole('figure', { name: 'Requests over time' })
    expect(trend).toHaveTextContent('Latest 4 requests')
    expect(screen.getByRole('figure', { name: 'Latency over time' })).toHaveTextContent('1 observed completed-request samples')
    const quota = await screen.findByRole('region', { name: 'office quota' })
    await waitFor(() => expect(within(quota).getByText(/Quota is not applicable/)).toBeVisible())
    expect(api.requests.filter(request => request.url.pathname.endsWith('/quota')).map(request => request.url.pathname)).toEqual(['/dashboard/api/targets/office/quota'])
    expect(api.requests.some(request => request.url.pathname === '/dashboard/api/metrics' && request.url.searchParams.get('target') === 'office')).toBe(true)
  })

  it('uses All projections and differentiates no traffic from zero failures', async () => {
    const api = overviewApi()
    renderDashboard({ api, children: <OverviewPage /> })
    await waitFor(() => expect(screen.getByLabelText('Terminal requests')).toHaveTextContent('8'))
    expect(screen.getByLabelText('Request rate')).toHaveTextContent('0.0133 /s')
    await waitFor(() => expect(screen.getByLabelText('Active requests')).toHaveTextContent('2'))
    expect(within(screen.getByRole('region', { name: 'Target health' })).getByRole('heading', { name: 'work' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'work-error' })).toBeVisible()
    expect(within(screen.getByRole('region', { name: 'Target health' })).getByRole('heading', { name: 'office' })).toBeVisible()
    await waitFor(() => expect(api.requests.filter(request => request.url.pathname.endsWith('/quota')).map(request => request.url.pathname).sort()).toEqual(['/dashboard/api/targets/office/quota', '/dashboard/api/targets/work/quota']))
  })

  it('keeps target health and metrics usable when one target quota fails', async () => {
    const api = overviewApi()
    api.on('GET', '/dashboard/api/targets/work/quota', () => Response.json({ error: { message: 'Quota source failed.', type: 'upstream_error' } }, { status: 500 }))
    renderDashboard({ api, children: <OverviewPage /> })
    const quota = await screen.findByRole('region', { name: 'work quota' })
    await waitFor(() => expect(within(quota).getByText('Quota source failed.')).toBeVisible())
    expect(screen.getByLabelText('Terminal requests')).toHaveTextContent('8')
    expect(screen.getByRole('article', { name: 'work health' })).toHaveTextContent('Healthy')
    expect(screen.getByRole('region', { name: 'office quota' })).not.toHaveTextContent('Quota source failed.')
  })

  it('keeps window failure totals when the request ring has no matching retained failures', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/metrics', () => Response.json(metricsFixture({ counts: { completed: 2, failed: 5, aborted: 0 } })))
    api.on('GET', '/dashboard/api/requests', () => Response.json(requestsFixture({ recent: [] })))
    renderDashboard({ api, children: <OverviewPage /> })
    const failures = await screen.findByRole('region', { name: 'Recent failures' })
    await waitFor(() => expect(within(failures).getByText('No failures from this window are retained in the request list.')).toBeVisible())
    expect(failures).toHaveTextContent('5 failures in the 1h window')
  })

  it('does not equate an uncovered window with zero traffic or zero failures', async () => {
    const api = createFakeFetch()
    const base = metricsFixture()
    api.on('GET', '/dashboard/api/metrics', () => Response.json(metricsFixture({ coveredMs: 0, counts: { completed: 0, failed: 0, aborted: 0 }, series: [{ ...base.series[0]!, coverage: 'not-collected' }] })))
    renderDashboard({ api, children: <OverviewPage /> })
    await waitFor(() => expect(screen.getByLabelText('Terminal requests')).toHaveTextContent('Not collected'))
    const failures = screen.getByRole('region', { name: 'Recent failures' })
    expect(failures).toHaveTextContent('Failure counts are not yet available')
    expect(within(failures).queryByText(/No traffic yet|Zero failures/)).not.toBeInTheDocument()
  })

  it.each([0, 3])('explains empty failure lists for %i terminal requests', async (completed) => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/metrics', () => Response.json(metricsFixture({ counts: { completed, failed: 0, aborted: 0 } })))
    api.on('GET', '/dashboard/api/requests', () => Response.json(requestsFixture({ active: [], recent: [] })))
    renderDashboard({ api, children: <OverviewPage /> })
    const region = await screen.findByRole('region', { name: 'Recent failures' })
    await waitFor(() => expect(within(region).getByText(completed === 0 ? /No traffic yet/ : /Zero failures/)).toBeVisible())
  })
})
