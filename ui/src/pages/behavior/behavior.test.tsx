import { act, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { behaviorFixture, createFakeFetch } from '../../test/fixtures'
import { renderDashboard } from '../../test/render'
import { BehaviorPage } from './index'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('behavior configuration', () => {
  it('distinguishes selected-window effects from cumulative counts and keeps configuration host-scoped', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/behavior', () => Response.json(behaviorFixture({ hostTarget: 'host-work', window: '15m', effects: [
      { id: 'rewrite', category: 'routing', label: 'Model rewritten', count: 15, windowCount: 3 },
      { id: 'filtered', category: 'parameters', label: 'Parameter filtered', count: 5, windowCount: 0 },
    ] })))
    renderDashboard({ api, url: '/dashboard/behavior?window=15m&target=other', children: <BehaviorPage /> })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('Host target: host-work')).toBeVisible()
    const effects = screen.getByRole('table', { name: 'Observed behavior effects' })
    expect(within(effects).getByRole('columnheader', { name: 'Last 15m' })).toBeVisible()
    expect(within(effects).getByRole('columnheader', { name: 'Since process start' })).toBeVisible()
    const rewrite = within(effects).getByRole('row', { name: /Model rewritten/ })
    expect(within(rewrite).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['Model rewritten', 'routing', '3', '15'])
    const filtered = within(effects).getByRole('row', { name: /Parameter filtered/ })
    expect(within(filtered).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['Parameter filtered', 'parameters', '0', '5'])
    const request = api.requests.find(request => request.url.pathname.endsWith('/behavior'))!
    expect(request.url.searchParams.get('window')).toBe('15m')
    expect(request.url.searchParams.has('target')).toBe(false)
  })

  it('renders routing, fallback, strategy, parameter, context and tool compatibility as structured information', async () => {
    const api = createFakeFetch()
    const base = behaviorFixture()
    api.on('GET', '/dashboard/api/behavior', () => Response.json(behaviorFixture({
      modelRouting: { ...base.modelRouting, rewrites: [{ from: 'old-model', to: 'new-model' }], compact: { enabled: true, smallModel: 'small-model' }, overloadFallbacks: { busy: 'backup' } },
      parameterHandling: { responsesFiltersReplaceDefault: true, responsesFilters: [{ models: ['reasoner'], params: ['temperature', 'top_p'] }], responsesOutputTokenFloor: 128, chatMaxCompletionTokenModels: ['reasoner'] },
      contextManagement: { enabled: true, models: ['reasoner'], autoCompactInput: true, defaultCompactThreshold: 0.75 },
      toolCompatibility: { ...base.toolCompatibility, functionApplyPatch: false },
    })))
    renderDashboard({ api, url: '/dashboard/behavior', children: <BehaviorPage /> })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByRole('table', { name: 'Model rewrite rules' })).toHaveTextContent('old-modelnew-model')
    expect(screen.getByRole('table', { name: 'Overload fallbacks' })).toHaveTextContent('busybackup')
    expect(screen.getByRole('region', { name: 'Model routing' })).toHaveTextContent('small-model')
    expect(screen.getByRole('region', { name: 'Execution strategies' })).toHaveTextContent('chat-completions')
    expect(screen.getByRole('region', { name: 'Parameter handling' })).toHaveTextContent('Replace defaults')
    expect(screen.getByRole('table', { name: 'Responses parameter filters' })).toHaveTextContent('reasonertemperature, top_p')
    expect(screen.getByRole('region', { name: 'Context management' })).toHaveTextContent('75%')
    const tools = screen.getByRole('region', { name: 'Tool compatibility' })
    expect(within(tools).getByText('Function apply_patch').nextElementSibling).toHaveTextContent('Disabled')
  })
})
