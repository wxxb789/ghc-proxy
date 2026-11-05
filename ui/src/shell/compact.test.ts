import { render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App.svelte'
import { loadAllViews } from '../lib/poller.svelte.ts'
import { startRouter } from '../lib/router.svelte.ts'
import { app } from '../lib/store.svelte.ts'
import { createFakeFetch, jsonError } from '../test/fake-fetch.ts'
import { clearFaults, dashboardRoutes } from '../test/fixtures.ts'

// Own file: the compact-chrome media query is created once per module graph.
let compact = true
let stopRouter: () => void
const listeners = new Set<(event: Event) => void>()
const compactQuery = {
  media: '(max-width: 900px)',
  get matches() { return compact },
  addEventListener: (_type: string, listener: (event: Event) => void) => listeners.add(listener),
  removeEventListener: (_type: string, listener: (event: Event) => void) => listeners.delete(listener),
}

beforeEach(() => {
  history.replaceState(null, '', '/dashboard#/overview')
  clearFaults()
  Object.assign(app.ui, { issuesOpen: false, shortcutsOpen: false, drawerOpen: false })
  vi.stubGlobal('matchMedia', (query: string) => query === compactQuery.media
    ? compactQuery
    : { media: query, matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('fetch', createFakeFetch(dashboardRoutes({
    '/dashboard/api/models': () => jsonError(500, 'Models exploded'),
  })).fetch)
  stopRouter = startRouter(() => {})
})

afterEach(() => {
  stopRouter()
})

describe('≤900 px chrome', () => {
  it('puts the Issues button in the top bar, then back in the context bar when widened', async () => {
    compact = true
    render(App)
    await loadAllViews()
    const topbar = screen.getByRole('button', { name: 'Menu' }).parentElement!
    const context = screen.getByRole('group', { name: 'Page context' })
    // ≤560 px shows icon + count; the count is hidden from AT so the name stays the full label.
    const button = within(topbar).getByRole('button', { name: '1 issue' })
    expect(within(button).getByText('1')).toHaveAttribute('aria-hidden', 'true')
    expect(within(context).queryByRole('button', { name: '1 issue' })).not.toBeInTheDocument()
    await userEvent.setup().click(button)
    expect(within(topbar).getByRole('dialog', { name: 'Issues' })).toBeInTheDocument()

    compact = false
    for (const listener of listeners)
      listener(new Event('change'))
    flushSync()
    await waitFor(() => expect(within(context).getByRole('button', { name: '1 issue' })).toBeInTheDocument())
    expect(within(topbar).queryByRole('button', { name: '1 issue' })).not.toBeInTheDocument()
    // The open popover follows the button.
    expect(within(context).getByRole('dialog', { name: 'Issues' })).toBeInTheDocument()
  })
})
