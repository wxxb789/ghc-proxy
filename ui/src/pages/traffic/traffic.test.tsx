import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createFakeFetch, metricsFixture, requestFixture, requestsFixture } from '../../test/fixtures'
import { renderDashboard } from '../../test/render'
import { TrafficPage } from './index'

describe('traffic Monitor', () => {
  it('uses the selected target projection in terminal stacks, distribution and breakdown numeric data', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/metrics', ({ url }) => {
      const counts = { completed: 2, failed: 1, aborted: 3 }
      const latency = { count: 2, sumMs: 600, p50: { valueMs: 50, kind: 'at-most' as const }, p95: { valueMs: 400, kind: 'at-least' as const } }
      return Response.json(metricsFixture({
        window: '15m',
        counts,
        byModel: [{ kind: 'named', value: 'other', requests: 4, failures: 1 }, { kind: 'other', requests: 2, failures: 0 }],
        byTarget: [{ kind: 'named', value: url.searchParams.get('target')!, requests: 6, failures: 1 }],
        latency: { ...latency, histogram: [1, 0, 0, 0, 1] },
        latencyBoundsMs: [50, 100, 200, 400],
        series: [{ ...metricsFixture({ window: '15m' }).series[0]!, counts, latency }],
      }))
    })
    api.on('GET', '/dashboard/api/requests', () => Response.json(requestsFixture({ recent: [requestFixture({ requestId: 'failed-office', accountName: 'office', state: 'failed' })] })))
    renderDashboard({ api, shell: false, url: '/dashboard/traffic?window=15m&target=office', children: <TrafficPage /> })
    const models = await screen.findByRole('figure', { name: 'Requests and failures by model' })
    fireEvent.click(within(models).getByText('View numeric data'))
    const table = within(models).getByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(within(rows[1]!).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['other', '4', '1'])
    expect(within(rows[2]!).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['Other (folded)', '2', '0'])
    const distribution = screen.getByRole('figure', { name: 'Latency distribution' })
    fireEvent.click(within(distribution).getByText('View numeric data'))
    expect(within(distribution).getByRole('table')).toHaveTextContent('Over 400 ms')
    const sampleRows = within(within(distribution).getByRole('table')).getAllByRole('row').slice(1)
    expect(sampleRows.map(row => within(row).getAllByRole('cell')[1]!.textContent)).toEqual(['1', '0', '0', '0', '1'])
    const targets = screen.getByRole('figure', { name: 'Requests and failures by target' })
    expect(targets).toHaveTextContent('6 requests, 1 failures')
    const traffic = screen.getByRole('figure', { name: 'Requests over time' })
    fireEvent.click(within(traffic).getByText('View numeric data'))
    const terminalRow = within(within(traffic).getByRole('table')).getAllByRole('row')[1]!
    expect(within(terminalRow).getAllByRole('cell').slice(2).map(cell => cell.textContent)).toEqual(['2', '1', '3', '6'])
    expect(screen.getByText('1 failures in the 15m window.', { exact: false })).toBeVisible()
    expect(await screen.findByRole('link', { name: 'failed-office' })).toHaveAttribute('href', '/dashboard/requests?target=office&window=15m&request=failed-office&state=failed')
    expect(api.requests.some(request => request.url.pathname === '/dashboard/api/metrics' && request.url.searchParams.get('target') === 'office' && request.url.searchParams.get('window') === '15m')).toBe(true)
  })

  it('does not present a zero-traffic window as a failed request lookup', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/metrics', () => Response.json(metricsFixture({ counts: { completed: 0, failed: 0, aborted: 0 }, latency: { count: 0, sumMs: 0, p50: null, p95: null, histogram: [] }, byModel: [], byEndpoint: [], byTarget: [] })))
    api.on('GET', '/dashboard/api/requests', () => Response.json(requestsFixture({ recent: [] })))
    renderDashboard({ api, shell: false, url: '/dashboard/traffic', children: <TrafficPage /> })
    const failures = await screen.findByRole('region', { name: 'Recent failures' })
    await waitFor(() => expect(within(failures).getByText('No traffic yet in this window.')).toBeVisible())
    expect(screen.getByRole('figure', { name: 'Requests over time' })).toBeVisible()
  })
})
