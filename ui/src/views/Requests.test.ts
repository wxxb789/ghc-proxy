import type { RequestsResponse } from '@contract'
import { render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRouter } from '../lib/router.svelte.ts'
import { app } from '../lib/store.svelte.ts'
import { behavior, clearFaults, request, requests } from '../test/fixtures.ts'
import Requests from './Requests.svelte'

let stopRouter: () => void

function open(hash = '#/requests') {
  history.replaceState(null, '', `/dashboard${hash}`)
  stopRouter = startRouter(() => {})
}

function load(overrides: Partial<RequestsResponse>) {
  app.data.requests = requests(overrides)
  app.loadedAt.requests = new Date()
  flushSync()
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-row]')]
const rowIds = () => rows().map(row => row.dataset.id)
const selectedId = () => document.querySelector<HTMLElement>('[data-row][aria-selected=true]')?.dataset.id
const rawJson = () => document.getElementById('request-detail')?.textContent ?? ''

beforeEach(() => {
  clearFaults()
  app.data.requests = null
  app.data.behavior = null
  app.loadedAt.requests = null
  app.selection.requestId = null
  app.live = true
  app.ui.rawJsonOpen = true
  app.ui.insightsOpen = true
})

afterEach(() => stopRouter())

describe('requests selection (legacy pins)', () => {
  it('falls back to the first visible row when the selected request disappears (T:133-143)', async () => {
    open()
    render(Requests)
    load({ active: [request('a1', { state: 'in_flight', status: undefined })], recent: [request('r1'), request('r2')] })
    await userEvent.setup().click(rows()[2]!)
    expect(selectedId()).toBe('r2')

    const replaceState = vi.spyOn(history, 'replaceState')
    load({ active: [request('a2', { state: 'streaming', status: undefined })], recent: [request('r1')] })

    expect(selectedId()).toBe('a2')
    expect(rawJson()).toBe(JSON.stringify(request('a2', { state: 'streaming', status: undefined }), null, 2))
    expect(document.getElementById('request-count')).toHaveTextContent(/^1 active \/ 1 finished$/)
    expect(replaceState).toHaveBeenCalledWith(null, '', '#/requests?id=a2')
    expect(location.hash).toBe('#/requests?id=a2')
  })

  it('clears the selection on an empty ring (T:252-260)', () => {
    open('#/requests?id=r1')
    render(Requests)
    load({ recent: [request('r1')] })
    expect(app.selection.requestId).toBe('r1')

    load({ active: [], recent: [] })
    expect(app.selection.requestId).toBeNull()
    const detail = screen.getByRole('complementary', { name: 'Request detail' })
    expect(within(detail).getByText('No request selected')).toBeInTheDocument()
    expect(screen.getByText('No requests yet.')).toBeInTheDocument()
    expect(screen.getByText(/^Point a client at /)).toHaveTextContent(/Requests appear here while Live is on\.$/)
    expect(location.hash).toBe('#/requests')
  })
})

