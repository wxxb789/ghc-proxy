import type { BehaviorEffect, BehaviorResponse } from '@contract'
import { render, screen, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshSelectedView } from '../lib/poller.svelte.ts'
import { app, effectsBaseline } from '../lib/store.svelte.ts'
import { createFakeFetch, jsonError } from '../test/fake-fetch.ts'
import { behavior, clearFaults } from '../test/fixtures.ts'
import Behavior from './Behavior.svelte'

let payload: BehaviorResponse | Response

beforeEach(() => {
  clearFaults()
  effectsBaseline.map = null
  app.data.behavior = null
  app.loadedAt.behavior = null
  app.ui.behaviorRaw = { routing: false, params: false }
  app.ui.hideZeroEffects = false
  payload = behavior()
  vi.stubGlobal('fetch', createFakeFetch({ '/dashboard/api/behavior': () => payload }).fetch)
})

const effect = (id: string, category: string, label: string, count: number): BehaviorEffect => ({ id, category, label, count })

function configured(overrides: Partial<BehaviorResponse> = {}): BehaviorResponse {
  const base = behavior()
  return behavior({
    modelRouting: {
      ...base.modelRouting,
      rewrites: [{ from: 'gpt-4o', to: 'gpt-5.4' }],
      compact: { enabled: true, smallModel: 'gpt-5.4-mini' },
      overloadFallbacks: { 'claude-opus-5.5': 'claude-sonnet-5' },
    },
    strategies: { messages: ['native-messages', 'responses-api', 'chat-completions'], responses: ['responses-passthrough'], chatCompletions: ['chat-completions'] },
    parameterHandling: {
      responsesFiltersReplaceDefault: true,
      responsesFilters: [{ models: ['claude-*'], params: ['temperature', 'top_p'] }],
      responsesOutputTokenFloor: 1024,
      chatMaxCompletionTokenModels: ['gpt-5', 'o3'],
    },
    contextManagement: { enabled: true, models: ['gpt-5', 'o3', 'o4'], autoCompactInput: true, defaultCompactThreshold: 0.8 },
    ...overrides,
  })
}

async function load(next: BehaviorResponse | Response = payload) {
  payload = next
  await refreshSelectedView('behavior')
}

const row = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement
const panel = (name: string) => screen.getByRole('region', { name })
const bodyRows = () => within(panel('Effects since startup')).getAllByRole('row').slice(1)

