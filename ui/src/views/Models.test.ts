import type { DashboardModel } from '@contract'
import { render, screen, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modelsTsv } from '../lib/format.ts'
import { replaceParams, router } from '../lib/router.svelte.ts'
import { app, faults } from '../lib/store.svelte.ts'
import { clearFaults, model, models, overview } from '../test/fixtures.ts'
import Models from './Models.svelte'

const CATALOG = [
  model({ id: 'gpt-5.4', name: 'GPT-5.4', vendor: 'OpenAI', effective: { ...model({ id: 'x' }).effective, defaultMessagesStrategy: 'chat-completions' } }),
  model({ id: 'claude-opus-5.5', name: 'Claude Opus 5.5', preview: true }),
  model({ id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' }),
  model({ id: 'mystery', name: '', vendor: '' }),
]

let writeText: ReturnType<typeof vi.fn>

function setCatalog(list: DashboardModel[] | null) {
  app.data.models = list && models(list)
  app.loadedAt.models = list && new Date('2026-11-05T14:00:41')
}

function renderModels(list: DashboardModel[] | null = CATALOG, hash = '#/models') {
  history.replaceState(null, '', `/dashboard${hash}`)
  router.view = 'models'
  router.params = Object.fromEntries(new URLSearchParams(hash.split('?')[1] ?? ''))
  setCatalog(list)
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
    expect(screen.getByText('1 selected')).toBeInTheDocument()
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
    await clearStatus(() => user.click(screen.getByRole('button', { name: 'Clear' })))
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
    expect(count()).toHaveTextContent('4 of 4')
    expect(document.querySelector('.view-meta')).toHaveTextContent('4 of 4 · for work · loaded 14:00:41')

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
    expect(count()).toHaveTextContent('4 of 4')
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
    screen.getByRole('button', { name: 'Clear' }).focus()
    await user.keyboard('{Enter}')
    expect(app.selection.models.length).toBe(0)
    await vi.waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Models' })).toHaveFocus())
  })

  it('renders a catalog with duplicate model ids and endpoints', () => {
    const twin = model({ id: 'gpt-5.4', name: 'GPT-5.4', vendor: 'OpenAI', upstream: { ...CATALOG[0]!.upstream, endpoints: ['/responses', '/responses'] } })
    renderModels([...CATALOG, twin])
    expect(rowIds()).toEqual(['claude-haiku-4.5', 'claude-opus-5.5', 'gpt-5.4', 'gpt-5.4', 'mystery'])
    expect(count()).toHaveTextContent('5 of 5')
  })

  it('renders multi-line limits, capabilities, compatibility and the preview tag', () => {
    renderModels()
    const cells = [...row('claude-opus-5.5').querySelectorAll('td')]
    expect(cells[1]).toHaveTextContent('claude-opus-5.5 Claude Opus 5.5 preview')
    expect(cells[3]).toHaveTextContent('native-messages')
    expect(Array.from(cells[4]!.querySelectorAll('.line'), line => line.textContent)).toEqual(['/v1/messages', '/chat/completions'])
    expect(cells[5]).toHaveTextContent('context200,000prompt168,000output64,000')
    expect(Array.from(cells[6]!.querySelectorAll('.tag-mono'), tag => tag.textContent)).toEqual(['tool_calls', 'vision', 'reasoning_effort'])
    const compat = [...cells[7]!.querySelectorAll('.line')]
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

  it('shows the empty-cache state with a Refresh metadata action that follows the rail rules', () => {
    app.accountsMode = 'legacy'
    renderModels([])
    expect(count()).toHaveTextContent('0 of 0')
    expect(screen.getByText('No models loaded for work.')).toBeInTheDocument()
    expect(screen.getByText('Models appear after the Copilot catalog loads.')).toBeInTheDocument()
    const refresh = screen.getByRole('button', { name: 'Refresh metadata' })
    expect(refresh).toHaveAttribute('aria-disabled', 'true')
    expect(refresh).toHaveAccessibleDescription('Available after named accounts are enabled')
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
