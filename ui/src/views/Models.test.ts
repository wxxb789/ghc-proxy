import type { DashboardModel, DashboardModelTarget, ModelsResponse } from '@contract'
import { render, screen, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modelsTsv } from '../lib/format.ts'
import { replaceParams, router } from '../lib/router.svelte.ts'
import { app, faults } from '../lib/store.svelte.ts'
import { createFakeFetch } from '../test/fake-fetch.ts'
import { clearFaults, dashboardRoutes, model, models, overview } from '../test/fixtures.ts'
import Models from './Models.svelte'

const CATALOG = [
  model({ id: 'gpt-5.4', name: 'GPT-5.4', vendor: 'OpenAI', effective: { ...model({ id: 'x' }).effective, defaultMessagesStrategy: 'chat-completions' } }),
  model({ id: 'claude-opus-5.5', name: 'Claude Opus 5.5', preview: true }),
  model({ id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' }),
  model({ id: 'mystery', name: '', vendor: '' }),
]

let writeText: ReturnType<typeof vi.fn>

function setCatalog(list: DashboardModel[] | null, overrides: Partial<ModelsResponse> = {}) {
  app.data.models = list && models(list, overrides)
  app.loadedAt.models = list && new Date('2026-11-05T14:00:41')
}

function renderModels(list: DashboardModel[] | null = CATALOG, hash = '#/models', overrides: Partial<ModelsResponse> = {}) {
  history.replaceState(null, '', `/dashboard${hash}`)
  router.view = 'models'
  router.params = Object.fromEntries(new URLSearchParams(hash.split('?')[1] ?? ''))
  setCatalog(list, overrides)
  return render(Models)
}

const status = () => document.getElementById('model-copy-status')!
const count = () => document.getElementById('model-count')!
const rowIds = () => screen.getAllByRole('row').filter(row => row.hasAttribute('data-row')).map(row => row.querySelector('.mono')!.textContent)
const row = (id: string) => screen.getByRole('checkbox', { name: `Select ${id}` }).closest('tr')!
const copyButton = () => screen.getByRole('button', { name: /Copy selected/ })

/** user-event installs its own clipboard stub, so the spy goes in afterwards. */
function setup() {
  const user = userEvent.setup()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return user
}

beforeEach(() => {
  app.selection.models.length = 0
  clearFaults()
  app.data.overview = overview()
  app.accountsMode = 'routing'
  writeText = vi.fn(async () => {})
  document.execCommand = vi.fn(() => false)
})

afterEach(() => {
  setCatalog(null)
  app.data.overview = null
})

describe('models view', () => {
  it('copies the selected models as the byte-identical TSV and reports the count', async () => {
    const user = setup()
    renderModels()
    expect(copyButton()).toBeDisabled()
    await user.click(row('gpt-5.4'))
    await user.click(row('claude-opus-5.5'))
    await user.click(copyButton())
    expect(writeText).toHaveBeenCalledWith(modelsTsv([CATALOG[0]!, CATALOG[1]!], location.origin))
    expect(writeText.mock.calls[0]![0]).toMatch(/^Endpoint: http:\/\/localhost:4141\/v1\nModel ID\t/)
    expect(status()).toHaveTextContent('Copied 2 models')

    await user.click(row('gpt-5.4'))
    expect(status()).toHaveTextContent('')
    await user.click(copyButton())
    expect(status()).toHaveTextContent('Copied 1 model')
    expect(status().textContent!.trim()).toBe('Copied 1 model')

    await user.click(screen.getByRole('button', { name: 'Copy ID' }))
    expect(writeText).toHaveBeenLastCalledWith('claude-opus-5.5')
    expect(status()).toHaveTextContent('Copied model ID')

    writeText.mockRejectedValue(new Error('denied'))
    await user.click(copyButton())
    expect(status()).toHaveTextContent('Copy failed')
    expect(status()).toHaveClass('is-error')
  })

  it('copies another target\'s catalog with that target\'s hostname, not the page origin', async () => {
    const targets: DashboardModelTarget[] = [
      { name: 'default', hostname: 'default.localhost', upstream: 'github', isDefault: true },
      { name: 'm365', hostname: 'm365.localhost', upstream: 'm365', isDefault: false },
    ]
    const m365Model = model({ id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5' })
    const fake = createFakeFetch(dashboardRoutes({
      '/dashboard/api/models?target=m365': () => models([m365Model], { targets, target: { name: 'm365', hostname: 'm365.localhost', upstream: 'm365', current: false } }),
    }))
    vi.stubGlobal('fetch', fake.fetch)
    const user = setup()
    renderModels(CATALOG, '#/models', { targets })
    await user.click(row('gpt-5.4'))

    const picker = screen.getByRole('combobox', { name: 'Route target' })
    expect(picker).toHaveValue('default')
    await user.selectOptions(picker, 'm365')
    // A selection belongs to one catalog: switching clears it.
    expect(copyButton()).toHaveTextContent('Copy selected (0)')
    expect(router.params.target).toBe('m365')
    expect(location.hash).toBe('#/models?target=m365')
    await vi.waitUntil(() => app.data.models?.target.name === 'm365')
    expect(fake.calls()).toContain('GET /dashboard/api/models?target=m365')
    expect(picker).toHaveValue('m365')
    expect(rowIds()).toEqual(['claude-sonnet-5.5'])

    await user.click(row('claude-sonnet-5.5'))
    await user.click(copyButton())
    expect(writeText).toHaveBeenCalledWith(modelsTsv([m365Model], 'http://m365.localhost:4141'))
    expect(writeText.mock.calls[0]![0]).toMatch(/^Endpoint: http:\/\/m365\.localhost:4141\/v1\n/)
  })

  it('hides the target picker with a single target', () => {
    renderModels()
    expect(screen.queryByRole('combobox', { name: 'Route target' })).not.toBeInTheDocument()
  })

  it('toggles on row click, Enter and Space, and the checkbox toggles exactly once', async () => {
    const user = setup()
    renderModels()
    const target = row('gpt-5.4')
    await user.click(target)
    expect(target).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('checkbox', { name: 'Select gpt-5.4' }))
    expect(target).toHaveAttribute('aria-selected', 'false')
    await user.click(screen.getByRole('checkbox', { name: 'Select gpt-5.4' }))
    expect(target).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('checkbox', { name: 'Select gpt-5.4' })).toBeChecked()

    target.focus()
    await user.keyboard('{Enter}')
    expect(target).toHaveAttribute('aria-selected', 'false')
    await user.keyboard(' ')
    expect(target).toHaveAttribute('aria-selected', 'true')
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    target.dispatchEvent(space)
    expect(space.defaultPrevented).toBe(true) // no page scroll
    // The count lives only in the copy button; the status sits first in the one-row selection bar.
    expect(copyButton()).toHaveTextContent('Copy selected (1)')
    expect(screen.queryByText(/\d selected$/)).not.toBeInTheDocument()
    expect(document.querySelector('.selection-bar')!.firstElementChild).toBe(status())
    expect(screen.getByRole('grid', { name: 'Models' })).toHaveAttribute('aria-multiselectable', 'true')
  })

  it('clears the copy status on every selection change', async () => {
    const user = setup()
    renderModels()
    const clearStatus = async (action: () => Promise<void>) => {
      await user.click(copyButton())
      expect(status()).toHaveTextContent(/Copied/)
      await action()
      expect(status().textContent!.trim()).toBe('')
    }
    await user.click(row('gpt-5.4'))
    await clearStatus(() => user.click(row('mystery')))
    await clearStatus(() => user.click(screen.getByRole('checkbox', { name: 'Select all shown models' })))
    await clearStatus(() => user.click(screen.getByRole('button', { name: 'Clear selection' })))
    expect(copyButton()).toBeDisabled()
  })

  it('groups by vendor A-Z, sorts by name in either direction and writes the URL params', async () => {
    const user = setup()
    renderModels()
    const groups = () => Array.from(document.querySelectorAll('tr.vendor-group'), group => group.textContent)
    expect(groups()).toEqual(['Anthropic · 2', 'OpenAI · 1', 'Unknown · 1'])
    expect(rowIds()).toEqual(['claude-haiku-4.5', 'claude-opus-5.5', 'gpt-5.4', 'mystery'])

    await user.selectOptions(screen.getByRole('combobox', { name: 'Order models by name' }), 'desc')
    expect(location.hash).toBe('#/models?sort=desc')
    expect(groups()).toEqual(['Anthropic · 2', 'OpenAI · 1', 'Unknown · 1'])
    expect(rowIds()).toEqual(['claude-opus-5.5', 'claude-haiku-4.5', 'gpt-5.4', 'mystery'])
    // The URL stays the source of truth after a user pick (no stale `selected` option).
    replaceParams({ sort: undefined })
    flushSync()
    expect(screen.getByRole('combobox', { name: 'Order models by name' })).toHaveValue('asc')
    replaceParams({ sort: 'desc' })
    flushSync()
    expect(screen.getByRole('combobox', { name: 'Order models by name' })).toHaveValue('desc')

    await user.click(screen.getByRole('checkbox', { name: 'Group vendor' }))
    expect(location.hash).toBe('#/models?sort=desc&group=0')
    expect(groups()).toEqual([])
    expect(rowIds()).toEqual(['mystery', 'gpt-5.4', 'claude-opus-5.5', 'claude-haiku-4.5'])

    await user.selectOptions(screen.getByRole('combobox', { name: 'Order models by name' }), 'asc')
    await user.click(screen.getByRole('checkbox', { name: 'Group vendor' }))
    expect(location.hash).toBe('#/models')
  })

  it('restores filter, grouping and sort from the URL', () => {
    renderModels(CATALOG, '#/models?q=claude&group=0&sort=desc')
    expect(screen.getByRole('searchbox', { name: 'Filter models' })).toHaveValue('claude')
    expect(screen.getByRole('checkbox', { name: 'Group vendor' })).not.toBeChecked()
    expect(screen.getByRole('combobox', { name: 'Order models by name' })).toHaveValue('desc')
    expect(rowIds()).toEqual(['claude-opus-5.5', 'claude-haiku-4.5'])
  })

  it('filters id, name, vendor and messages strategy case-insensitively and updates the count', async () => {
    const user = setup()
    renderModels()
    const filter = screen.getByRole('searchbox', { name: 'Filter models' })
    expect(count()).toHaveTextContent(/^4 models$/)
    expect(document.querySelector('.view-meta')).toHaveTextContent(/^4 models · loaded 14:00:41$/)

    await user.type(filter, 'OPUS')
    expect(rowIds()).toEqual(['claude-opus-5.5'])
    expect(count()).toHaveTextContent('1 of 4')
    expect(location.hash).toBe('#/models?q=OPUS')

    await user.clear(filter)
    await user.type(filter, 'opus 5')
    expect(rowIds()).toEqual(['claude-opus-5.5']) // name
    await user.clear(filter)
    await user.type(filter, 'openai')
    expect(rowIds()).toEqual(['gpt-5.4']) // vendor
    await user.clear(filter)
    await user.type(filter, 'CHAT-COMPLETIONS')
    expect(rowIds()).toEqual(['gpt-5.4']) // strategy
    await user.clear(filter)
    await user.type(filter, 'HAIKU-4')
    expect(rowIds()).toEqual(['claude-haiku-4.5']) // id
    expect(count()).toHaveTextContent('1 of 4')

    await user.keyboard('{Escape}')
    expect(filter).toHaveValue('')
    expect(count()).toHaveTextContent(/^4 models$/)
    expect(location.hash).toBe('#/models')
    await user.keyboard('{Escape}')
    expect(filter).not.toHaveFocus()
  })

  it('keeps the selection across filter and sort, and prunes ids the server no longer lists', async () => {
    const user = setup()
    renderModels()
    await user.click(row('gpt-5.4'))
    await user.click(row('mystery'))
    await user.type(screen.getByRole('searchbox', { name: 'Filter models' }), 'claude')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Order models by name' }), 'desc')
    expect(copyButton()).toHaveTextContent('Copy selected (2)')
    await user.clear(screen.getByRole('searchbox', { name: 'Filter models' }))
    expect(row('gpt-5.4')).toHaveAttribute('aria-selected', 'true')

    setCatalog(CATALOG.filter(entry => entry.id !== 'mystery'))
    flushSync()
    expect([...app.selection.models]).toEqual(['gpt-5.4'])
    expect(copyButton()).toHaveTextContent('Copy selected (1)')
  })

  it('selects and deselects all shown rows from the tri-state header checkbox', async () => {
    const user = setup()
    renderModels()
    const header = screen.getByRole('checkbox', { name: 'Select all shown models' }) as HTMLInputElement
    await user.type(screen.getByRole('searchbox', { name: 'Filter models' }), 'claude')
    await user.click(row('claude-opus-5.5'))
    expect(header.indeterminate).toBe(true)
    expect(header).not.toBeChecked()

    await user.click(header)
    expect(header.indeterminate).toBe(false)
    expect(header).toBeChecked()
    expect([...app.selection.models].sort()).toEqual(['claude-haiku-4.5', 'claude-opus-5.5'])

    await user.click(header)
    expect(app.selection.models.length).toBe(0)
    expect(header).not.toBeChecked()
  })

  it('puts the header checkbox in the tab order between the toolbar and the grid', async () => {
    const user = setup()
    renderModels()
    screen.getByRole('combobox', { name: 'Order models by name' }).focus()
    await user.tab()
    expect(screen.getByRole('checkbox', { name: 'Select all shown models' })).toHaveFocus()
    await user.keyboard(' ')
    expect(app.selection.models.length).toBe(CATALOG.length)
    await user.tab()
    expect(row('claude-haiku-4.5')).toHaveFocus()
  })

  it('moves focus to the view heading when Clear removes itself', async () => {
    const user = setup()
    renderModels()
    await user.click(row('gpt-5.4'))
    screen.getByRole('button', { name: 'Clear selection' }).focus()
    await user.keyboard('{Enter}')
    expect(app.selection.models.length).toBe(0)
    await vi.waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Models' })).toHaveFocus())
  })

  it('renders a catalog with duplicate model ids and endpoints', () => {
    const twin = model({ id: 'gpt-5.4', name: 'GPT-5.4', vendor: 'OpenAI', upstream: { ...CATALOG[0]!.upstream, endpoints: ['/responses', '/responses'] } })
    renderModels([...CATALOG, twin])
    expect(rowIds()).toEqual(['claude-haiku-4.5', 'claude-opus-5.5', 'gpt-5.4', 'gpt-5.4', 'mystery'])
    expect(count()).toHaveTextContent(/^5 models$/)
  })

  it('renders multi-line limits, capabilities, compatibility and the preview tag', () => {
    renderModels()
    expect(Array.from(document.querySelectorAll('thead th'), header => header.textContent).slice(1))
      .toEqual(['Model', 'Messages route', 'Upstream endpoints', 'Limits', 'Capabilities', 'Proxy compatibility'])
    const cells = [...row('claude-opus-5.5').querySelectorAll('td')]
    expect(cells[1]).toHaveTextContent(/^claude-opus-5\.5 Claude Opus 5\.5 preview · 2026-09-01$/)
    expect(cells[2]).toHaveTextContent('native-messages')
    expect(Array.from(cells[3]!.querySelectorAll('.line'), line => line.textContent)).toEqual(['/v1/messages', '/chat/completions'])
    expect(cells[4]).toHaveTextContent('context200,000prompt168,000output64,000')
    expect(Array.from(cells[5]!.querySelectorAll('.tag-mono'), tag => tag.textContent)).toEqual(['tool_calls', 'vision', 'reasoning_effort'])
    // Card captions (≤560) stay only on the route, the endpoints and the compatibility lines.
    expect(cells.map(cell => cell.dataset.label))
      .toEqual([undefined, undefined, 'Messages route', 'Upstream endpoints', undefined, undefined, 'Proxy compatibility'])
    const compat = [...cells[6]!.querySelectorAll('.line')]
    expect(compat.map(line => line.textContent)).toEqual([
      'responses native',
      'structured yes',
      'output_config yes',
      'chat tokens max_tokens',
      'filters none',
      'context managed',
    ])
    expect(compat.filter(line => line.classList.contains('muted')).map(line => line.textContent)).toEqual(['filters none'])
  })

  it('names the vendor on line 2 only when ungrouped and skips a name that repeats the id', async () => {
    const user = setup()
    renderModels([
      ...CATALOG,
      model({ id: 'o4-mini', vendor: 'OpenAI', preview: true }),
      model({ id: 'bare', version: '' }),
    ])
    const sub = (id: string) => row(id).querySelector('.model .sub')
    expect(document.querySelector('tr.vendor-group > th')).toHaveAttribute('colspan', '7')
    expect(sub('claude-haiku-4.5')).toHaveTextContent(/^Claude Haiku 4\.5 · 2026-09-01$/)
    expect(sub('gpt-5.4')).toHaveTextContent(/^2026-09-01$/) // "GPT-5.4" repeats the id
    expect(sub('o4-mini')).toHaveTextContent(/^preview · 2026-09-01$/)
    expect(sub('mystery')).toHaveTextContent(/^2026-09-01$/)
    expect(sub('bare')).toBeNull()

    await user.click(screen.getByRole('checkbox', { name: 'Group vendor' }))
    expect(sub('claude-haiku-4.5')).toHaveTextContent(/^Claude Haiku 4\.5 · Anthropic · 2026-09-01$/)
    expect(sub('gpt-5.4')).toHaveTextContent(/^OpenAI · 2026-09-01$/)
    expect(sub('mystery')).toHaveTextContent(/^2026-09-01$/)
    expect(sub('bare')).toHaveTextContent(/^Anthropic$/)
  })

  it('counts the catalog plural-aware and shows "N of M" only while a filter is active', () => {
    const { unmount } = renderModels([CATALOG[0]!])
    expect(count()).toHaveTextContent(/^1 model$/)
    unmount()
    renderModels(CATALOG, '#/models?q=%20%20')
    expect(count()).toHaveTextContent(/^4 models$/)
  })

  it('shows the empty-cache state with a Refresh metadata action that follows the rail rules', () => {
    app.accountsMode = 'legacy'
    const { unmount } = renderModels([])
    expect(count()).toHaveTextContent(/^0 models$/)
    expect(screen.getByText('No models loaded.')).toBeInTheDocument()
    expect(screen.getByText('Models appear after the Copilot catalog loads.')).toBeInTheDocument()
    const refresh = screen.getByRole('button', { name: 'Refresh metadata' })
    expect(refresh).toHaveAttribute('aria-disabled', 'true')
    expect(refresh).toHaveAccessibleDescription('Needs named accounts')
    unmount()

    // With a usable Refresh metadata the title and the action say it all.
    app.accountsMode = 'routing'
    renderModels([])
    expect(screen.getByText('No models loaded.')).toBeInTheDocument()
    expect(screen.queryByText('Models appear after the Copilot catalog loads.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh metadata' })).not.toHaveAttribute('aria-disabled')
    expect(screen.getByRole('checkbox', { name: 'Select all shown models' })).toBeDisabled()
  })

  it('fades the right edge while the catalog can scroll further sideways', () => {
    renderModels()
    const scroller = document.querySelector<HTMLElement>('.table-scroll')!
    const frame = scroller.parentElement!
    expect(frame).not.toHaveClass('more-right')
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 1200 })
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 900 })
    Object.defineProperty(scroller, 'scrollLeft', { configurable: true, writable: true, value: 0 })
    window.dispatchEvent(new Event('resize'))
    flushSync()
    expect(frame).toHaveClass('more-right')
    scroller.scrollLeft = 300
    scroller.dispatchEvent(new Event('scroll'))
    flushSync()
    expect(frame).not.toHaveClass('more-right')
  })

  it('shows the no-match state and clears the filter from it', async () => {
    const user = setup()
    renderModels()
    await user.type(screen.getByRole('searchbox', { name: 'Filter models' }), 'nothing ')
    expect(screen.getByText('No models match "nothing".')).toBeInTheDocument()
    expect(count()).toHaveTextContent('0 of 4')
    expect(screen.getByRole('checkbox', { name: 'Select all shown models' })).toBeDisabled()
    await user.click(within(document.querySelector('.empty')!).getByRole('button', { name: 'Clear filter' }))
    expect(rowIds()).toHaveLength(4)
    expect(screen.getByRole('searchbox', { name: 'Filter models' })).toHaveFocus()
  })

  it('shows skeleton rows before the first load and only the strip when that load failed', () => {
    const { unmount } = renderModels(null)
    expect(screen.getByRole('grid', { name: 'Models' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('Loading models…')).toBeInTheDocument()
    unmount()

    faults.models = { scope: 'models', message: 'Models exploded', since: new Date(), count: 1 }
    renderModels(null)
    expect(screen.getByText(/Couldn't load Models: Models exploded/)).toBeInTheDocument()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })
})
