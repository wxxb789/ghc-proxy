import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseUrl } from '../lib/url-state'
import { createFakeFetch, overviewFixture, targetFixture, targetsFixture } from '../test/fixtures'
import { renderDashboard } from '../test/render'
import { useDashboardUrl } from './context'

function NavigationControls() {
  const { navigate } = useDashboardUrl()
  return (
    <>
      <button type="button" onClick={() => navigate({ window: '24h' })}>Change window</button>
      <button type="button" onClick={() => navigate({ page: 'requests', request: 'request-2' }, 'push')}>Open request</button>
    </>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  delete document.documentElement.dataset.theme
})

describe('shared Dashboard shell', () => {
  it('moves route focus and title, preserving global context but dropping request selection', async () => {
    const user = userEvent.setup()
    renderDashboard({ url: '/dashboard/requests?window=24h&target=work&request=request-1', children: <p>Fixture content</p> })
    const traffic = within(screen.getByRole('navigation', { name: 'Dashboard navigation' })).getByRole('link', { name: 'Traffic' })
    await user.click(traffic)
    const heading = screen.getByRole('heading', { level: 1, name: 'Traffic' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(document.title).toContain('Traffic')
    expect(parseUrl(window.location.href)).toMatchObject({ page: 'traffic', window: '24h', target: 'work', request: undefined })
    expect(traffic).toHaveAttribute('aria-current', 'page')
  })

  it('uses push for opening a request and replace for filter/window changes', async () => {
    renderDashboard({ children: <NavigationControls /> })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled())
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    fireEvent.click(screen.getByRole('button', { name: 'Change window' }))
    expect(replace).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open request' }))
    expect(push).toHaveBeenCalledTimes(1)
    expect(parseUrl(window.location.href)).toMatchObject({ page: 'requests', window: '24h', request: 'request-2' })
  })

  it('offers global filtering only with multiple targets on Monitor pages, retaining a literal all target', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/targets', () => Response.json(targetsFixture({ targets: [targetFixture(), targetFixture({ name: 'all', runtimeId: 'target-all', hostname: 'all.localhost' })] })))
    const user = userEvent.setup()
    renderDashboard({ api, children: <p>Fixture content</p> })
    const filter = await screen.findByRole('combobox', { name: 'Route target' })
    await user.selectOptions(filter, 'all')
    expect(new URL(window.location.href).searchParams.get('target')).toBe('all')
    await user.selectOptions(filter, '')
    expect(new URL(window.location.href).searchParams.has('target')).toBe(false)
    await user.click(within(screen.getByRole('navigation', { name: 'Dashboard navigation' })).getByRole('link', { name: 'Models' }))
    expect(screen.queryByRole('combobox', { name: 'Route target' })).not.toBeInTheDocument()
  })

  it('hides a single-target filter and drops a disappeared target with a transition notice', async () => {
    renderDashboard({ url: '/dashboard/overview?target=missing', children: <p>Fixture content</p> })
    await waitFor(() => expect(new URL(window.location.href).searchParams.has('target')).toBe(false))
    expect(screen.queryByRole('combobox', { name: 'Route target' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/no longer exists/i)
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('keeps an implicit legacy target on all traffic rather than a hidden named-target filter', async () => {
    const api = createFakeFetch()
    const capabilities = { canAddAccount: false, canBootstrap: false, canManageM365: false, canRefreshMetadata: false }
    api.on('GET', '/dashboard/api/targets', () => Response.json(targetsFixture({
      hostTarget: 'default',
      capabilities,
      routing: { baseHostname: 'localhost', defaultAccount: 'default', routingEnabled: false },
      targets: [targetFixture({ name: 'default', hostname: 'localhost', runtimeId: 'implicit' })],
    })))
    api.on('GET', '/dashboard/api/overview', () => Response.json(overviewFixture({ hostTarget: 'default', capabilities })))
    renderDashboard({ api, url: '/dashboard/overview?target=default', children: <p>Fixture content</p> })
    await waitFor(() => expect(new URL(window.location.href).searchParams.has('target')).toBe(false))
    expect(screen.queryByRole('combobox', { name: 'Route target' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/all traffic/i)
  })

  it('explains unavailable refresh without sending a POST', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/overview', () => Response.json(overviewFixture({ capabilities: { canAddAccount: false, canBootstrap: false, canManageM365: false, canRefreshMetadata: false, refreshUnavailableReason: 'Routing is disabled.' } })))
    renderDashboard({ api, children: <p>Fixture content</p> })
    const refresh = screen.getByRole('button', { name: 'Refresh' })
    await waitFor(() => expect(refresh).toHaveAccessibleDescription(/Routing is disabled/))
    expect(refresh).toBeDisabled()
    fireEvent.click(refresh)
    expect(api.requests.some(request => request.method === 'POST')).toBe(false)
  })

  it('exposes native menu disclosure and restores its trigger on Escape', () => {
    renderDashboard({ children: <p>Fixture content</p> })
    const trigger = screen.getByText('Menu')
    fireEvent.click(trigger)
    expect(screen.getByRole('navigation', { name: 'Mobile Dashboard navigation' })).toBeVisible()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.getByRole('navigation', { name: 'Mobile Dashboard navigation', hidden: true })).not.toBeVisible()
    expect(trigger).toHaveFocus()
  })

  it('persists explicit Light and Dark preferences and returns to the System fallback', async () => {
    const user = userEvent.setup()
    renderDashboard({ children: <p>Fixture content</p> })
    const theme = screen.getByRole('combobox', { name: 'Theme' })
    await user.selectOptions(theme, 'dark')
    expect(window.localStorage.getItem('ghc-proxy-dashboard-theme')).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    await user.selectOptions(theme, 'light')
    expect(document.documentElement.dataset.theme).toBe('light')
    await user.selectOptions(theme, 'system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(window.localStorage.getItem('ghc-proxy-dashboard-theme')).toBe('system')
  })
})
