import type { FakeFetch } from '../test/fake-fetch.ts'
import { render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App.svelte'
import { confirm } from '../lib/confirm.svelte.ts'
import { loadAllViews } from '../lib/poller.svelte.ts'
import { startRouter } from '../lib/router.svelte.ts'
import { app } from '../lib/store.svelte.ts'
import { createFakeFetch, jsonError } from '../test/fake-fetch.ts'
import { account, accountsLegacy, accountsRouting, clearFaults, dashboardRoutes, models } from '../test/fixtures.ts'

let fake: FakeFetch
let stopRouter: () => void
let accountsLegacyMode = false
let accountsAttention = false
let modelsFail = false

beforeEach(() => {
  history.replaceState(null, '', '/dashboard#/overview')
  accountsLegacyMode = false
  accountsAttention = false
  modelsFail = false
  clearFaults()
  Object.assign(app.ui, { issuesOpen: false, shortcutsOpen: false, drawerOpen: false })
  app.prefs.shortcuts = true
  app.live = true
  fake = createFakeFetch(dashboardRoutes({
    '/dashboard/api/accounts': () => accountsLegacyMode
      ? accountsLegacy()
      : accountsRouting(accountsAttention ? { accounts: [account({ name: 'work' }), account({ name: 'personal', copilot: { status: 'missing', modelsLoaded: false } })] } : {}),
    '/dashboard/api/models': () => modelsFail ? jsonError(500, 'Models exploded') : models(),
  }))
  vi.stubGlobal('fetch', fake.fetch)
  stopRouter = startRouter(() => {})
})

afterEach(() => {
  stopRouter()
})

async function renderLoaded() {
  const result = render(App)
  await loadAllViews()
  return result
}

describe('app shell', () => {
  it('renders the chrome: skip link, nav, status, context and a quiet Issues button', async () => {
    await renderLoaded()
    expect(screen.getByRole('link', { name: 'Skip to content' })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Dashboard views' })
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('v0.11.4')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'System status' })).toBeInTheDocument()
    const status = screen.getByRole('region', { name: 'System status' })
    // Upstream names the provider only; the Copilot row carries the verdict.
    expect(within(status).getByText('Upstream').closest('.status-row')).toHaveTextContent(/^Upstream\s*GitHub$/)
    expect(within(status).getByText('81.2 %')).toBeInTheDocument()
    const context = screen.getByRole('group', { name: 'Page context' })
    expect(context).toHaveTextContent('Viewing work · not default')
    expect(context).not.toHaveTextContent(location.host)
    expect(within(context).getByText('work')).toHaveAttribute('title', location.host)
    expect(within(context).getByText(/^Updated /)).not.toHaveTextContent(' ms')
    expect(within(context).getByText(/^Updated /)).toHaveAttribute('title', `${app.connection.rttMs} ms`)
    for (const toggle of screen.getAllByRole('button', { name: 'Live' }))
      expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'No issues' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toHaveAttribute('id', 'view-h1')
  })

  it('shows a scope fault as a strip on its view and in the Issues popover', async () => {
    modelsFail = true
    await renderLoaded()
    location.hash = '#/models'
    expect(await screen.findByText(/Couldn't load Models: Models exploded/)).toBeInTheDocument()
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: '1 issue' })
    await user.click(button)
    const popover = screen.getByRole('dialog', { name: 'Issues' })
    expect(within(popover).getByText('Couldn\'t load Models')).toBeInTheDocument()
    await waitFor(() => expect(within(popover).getByRole('button', { name: 'Retry' })).toHaveFocus())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Issues' })).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })

  it('returns focus to the Issues button after a button action and an outside click', async () => {
    modelsFail = true
    await renderLoaded()
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: '1 issue' })
    await user.click(button)
    const retry = within(screen.getByRole('dialog', { name: 'Issues' })).getByRole('button', { name: 'Retry' })
    await waitFor(() => expect(retry).toHaveFocus())
    await user.click(retry)
    expect(screen.queryByRole('dialog', { name: 'Issues' })).not.toBeInTheDocument()
    expect(button).toHaveFocus()

    await user.click(button)
    await user.click(screen.getByRole('heading', { level: 1 }).parentElement!)
    expect(screen.queryByRole('dialog', { name: 'Issues' })).not.toBeInTheDocument()
    await waitFor(() => expect(button).toHaveFocus())
  })

  it('focuses an empty popover so Esc closes it back to the button', async () => {
    await renderLoaded()
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: 'No issues' })
    await user.click(button)
    const popover = screen.getByRole('dialog', { name: 'Issues' })
    await waitFor(() => expect(popover).toHaveFocus())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Issues' })).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })

  it('a link action to the current view still lands focus on its heading', async () => {
    accountsAttention = true
    location.hash = '#/accounts'
    await renderLoaded()
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Accounts'))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '1 issue' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Issues' })).getByRole('link', { name: 'Open Accounts' }))
    expect(screen.queryByRole('dialog', { name: 'Issues' })).not.toBeInTheDocument()
    expect(location.hash).toBe('#/accounts')
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus())
  })

  it('shows paused, not a retrying lost connection, once Live is off', async () => {
    await renderLoaded()
    Object.assign(app.connection, { state: 'lost', lostSince: new Date(Date.now() - 5000) })
    app.live = false
    const status = screen.getByRole('region', { name: 'System status' })
    await waitFor(() => expect(within(status).getByText('paused')).toBeInTheDocument())
    expect(screen.getByText(/Can't reach ghc-proxy — Live is paused/)).toBeInTheDocument()
    app.live = true
    await waitFor(() => expect(within(status).getByText(/^lost /)).toBeInTheDocument())
    expect(screen.getByText('Can\'t reach ghc-proxy — retrying every 2 s')).toBeInTheDocument()
    // The context bar keeps the last update time; its RTT title would be stale.
    expect(screen.getByText(/^Updated /)).not.toHaveAttribute('title')
    Object.assign(app.connection, { state: 'connected', lostSince: null })
  })

  it('retries the overview from the lost-connection strip', async () => {
    await renderLoaded()
    Object.assign(app.connection, { state: 'lost', lostSince: new Date() })
    const strip = await screen.findByText(/Can't reach ghc-proxy —/)
    fake.clear()
    await userEvent.setup().click(within(strip.parentElement!).getByRole('button', { name: 'Retry now' }))
    await waitFor(() => expect(fake.count('GET', '/dashboard/api/overview')).toBe(1))
    await waitFor(() => expect(screen.queryByText(/Can't reach ghc-proxy —/)).not.toBeInTheDocument())
    expect(app.connection.state).toBe('connected')
  })

  it('names the blocked state Access denied in the strip, with no retry', async () => {
    await renderLoaded()
    Object.assign(app.connection, { state: 'blocked', blockedStatus: 421, blockedMessage: 'Misdirected request.' })
    const strip = await screen.findByText(/^Access denied — Misdirected request\./)
    expect(within(strip).getByRole('link', { name: 'Open on localhost' })).toBeInTheDocument()
    expect(within(strip.parentElement!).queryByRole('button', { name: 'Retry now' })).not.toBeInTheDocument()
    Object.assign(app.connection, { state: 'connected', blockedStatus: 0, blockedMessage: '' })
  })

  it('keeps Refresh metadata focusable with a visible reason in legacy mode and sends nothing', async () => {
    accountsLegacyMode = true
    await renderLoaded()
    const refresh = screen.getByRole('button', { name: /Refresh metadata/ })
    expect(refresh).toHaveAttribute('aria-disabled', 'true')
    expect(refresh).toHaveAccessibleDescription('Needs named accounts')
    expect(screen.getByText('Needs named accounts')).toBeVisible()
    fake.clear()
    await userEvent.setup().click(refresh)
    expect(fake.log).toHaveLength(0)
  })

  it('navigates with single-key shortcuts until they are switched off', async () => {
    await renderLoaded()
    const user = userEvent.setup()
    const nav = screen.getByRole('navigation', { name: 'Dashboard views' })
    // The digit is a hidden hint: the link is named by its label and advertises the key.
    expect(within(nav).getByRole('link', { name: 'Models' })).toHaveAttribute('aria-keyshortcuts', '4')
    await user.keyboard('4')
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Models'))
    await user.keyboard('?')
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(within(dialog).getByText('Always on')).toBeInTheDocument()
    expect(within(dialog).queryByText(/Turns the single-character keys off/)).not.toBeInTheDocument()
    const toggle = within(dialog).getByRole('checkbox', { name: 'Single-key shortcuts' })
    await user.click(toggle)
    expect(localStorage.getItem('ghc-proxy-dashboard-shortcuts')).toBe('off')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.keyboard('2')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Models')
    expect(screen.queryByText('2', { selector: 'kbd' })).not.toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Requests' })).not.toHaveAttribute('aria-keyshortcuts')
    localStorage.clear()
  })

  it('closes the Issues popover and the drawer when a shortcut or Back changes the view', async () => {
    modelsFail = true
    await renderLoaded()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '1 issue' }))
    expect(screen.getByRole('dialog', { name: 'Issues' })).toBeInTheDocument()
    await user.keyboard('4')
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus())
    expect(screen.queryByRole('dialog', { name: 'Issues' })).not.toBeInTheDocument()
    app.ui.drawerOpen = true
    location.hash = '#/overview'
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Overview'))
    expect(app.ui.drawerOpen).toBe(false)
  })

  it('toggles Live with the l shortcut and announces it', async () => {
    await renderLoaded()
    await userEvent.setup().keyboard('l')
    expect(app.live).toBe(false)
    // Rail and compact top-bar toggles are both named by their visible word.
    const toggles = screen.getAllByRole('button', { name: 'Paused' })
    expect(toggles).toHaveLength(2)
    for (const toggle of toggles)
      expect(toggle).toHaveAttribute('aria-pressed', 'false')
    app.live = true
  })
})

describe('confirm service', () => {
  it('opens with Cancel focused, resolves false on Cancel and true on confirm, and restores focus', async () => {
    await renderLoaded()
    const user = userEvent.setup()
    const invoker = screen.getByRole('button', { name: 'No issues' })
    invoker.focus()
    const cancelled = confirm({ title: 'Remove work', body: 'Remove work from ghc-proxy?', confirmLabel: 'Remove' })
    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(cancel).toHaveFocus())
    await user.click(cancel)
    expect(await cancelled).toBe(false)
    expect(invoker).toHaveFocus()

    const confirmed = confirm({ title: 'Remove work', body: 'Remove work from ghc-proxy?', confirmLabel: 'Remove' })
    await user.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(await confirmed).toBe(true)
  })
})