describe('requests view', () => {
  it('reads the capacity from the API', () => {
    open()
    render(Requests)
    load({ capacity: 256 })
    expect(screen.getByText(/256 finished max/)).toBeInTheDocument()
    load({ capacity: 100 })
    expect(screen.getByText(/· 100 finished max/)).toBeInTheDocument()
  })

  it('honours a deep-link id and corrects a missing one', () => {
    open('#/requests?id=r2')
    const view = render(Requests)
    load({ recent: [request('r1'), request('r2')] })
    expect(selectedId()).toBe('r2')
    view.unmount()
    stopRouter()

    open('#/requests?id=gone')
    render(Requests)
    load({ recent: [request('r1'), request('r2')] })
    expect(selectedId()).toBe('r1')
    expect(location.hash).toBe('#/requests?id=r1')
  })

  it('filters Errors as failed or status >= 400, with counts', async () => {
    open()
    render(Requests)
    load({
      active: [request('a1', { state: 'in_flight', status: undefined }), request('a2', { state: 'aborted', status: undefined })],
      recent: [request('ok'), request('client', { status: 404 }), request('failed', { state: 'failed', status: undefined }), request('server', { state: 'failed', status: 502 })],
    })
    const errors = screen.getByRole('radio', { name: /^Errors\s?3$/ })
    expect(screen.getByRole('radio', { name: /^All\s?6$/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /^Active\s?2$/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^Aborted\s?1$/ })).toBeInTheDocument()

    await userEvent.setup().click(errors)
    expect(rowIds()).toEqual(['client', 'failed', 'server'])
    expect(location.hash).toContain('state=errors')
    expect(selectedId()).toBe('client')
  })

  it('searches the listed fields and clears with Escape or Clear filter', async () => {
    open()
    render(Requests)
    load({
      active: [request('a1', { state: 'streaming', status: undefined, accountName: 'personal', effectiveModel: 'gpt-5.4' })],
      recent: [
        request('r1', { accountName: 'work', selectedStrategy: 'native-messages', requestedModel: 'claude-opus' }),
        request('r2', { accountName: 'work', status: 502, state: 'failed', errorSummary: 'Upstream HTTP 5xx', endpoint: '/v1/responses', method: 'GET' }),
      ],
    })
    const user = userEvent.setup()
    const search = screen.getByRole('searchbox', { name: 'Filter requests' })
    const expectMatches = async (text: string, ids: string[]) => {
      await user.clear(search)
      // One input event per query: this test covers the searched fields, not per-key typing.
      await user.paste(text)
      expect(rowIds()).toEqual(ids)
    }
    await expectMatches('PERSONAL', ['a1'])
    await expectMatches('gpt-5', ['a1'])
    await expectMatches('opus', ['r1'])
    await expectMatches('native', ['r1'])
    await expectMatches('upstream http', ['r2'])
    await expectMatches('502', ['r2'])
    await expectMatches('/v1/resp', ['r2'])
    await expectMatches('get', ['r2'])
    // A missing status is not the text `undefined`.
    await expectMatches('undefined', [])
    await expectMatches('r1', ['r1'])
    expect(location.hash).toContain('q=r1')

    await user.keyboard('{Escape}')
    expect(rowIds()).toEqual(['a1', 'r1', 'r2'])
    expect(location.hash).not.toContain('q=')
    expect(screen.queryByRole('button', { name: 'Clear filter' })).not.toBeInTheDocument()

    await user.type(search, 'opus')
    await user.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect(rowIds()).toEqual(['a1', 'r1', 'r2'])
    expect(search).toHaveValue('')
    expect(search).toHaveFocus()

    await user.click(screen.getByRole('radio', { name: /^Failed/ }))
    await user.type(search, 'nothing-matches')
    expect(screen.getByText('No requests match this filter.')).toBeInTheDocument()
    await user.click(within(screen.getByRole('grid')).getByRole('button', { name: 'Clear filter' }))
    expect(rowIds()).toEqual(['a1', 'r1', 'r2'])
    expect(location.hash).toBe('#/requests?id=a1')
  })

  it('shows the Account column only for two or more named accounts', () => {
    open()
    render(Requests)
    load({ recent: [request('r1', { accountName: 'work' }), request('r2')] })
    expect(screen.queryByRole('columnheader', { name: 'Account' })).not.toBeInTheDocument()
    load({ recent: [request('r1', { accountName: 'work' }), request('r2', { accountName: 'personal' })] })
    expect(screen.getByRole('columnheader', { name: 'Account' })).toBeInTheDocument()
  })

  it('counts only unseen requests in the new-rows pill while scrolled', async () => {
    open()
    render(Requests)
    load({ active: [request('a1', { state: 'in_flight', status: undefined }), request('a2', { state: 'in_flight', status: undefined })], recent: [request('r1', { state: 'failed' }), request('r2')] })
    const scroller = document.querySelector<HTMLElement>('.req-scroll')!
    Object.defineProperty(scroller, 'scrollTop', { value: 100, writable: true, configurable: true })
    const pill = () => screen.queryByRole('button', { name: /new request/ })

    // a1 finishes: it moves, but nothing arrived.
    load({ active: [request('a2', { state: 'in_flight', status: undefined })], recent: [request('a1'), request('r1', { state: 'failed' }), request('r2')] })
    expect(pill()).not.toBeInTheDocument()

    // A filter change reveals known rows only.
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: /^Failed/ }))
    await user.click(screen.getByRole('radio', { name: /^All/ }))
    expect(pill()).not.toBeInTheDocument()

    // Under a filter whose previous top row left, a new matching row still counts.
    await user.click(screen.getByRole('radio', { name: /^Failed/ }))
    load({ recent: [request('f1', { state: 'failed' }), request('a1'), request('r2')] })
    expect(pill()).toHaveTextContent('↑ 1 new request')
    load({ active: [request('n1', { state: 'in_flight', status: undefined })], recent: [request('f2', { state: 'failed' }), request('f1', { state: 'failed' }), request('a1'), request('r2')] })
    expect(pill()).toHaveTextContent('↑ 2 new requests')

    await user.click(pill()!)
    expect(scroller.scrollTop).toBe(0)
    expect(pill()).not.toBeInTheDocument()
  })

  it('moves the selection with the arrow keys and Enter focuses the detail', async () => {
    open()
    render(Requests)
    load({ recent: [request('r1'), request('r2'), request('r3')] })
    const user = userEvent.setup()
    await waitFor(() => expect(rows()[0]).toHaveAttribute('tabindex', '0'))
    rows()[0]!.focus()
    await user.keyboard('{ArrowDown}')
    expect(selectedId()).toBe('r2')
    expect(rows()[1]).toHaveFocus()
    expect(rawJson()).toContain('"requestId": "r2"')
    await user.keyboard('{End}')
    expect(selectedId()).toBe('r3')
    await user.keyboard('{ArrowUp}')
    expect(selectedId()).toBe('r2')
    expect(location.hash).toBe('#/requests?id=r2')

    await user.keyboard('{Enter}')
    expect(screen.getByRole('heading', { name: 'Request detail' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(rows()[1]).toHaveFocus()
  })

  it('orders the detail with errorSummary first and resolves effect labels', () => {
    open()
    app.data.behavior = behavior()
    render(Requests)
    load({
      recent: [request('r1', {
        state: 'failed',
        status: 502,
        errorSummary: 'Upstream HTTP 5xx',
        requestedModel: 'claude-opus',
        effectiveModel: 'claude-opus-5.5',
        modelTransforms: [{ tag: 'AUTO_CORRECT', from: 'claude-opus', to: 'claude-opus-5.5' }],
        effects: [{ id: 'recovery.retry', count: 2 }, { id: 'other.effect', count: 1 }],
      })],
    })
    const detail = screen.getByRole('complementary', { name: 'Request detail' })
    const callout = within(detail).getByText('Upstream HTTP 5xx')
    const id = within(detail).getByLabelText('request ID')
    expect(callout.compareDocumentPosition(id) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(detail).toHaveTextContent('claude-opus → AUTO_CORRECT → claude-opus-5.5')
    expect(within(detail).getByText('Recovery · Retry')).toBeInTheDocument()
    expect(within(detail).getByText('other.effect')).toBeInTheDocument()
    expect(within(detail).getByText('×2')).toBeInTheDocument()
  })

  it('ticks running rows on the clock and freezes them with Live off', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    try {
      open()
      render(Requests)
      load({ active: [request('a1', { state: 'streaming', status: undefined, durationMs: 1000 })], recent: [request('r1', { durationMs: 1000 })] })
      const duration = () => rows()[0]!.lastElementChild!.textContent
      expect(duration()).toBe('1.0 s')
      vi.advanceTimersByTime(3000)
      flushSync()
      expect(duration()).toBe('4.0 s')
      expect(rows()[1]!.lastElementChild).toHaveTextContent('1.0 s')

      app.live = false
      flushSync()
      vi.advanceTimersByTime(3000)
      flushSync()
      expect(duration()).toBe('4.0 s · paused')
      expect(screen.getByText(/finished max · paused/)).toBeInTheDocument()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('shows loading skeletons and insights over the shown rows', () => {
    open()
    render(Requests)
    const grid = screen.getByRole('grid', { name: 'Requests' })
    expect(grid).toHaveAttribute('aria-busy', 'true')
    expect(grid.querySelectorAll('tbody tr')).toHaveLength(8)
    expect(screen.getByText('Loading Requests…')).toBeInTheDocument()

    load({ recent: [request('r1', { durationMs: 100 }), request('r2', { status: 404, durationMs: 200 })] })
    const insights = screen.getByText('Insights').closest('details')!
    expect(insights.querySelector('summary')).toHaveTextContent(/^Insights · last 2 finished · spanning \S/)
    expect(insights).toHaveTextContent('needs 5 completed requests')
    expect(insights).toHaveTextContent('2xx 1 · 4xx 1 · 5xx 0 · aborted 0 · error rate 50.0 %')
  })
})
