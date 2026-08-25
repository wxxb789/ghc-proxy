import { createContext, Script } from 'node:vm'
import { describe, expect, test } from 'bun:test'

import { DASHBOARD_JS } from '~/routes/dashboard/assets'

class FakeElement {
  children: FakeElement[] = []
  className = ''
  dataset: Record<string, string> = {}
  hidden = false
  tabIndex = -1
  textContent = ''

  addEventListener() {}

  appendChild(child: FakeElement) {
    this.children.push(child)
    return child
  }

  replaceChildren() {
    this.children = []
  }
}

interface DashboardRuntime {
  dashboardState: {
    selectedRequestId: string | null
  }
  renderRequests: (data: { active: RequestFixture[], recent: RequestFixture[] }) => void
  settleLoads: (loads: Array<{ scope: string, load: () => Promise<void> }>) => Promise<void>
}

interface RequestFixture {
  requestId: string
  state: string
  endpoint: string
  startedAt: number
}

function createRuntime() {
  const elements = new Map<string, FakeElement>()
  const document = {
    createElement: () => new FakeElement(),
    getElementById: (id: string) => {
      const existing = elements.get(id)
      if (existing)
        return existing
      const element = new FakeElement()
      elements.set(id, element)
      return element
    },
    querySelectorAll: () => [],
  }
  const initializationStart = '\n/* dashboard-state-test-boundary */'
  const initializationIndex = DASHBOARD_JS.indexOf(initializationStart)
  if (initializationIndex < 0)
    throw new Error('Dashboard initialization marker not found')
  const script = DASHBOARD_JS.slice(0, initializationIndex)
  const context = createContext({
    document,
    navigator: {},
    window: { matchMedia: () => ({ matches: false }) },
  })

  new Script(`${script}\n;globalThis.dashboardRuntime = { dashboardState, renderRequests, settleLoads };`).runInContext(context)

  return {
    elements,
    runtime: context.dashboardRuntime as DashboardRuntime,
  }
}

function request(requestId: string): RequestFixture {
  return {
    requestId,
    state: 'completed',
    endpoint: '/v1/messages',
    startedAt: 1_777_000_000_000,
  }
}

describe('dashboard embedded state', () => {
  test('selects the first remaining request when the selected request disappears', () => {
    const { elements, runtime } = createRuntime()
    runtime.dashboardState.selectedRequestId = 'removed'

    runtime.renderRequests({ active: [request('active')], recent: [request('recent')] })

    expect(runtime.dashboardState.selectedRequestId).toBe('active')
    expect(elements.get('requests-body')?.children[0]?.className).toBe('selected')
    expect(elements.get('request-detail')?.textContent).toContain('"requestId": "active"')
  })

  test('clears request selection when no requests remain', () => {
    const { elements, runtime } = createRuntime()
    runtime.dashboardState.selectedRequestId = 'removed'

    runtime.renderRequests({ active: [], recent: [] })

    expect(runtime.dashboardState.selectedRequestId).toBeNull()
    expect(elements.get('request-detail')?.textContent).toBe('No request selected')
  })

  test('keeps an error until its own refresh scope succeeds', async () => {
    const { elements, runtime } = createRuntime()

    await runtime.settleLoads([
      { scope: 'overview', load: async () => { throw new Error('Overview refresh failed') } },
    ])
    await runtime.settleLoads([
      { scope: 'models', load: async () => {} },
    ])

    expect(elements.get('error-banner')).toMatchObject({
      hidden: false,
      textContent: 'Dashboard refresh failed',
    })

    await runtime.settleLoads([
      { scope: 'overview', load: async () => {} },
    ])

    expect(elements.get('error-banner')?.hidden).toBe(true)
  })
})
