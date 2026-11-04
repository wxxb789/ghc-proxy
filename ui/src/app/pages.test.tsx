import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { createFakeFetch, requestFixture, requestsFixture } from '../test/fixtures'
import { renderDashboard } from '../test/render'
import { DashboardPages } from './pages'

it('opens a cached recent failure with its detail focused and the global URL context retained', async () => {
  const api = createFakeFetch()
  api.on('GET', '/dashboard/api/requests', () => Response.json(requestsFixture({ recent: [requestFixture({ requestId: 'retained-failure', state: 'failed', status: 503, errorSummary: 'Upstream HTTP 503' })] })))
  renderDashboard({ api, shell: false, url: '/dashboard/overview?window=24h&target=work', children: <DashboardPages /> })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('link', { name: 'retained-failure' }))
  const detail = await screen.findByRole('region', { name: 'Request detail' })
  await waitFor(() => expect(detail.contains(document.activeElement)).toBe(true))
  expect(within(detail).getByLabelText('Request identifier')).toHaveTextContent('retained-failure')
  expect(within(detail).getByRole('region', { name: 'Error summary' })).toHaveTextContent('Upstream HTTP 503')
  const url = new URL(window.location.href)
  expect(url.pathname).toBe('/dashboard/requests')
  expect(Object.fromEntries(url.searchParams)).toEqual({ target: 'work', window: '24h', request: 'retained-failure', state: 'failed' })
  expect(document.title).toContain('Requests')
})
