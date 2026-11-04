import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { dashboardKeys } from '../../lib/queries'
import { createFakeFetch, requestFixture, requestsFixture, targetFixture, targetsFixture } from '../../test/fixtures'
import { renderDashboard } from '../../test/render'
import { RequestsPage } from './index'

function requestApi() {
  const api = createFakeFetch()
  api.on('GET', '/dashboard/api/targets', () => Response.json(targetsFixture({ targets: [targetFixture(), targetFixture({ name: 'office', runtimeId: 'office' })] })))
  return api
}

describe('requests Monitor', () => {
  it('keeps URL selection through reorder then shows not-retained without selecting another row', async () => {
    const api = requestApi()
    const first = requestFixture({ requestId: 'first' })
    const selected = requestFixture({ requestId: 'selected', state: 'failed', requestedModel: 'alias', effectiveModel: 'resolved', modelTransforms: [{ tag: 'rewrite', from: 'alias', to: 'resolved' }], selectedStrategy: 'native-messages', effects: [{ id: 'tool-normalization', count: 2 }], errorSummary: 'Upstream unavailable', status: 503 })
    let recent = [first, selected]
    api.on('GET', '/dashboard/api/requests', () => Response.json(requestsFixture({ recent })))
    const { client } = renderDashboard({ api, url: '/dashboard/requests?request=selected', children: <RequestsPage /> })
    const detail = await screen.findByRole('region', { name: 'Request detail' })
    await waitFor(() => expect(within(detail).getByRole('heading', { name: 'Transform trace' })).toBeVisible())
    await waitFor(() => expect(detail.contains(document.activeElement)).toBe(true))
    const focusedDetail = document.activeElement
    expect(within(detail).getByText('native-messages')).toBeVisible()
    expect(within(detail).getByText('Upstream unavailable')).toBeVisible()
    expect(within(detail).getByText('tool-normalization')).toBeVisible()
    expect(within(detail).getAllByText('alias')).toHaveLength(2)
    expect(within(detail).getAllByText('resolved')).toHaveLength(2)
    recent = [selected, first]
    await act(async () => {
      await client.invalidateQueries({ queryKey: dashboardKeys.requests })
    })
    expect(within(detail).getByLabelText('Request identifier')).toHaveTextContent('selected')
    expect(screen.getByRole('link', { name: 'selected' })).toHaveAttribute('aria-current', 'true')
    expect(document.activeElement).toBe(focusedDetail)
    recent = [first]
    await act(async () => {
      await client.invalidateQueries({ queryKey: dashboardKeys.requests })
    })
    await waitFor(() => expect(within(detail).getByText(/This request is not retained/)).toBeVisible())
    expect(new URL(window.location.href).searchParams.get('request')).toBe('selected')
    expect(screen.getByRole('link', { name: 'first' })).not.toHaveAttribute('aria-current', 'true')
    recent = [selected, first]
    await act(async () => {
      await client.invalidateQueries({ queryKey: dashboardKeys.requests })
    })
    expect(within(detail).getByLabelText('Request identifier')).toHaveTextContent('selected')
  })

  it('does not auto-select with no id and round-trips literal URL filters', async () => {
    const user = userEvent.setup()
    const api = requestApi()
    api.on('GET', '/dashboard/api/requests', () => Response.json(requestsFixture({ recent: [requestFixture({ requestId: 'literal', requestedModel: 'all', effectiveModel: 'all', endpoint: '/123', accountName: 'office', state: 'aborted' }), requestFixture({ requestId: 'excluded' })] })))
    renderDashboard({ api, url: '/dashboard/requests?target=office&state=aborted&endpoint=%2F123&model=all', children: <RequestsPage /> })
    await screen.findByRole('link', { name: 'literal' })
    expect(screen.queryByRole('link', { name: 'excluded' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Request state' })).toHaveDisplayValue('Aborted')
    expect(screen.getByRole('combobox', { name: 'Endpoint' })).toHaveDisplayValue('/123')
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveDisplayValue('all')
    expect(screen.getByText('Select a request to inspect its lifecycle and routing decisions.')).toBeVisible()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Request state' }), screen.getByRole('option', { name: 'All states' }))
    await waitFor(() => expect(new URL(window.location.href).searchParams.has('state')).toBe(false))
    expect(new URL(window.location.href).searchParams.get('target')).toBe('office')
    expect(new URL(window.location.href).searchParams.get('model')).toBe('all')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Endpoint' }), screen.getByRole('option', { name: '/v1/messages' }))
    await waitFor(() => expect(new URL(window.location.href).searchParams.get('endpoint')).toBe('/v1/messages'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), screen.getByRole('option', { name: 'claude-sonnet' }))
    await waitFor(() => expect(new URL(window.location.href).searchParams.get('model')).toBe('claude-sonnet'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Endpoint' }), screen.getByRole('option', { name: '/123' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), screen.getByRole('option', { name: 'all' }))
    await user.click(screen.getByRole('link', { name: 'literal' }))
    await waitFor(() => expect(new URL(window.location.href).searchParams.get('request')).toBe('literal'))
    expect(screen.getByLabelText('Request identifier')).toHaveTextContent('literal')
  })

  it('keeps selected detail when filters hide its row and includes streaming plus terminal aborted counts', async () => {
    const api = requestApi()
    api.on('GET', '/dashboard/api/requests', () => Response.json(requestsFixture({ active: [requestFixture({ requestId: 'stream', state: 'streaming' })], recent: [requestFixture({ requestId: 'abort', state: 'aborted' }), requestFixture({ requestId: 'failed', state: 'failed' })], totals: { started: 12, completed: 8, failed: 2, aborted: 3 } })))
    renderDashboard({ api, url: '/dashboard/requests?request=abort&state=streaming', children: <RequestsPage /> })
    await screen.findByRole('link', { name: 'stream' })
    expect(screen.queryByRole('link', { name: 'abort' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Request identifier')).toHaveTextContent('abort')
    expect(screen.getByLabelText('Retained terminal requests')).toHaveTextContent('2')
    expect(screen.getByLabelText('Retained aborted requests')).toHaveTextContent('1')
    expect(screen.getByLabelText('Since-startup terminal requests')).toHaveTextContent('11')
    expect(screen.getByLabelText('Since-startup aborted requests')).toHaveTextContent('3')
  })

  it('keeps an absent id after a successful empty poll and distinguishes no traffic from zero retained failures', async () => {
    const api = requestApi()
    let recent = [requestFixture()]
    api.on('GET', '/dashboard/api/requests', () => Response.json(requestsFixture({ recent, totals: { started: recent.length, completed: recent.length, failed: 0, aborted: 0 } })))
    const { client } = renderDashboard({ api, url: '/dashboard/requests?request=missing&state=failed', children: <RequestsPage /> })
    await screen.findByText(/Zero failures in the retained requests/)
    expect(screen.getByText(/This request is not retained/)).toBeVisible()
    recent = []
    await act(async () => {
      await client.invalidateQueries({ queryKey: dashboardKeys.requests })
    })
    await screen.findByText(/No traffic yet/)
    expect(screen.getByText(/This request is not retained/)).toBeVisible()
    expect(new URL(window.location.href).searchParams.get('request')).toBe('missing')
  })
})