describe('behavior view', () => {
  it('shows skeletons before the first load', () => {
    render(Behavior)
    expect(screen.getByRole('heading', { level: 1, name: 'Behavior' })).toBeInTheDocument()
    expect(screen.getByText('Current process configuration')).toBeInTheDocument()
    expect(screen.getAllByText('Loading Behavior…')).toHaveLength(3)
    expect(bodyRows()).toHaveLength(8)
  })

  it('renders structured routing and parameter values, including the new rows', async () => {
    await load(configured())
    render(Behavior)
    expect(row('Rewrites')).toHaveTextContent('gpt-4o → gpt-5.4')
    expect(row('Compact routing')).toHaveTextContent('enabled · gpt-5.4-mini')
    expect(row('Family fallbacks')).toHaveTextContent('opus → claude-opus-5.5sonnet → claude-sonnet-5haiku → claude-haiku-4.5')
    expect(row('Overload fallbacks')).toHaveTextContent('claude-opus-5.5 → claude-sonnet-5')
    expect(row('Messages strategies')).toHaveTextContent('native-messages→ then responses-api→ then chat-completions')
    expect(row('Responses strategies')).toHaveTextContent('responses-passthrough')
    expect(row('Chat Completions strategies')).toHaveTextContent('chat-completions')
    expect(row('Native Responses filters')).toHaveTextContent('claude-* → temperature, top_p')
    expect(row('Native output token floor')).toHaveTextContent('1,024')
    expect(row('Native context management')).toHaveTextContent('enabled · auto-compact on · threshold 0.8 · 3 models')
    expect(row('Native context management')).toHaveAttribute('title', 'gpt-5, o3, o4')
    expect(row('max_completion_tokens models')).toHaveTextContent('gpt-5, o3')
    expect(row('Unresolvable Responses items')).toHaveTextContent('filtered')
  })

  it('renders none for empty lists', async () => {
    await load(behavior({ strategies: { messages: [], responses: [], chatCompletions: [] } }))
    render(Behavior)
    // Spec §3.5: placeholder words are prose (sans), not machine strings.
    for (const label of ['Rewrites', 'Overload fallbacks', 'Native Responses filters', 'max_completion_tokens models', 'Messages strategies']) {
      expect(row(label)).toHaveTextContent(/^none$/)
      expect(row(label)).not.toHaveClass('mono')
    }
  })

  it.each([
    [true, 'enabled', 'yes', 'enabled', 'rejected', 'filtered'],
    [false, 'waiting for models', 'no', 'disabled', 'forwarded', 'forwarded'],
  ])('maps flags (%s)', async (on, autoCorrect, replace, applyPatch, images, items) => {
    const base = behavior()
    await load(behavior({
      modelRouting: { ...base.modelRouting, autoCorrect: { enabled: on } },
      parameterHandling: { ...base.parameterHandling, responsesFiltersReplaceDefault: on },
      contextManagement: { ...base.contextManagement, enabled: on },
      toolCompatibility: { responsesChatCompletionsFallback: on, functionApplyPatch: on, remoteResponsesImageUrlsRejected: on, unresolvableResponsesItemsFiltered: on },
    }))
    render(Behavior)
    expect(row('Auto-correct')).toHaveTextContent(autoCorrect)
    expect(row('Replace defaults')).toHaveTextContent(replace)
    expect(row('Function apply_patch')).toHaveTextContent(applyPatch)
    expect(row('Responses via Chat')).toHaveTextContent(applyPatch)
    expect(row('Native remote image URLs')).toHaveTextContent(images)
    expect(row('Unresolvable Responses items')).toHaveTextContent(items)
    // Spec §4.3 plain-value colors: off words (`disabled`, `no`, `rejected`) are --text-3; `forwarded` stays --text-1.
    const muted = (label: string) => row(label).querySelector('.muted') !== null
    for (const label of ['Auto-correct', 'Replace defaults', 'Function apply_patch', 'Responses via Chat', 'Native context management'])
      expect(muted(label)).toBe(!on)
    expect(muted('Native remote image URLs')).toBe(on)
    expect(muted('Unresolvable Responses items')).toBe(false)
  })

  it('swaps each panel to the legacy compact JSON strings with Raw JSON', async () => {
    await load(configured())
    render(Behavior)
    const user = userEvent.setup()
    const routingToggle = within(panel('Model routing')).getByRole('button', { name: /Raw JSON/ })
    expect(routingToggle).toHaveAttribute('aria-pressed', 'false')
    await user.click(routingToggle)
    expect(routingToggle).toHaveAttribute('aria-pressed', 'true')
    expect(row('Rewrites')).toHaveTextContent('[{"from":"gpt-4o","to":"gpt-5.4"}]')
    expect(row('Compact routing')).toHaveTextContent('{"enabled":true,"smallModel":"gpt-5.4-mini"}')
    expect(row('Family fallbacks')).toHaveTextContent('{"claudeOpus":"claude-opus-5.5","claudeSonnet":"claude-sonnet-5","claudeHaiku":"claude-haiku-4.5"}')
    expect(row('Overload fallbacks')).toHaveTextContent('{"claude-opus-5.5":"claude-sonnet-5"}')
    expect(row('Messages strategies')).toHaveTextContent(/^native-messages -> responses-api -> chat-completions$/)
    // The other panel keeps its structured values until its own toggle is pressed.
    expect(row('Native Responses filters')).toHaveTextContent('claude-* → temperature, top_p')
    await user.click(within(panel('Parameters and context')).getByRole('button', { name: /Raw JSON/ }))
    expect(row('Native Responses filters')).toHaveTextContent('[{"models":["claude-*"],"params":["temperature","top_p"]}]')
    expect(row('Native context management')).toHaveTextContent('{"enabled":true,"models":["gpt-5","o3","o4"],"autoCompactInput":true,"defaultCompactThreshold":0.8}')
    expect(app.ui.behaviorRaw).toEqual({ routing: true, params: true })
  })

  it('lists every effect, zeros included, sorted count desc, category asc, label asc', async () => {
    await load(behavior({
      effects: [
        effect('output.lowered', 'Output', 'Output tokens lowered', 0),
        effect('recovery.retry', 'Recovery', 'Retry', 1204),
        effect('routing.rewrite', 'Routing', 'Rewrite', 3),
        effect('output.capped', 'Output', 'Capped', 3),
        effect('recovery.fallback', 'Recovery', 'Fallback', 0),
        effect('output.alpha', 'Output', 'Alpha', 0),
      ],
    }))
    render(Behavior)
    expect(bodyRows().map(tr => tr.querySelector('.sub')?.textContent)).toEqual([
      'recovery.retry',
      'output.capped',
      'routing.rewrite',
      'output.alpha',
      'output.lowered',
      'recovery.fallback',
    ])
    const [top, , , zero] = bodyRows()
    expect(within(top!).getByRole('meter')).toHaveAttribute('aria-valuenow', '100')
    expect(top).toHaveTextContent('1,204')
    expect(zero).toHaveClass('zero')
    expect(within(zero!).queryByRole('meter')).not.toBeInTheDocument()
    expect(within(panel('Effects since startup')).getByText('6 effects · 3 active')).toBeInTheDocument()
  })

  it('shows +N since open after counts rise and blank at 0', async () => {
    const effects = (retry: number) => [effect('recovery.retry', 'Recovery', 'Retry', retry), effect('output.lowered', 'Output', 'Output tokens lowered', 2)]
    await load(behavior({ effects: effects(5) }))
    render(Behavior)
    const since = () => bodyRows().map(tr => tr.querySelector('td.since')?.textContent)
    expect(since()).toEqual(['', ''])
    await load(behavior({ effects: effects(17) }))
    expect(since()).toEqual(['+12', ''])
    expect(bodyRows()[0]!.querySelector('.since-inline')).toHaveTextContent('(+12)')
  })

  it('hides zero rows with Hide zero', async () => {
    await load(behavior({ effects: [effect('recovery.retry', 'Recovery', 'Retry', 1), effect('output.lowered', 'Output', 'Output tokens lowered', 0)] }))
    render(Behavior)
    expect(bodyRows()).toHaveLength(2)
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Hide zero' }))
    expect(bodyRows()).toHaveLength(1)
    expect(screen.queryByText('Output tokens lowered')).not.toBeInTheDocument()
    expect(screen.getByText('2 effects · 1 active')).toBeInTheDocument()
  })

  it('shows a fault strip and keeps last-known data marked stale', async () => {
    await load()
    render(Behavior)
    await load(jsonError(500, 'Behavior exploded'))
    expect(screen.getByText(/Couldn't load Behavior: Behavior exploded/)).toBeInTheDocument()
    expect(screen.getAllByText(/Couldn't load Behavior/)).toHaveLength(1)
    expect(row('Auto-correct')).toHaveTextContent('enabled')
    expect(within(panel('Model routing')).getByText('stale')).toBeInTheDocument()
  })
})
