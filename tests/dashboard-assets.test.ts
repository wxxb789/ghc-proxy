import { createContext, Script } from 'node:vm'
import { describe, expect, test } from 'bun:test'

import { DASHBOARD_HTML, DASHBOARD_JS } from '~/routes/dashboard/assets'

class FakeElement {
  children: FakeElement[] = []
  className = ''
  dataset: Record<string, string> = {}
  disabled = false
  hidden = false
  href = ''
  tabIndex = -1
  textContent = ''
  type = ''
  value = ''

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
  renderAccountAuthentication: (session: unknown) => void
  renderAccounts: (data: unknown) => void
  renderOverview: (data: unknown) => void
  renderRequests: (data: { active: RequestFixture[], recent: RequestFixture[] }) => void
  settleLoads: (loads: Array<{ scope: string, load: () => Promise<void> }>) => Promise<void>
  startAccountBootstrap: (event: { preventDefault: () => void }) => Promise<void>
}

interface RequestFixture {
  requestId: string
  state: string
  endpoint: string
  startedAt: number
}

function createRuntime(options: {
  fetch?: (input: Request | URL | string, init?: RequestInit) => Promise<Response>
  locationHref?: string
  replaceLocation?: (href: string) => void
} = {}) {
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
    fetch: options.fetch,
    navigator: {},
    URL,
    window: {
      location: {
        href: options.locationHref ?? 'http://localhost:4141/dashboard',
        replace: options.replaceLocation ?? (() => {}),
      },
      matchMedia: () => ({ matches: false }),
    },
  })

  new Script(`${script}\n;globalThis.dashboardRuntime = { dashboardState, renderAccountAuthentication, renderAccounts, renderOverview, renderRequests, settleLoads, startAccountBootstrap };`).runInContext(context)

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
    expect(elements.get('request-count')?.textContent).toBe('1 active / 1 finished')
  })

  test('renders the explicit aborted lifecycle total', () => {
    const { elements, runtime } = createRuntime()

    runtime.renderOverview({
      status: 'ok',
      version: 'test',
      uptimeMs: 1_000,
      startedAt: 1_777_000_000_000,
      activity: {
        activeRequests: 0,
        recentRequests: 1,
        completed: 0,
        failed: 0,
        aborted: 1,
        upstreamQueue: {},
      },
      auth: { github: {}, copilot: {} },
      quota: { status: 'unavailable' },
    })

    expect(DASHBOARD_HTML).toContain('id="metric-aborted"')
    expect(elements.get('metric-aborted')?.textContent).toBe('1')
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

  test('renders account identity, routing, health, and default action without credentials', () => {
    const { elements, runtime } = createRuntime()

    runtime.renderAccounts({
      baseHostname: 'localhost',
      defaultAccount: 'personal',
      routingEnabled: true,
      accounts: [{
        name: 'personal',
        hostname: 'personal.localhost',
        isDefault: true,
        tenant: 'github.com',
        github: { status: 'ok', login: 'octocat' },
        copilot: { status: 'ok', modelsLoaded: true },
        quota: {
          status: 'ok',
          premiumInteractions: { remaining: 75, entitlement: 100 },
        },
      }],
    })

    expect(DASHBOARD_HTML).toContain('data-tab="accounts"')
    expect(DASHBOARD_HTML).toContain('id="account-add-form"')
    expect(elements.get('accounts-summary')?.textContent).toBe('Base localhost / default personal')
    const row = elements.get('accounts-body')?.children[0]
    expect(JSON.stringify(row)).toContain('personal.localhost')
    expect(JSON.stringify(row)).toContain('octocat')
    expect(JSON.stringify(row)).not.toContain('token')
  })

  test('shows an editable defaultaccount hostname before legacy routing bootstrap', () => {
    const { elements, runtime } = createRuntime()

    runtime.renderAccounts({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      routingEnabled: false,
      accounts: [{
        name: 'default',
        hostname: 'defaultaccount.localhost',
        isDefault: true,
        tenant: 'github.com',
        github: { status: 'ok', login: 'octocat' },
        copilot: { status: 'ok', modelsLoaded: true },
        quota: { status: 'unavailable' },
      }],
    })

    expect(DASHBOARD_HTML).toContain('id="account-bootstrap-form"')
    expect(DASHBOARD_HTML).toContain('id="account-add-panel" class="panel full-width account-add-panel" hidden')
    expect(DASHBOARD_HTML).toContain('You can change this hostname before enabling')
    expect(elements.get('account-bootstrap-panel')?.hidden).toBe(false)
    expect(elements.get('account-add-panel')?.hidden).toBe(true)
    expect(elements.get('account-bootstrap-hostname')?.value)
      .toBe('defaultaccount.localhost')
    expect(elements.get('accounts-summary')?.textContent)
      .toBe('Legacy default default / routing not enabled')
  })

  test.each([
    'http://127.0.0.1:4187/dashboard',
    'http://0.0.0.0:4187/dashboard',
    'http://defaultaccount.localhost:4187/dashboard',
  ])('redirects %s to the base hostname after bootstrap', async (locationHref) => {
    const replacements: string[] = []
    let requestBody = ''
    const { elements, runtime } = createRuntime({
      locationHref,
      replaceLocation: href => replacements.push(href),
      fetch: async (_input, init) => {
        requestBody = String(init?.body)
        return Response.json({ baseHostname: 'localhost' })
      },
    })
    const hostnameInput = new FakeElement()
    hostnameInput.value = 'primary.localhost'
    elements.set('account-bootstrap-hostname', hostnameInput)

    await runtime.startAccountBootstrap({ preventDefault: () => {} })

    expect(JSON.parse(requestBody)).toEqual({ hostname: 'primary.localhost' })
    expect(replacements).toEqual(['http://localhost:4187/dashboard'])
  })

  test('renders only public device authorization fields', () => {
    const { elements, runtime } = createRuntime()

    runtime.renderAccountAuthentication({
      id: 'session-1',
      state: 'pending',
      accountName: 'work',
      hostname: 'work.localhost',
      authorization: {
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresAt: '2026-09-05T12:00:00.000Z',
        pollIntervalSeconds: 5,
      },
    })

    expect(elements.get('account-auth-code')?.textContent).toBe('ABCD-1234')
    expect(elements.get('account-auth-link')?.href).toBe('https://github.com/login/device')
    expect(JSON.stringify(elements.get('account-auth'))).not.toContain('device_code')
  })
})
