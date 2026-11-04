import { createContext, Script } from 'node:vm'
import { describe, expect, test } from 'bun:test'

import { DASHBOARD_HTML, DASHBOARD_JS } from '~/routes/dashboard/assets'
import { getDashboardBehavior } from '~/routes/dashboard/config-projection'

class FakeElement {
  children: FakeElement[] = []
  className = ''
  dataset: Record<string, string> = {}
  disabled = false
  checked = false
  hidden = false
  href = ''
  tabIndex = -1
  textContent = ''
  type = ''
  value = ''

  addEventListener() {}

  append(...children: FakeElement[]) {
    this.children.push(...children)
  }

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
  loadAllViews: () => Promise<void>
  refreshDashboardMetadata: () => Promise<void>
  refreshLiveViews: () => Promise<void>
  settleLoads: (loads: Array<{ scope: string, load: () => Promise<void> }>) => Promise<void>
  startAccountBootstrap: (event: { preventDefault: () => void }) => Promise<void>
  removeAccount: (accountName: string, button: FakeElement) => Promise<void>
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
  confirmRemoval?: () => boolean
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
      confirm: options.confirmRemoval ?? (() => false),
      location: {
        href: options.locationHref ?? 'http://localhost:4141/dashboard',
        replace: options.replaceLocation ?? (() => {}),
      },
      matchMedia: () => ({ matches: false }),
    },
  })

  new Script(`${script}\n;globalThis.dashboardRuntime = { dashboardState, loadAllViews, refreshDashboardMetadata, refreshLiveViews, renderAccountAuthentication, renderAccounts, renderOverview, renderRequests, settleLoads, startAccountBootstrap, removeAccount };`).runInContext(context)

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

function overviewResponse(): Response {
  return Response.json({
    status: 'ok',
    version: 'test',
    uptimeMs: 0,
    startedAt: '2026-09-08T00:00:00.000Z',
    activity: { activeRequests: 0, recentRequests: 0, completed: 0, failed: 0, aborted: 0, upstreamQueue: {} },
    auth: { github: {}, copilot: {} },
    quota: { status: 'unavailable' },
  })
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
      auth: {
        github: {},
        copilot: {},
        accounts: {
          currentAccount: 'work',
          defaultAccount: 'personal',
          totalAccounts: 2,
        },
      },
      quota: { status: 'unavailable' },
    })

    expect(DASHBOARD_HTML).toContain('id="metric-aborted"')
    expect(elements.get('metric-aborted')?.textContent).toBe('1')
    expect(JSON.stringify(elements.get('auth-body'))).toContain('2 total / default personal / current work')
  })

  test('keeps initial and Live refreshes on read-only Dashboard routes', async () => {
    const requests: Array<{ method: string, path: string }> = []
    const { elements, runtime } = createRuntime({
      fetch: async (input, init) => {
        requests.push({ method: init?.method ?? 'GET', path: String(input) })
        if (input === '/dashboard/api/overview') {
          return Response.json({
            status: 'ok',
            version: 'test',
            uptimeMs: 0,
            startedAt: '2026-09-08T00:00:00.000Z',
            activity: { activeRequests: 0, recentRequests: 0, completed: 0, failed: 0, aborted: 0, upstreamQueue: {} },
            auth: { github: {}, copilot: {} },
            quota: { status: 'unavailable' },
          })
        }
        if (input === '/dashboard/api/accounts')
          return Response.json({ routingEnabled: true, accounts: [] })
        if (input === '/dashboard/api/m365')
          return Response.json({ registered: false, onboarding: { status: 'available' }, routing: [] })
        if (input === '/dashboard/api/models')
          return Response.json({ models: [] })
        if (input === '/dashboard/api/behavior')
          return Response.json({ modelRouting: {}, strategies: {}, parameterHandling: {}, contextManagement: {}, toolCompatibility: {}, effects: [] })
        return Response.json({ active: [], recent: [] })
      },
    })
    const liveRefresh = new FakeElement()
    liveRefresh.checked = true
    elements.set('live-refresh', liveRefresh)

    await runtime.loadAllViews()
    await runtime.refreshLiveViews()

    expect(requests).not.toContainEqual({ method: 'POST', path: '/dashboard/api/refresh' })
    expect(requests.filter(request => request.method === 'GET')).toHaveLength(7)
  })

  test('queues a manual metadata refresh requested while a view load is active', async () => {
    let releaseOverview: (() => void) | undefined
    const requests: Array<{ method: string, path: string }> = []
    const { runtime } = createRuntime({
      fetch: async (input, init) => {
        const path = String(input)
        requests.push({ method: init?.method ?? 'GET', path })
        if (path === '/dashboard/api/overview' && !releaseOverview) {
          return new Promise<Response>((resolve) => {
            releaseOverview = () => resolve(overviewResponse())
          })
        }
        if (path === '/dashboard/api/overview')
          return overviewResponse()
        if (path === '/dashboard/api/refresh')
          return Response.json({ status: 'ok', accounts: [] })
        if (path === '/dashboard/api/accounts')
          return Response.json({ routingEnabled: true, accounts: [] })
        if (path === '/dashboard/api/models')
          return Response.json({ models: [] })
        if (path === '/dashboard/api/behavior')
          return Response.json({ modelRouting: {}, strategies: {}, parameterHandling: {}, contextManagement: {}, toolCompatibility: {}, effects: [] })
        return Response.json({ active: [], recent: [] })
      },
    })

    const loading = runtime.loadAllViews()
    await Promise.resolve()
    await runtime.refreshDashboardMetadata()
    releaseOverview!()
    await loading
    await Promise.resolve()

    expect(requests).toContainEqual({ method: 'POST', path: '/dashboard/api/refresh' })
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

  test('redirects away from a removed account hostname while preserving the listener port', async () => {
    const replacements: string[] = []
    const { runtime } = createRuntime({
      locationHref: 'http://work.localhost:4187/dashboard',
      confirmRemoval: () => true,
      replaceLocation: href => replacements.push(href),
      fetch: async (_input, init) => {
        if (init?.method !== 'DELETE')
          throw new Error('The removed origin cannot serve Dashboard reads')
        return Response.json({ baseHostname: 'localhost', defaultAccount: 'default' })
      },
    })
    runtime.renderAccounts({
      routingEnabled: true,
      accounts: [{ name: 'work', hostname: 'work.localhost', isDefault: false }],
    })

    await runtime.removeAccount('work', new FakeElement())

    expect(replacements).toEqual(['http://localhost:4187/dashboard'])
  })

  test('shows partial refresh failure and clears it after an M365 not-applicable success', async () => {
    let failed = true
    const { elements, runtime } = createRuntime({
      fetch: async (input) => {
        const path = String(input)
        if (path === '/dashboard/api/refresh') {
          return Response.json({
            status: failed ? 'partial' : 'ok',
            accounts: [{
              name: failed ? 'work' : 'm365',
              github: { status: failed ? 'ok' : 'not_applicable' },
              quota: { status: failed ? 'ok' : 'not_applicable' },
              models: { status: failed ? 'stale' : 'ok' },
            }],
          })
        }
        if (path === '/dashboard/api/overview')
          return overviewResponse()
        if (path === '/dashboard/api/accounts')
          return Response.json({ routingEnabled: true, accounts: [] })
        if (path === '/dashboard/api/m365')
          return Response.json({ registered: false, onboarding: { status: 'available' }, routing: [] })
        if (path === '/dashboard/api/models')
          return Response.json({ models: [] })
        if (path === '/dashboard/api/behavior')
          return Response.json(getDashboardBehavior())
        return Response.json({ active: [], recent: [] })
      },
    })
    const banner = new FakeElement()
    banner.hidden = true
    elements.set('error-banner', banner)

    await runtime.refreshDashboardMetadata()
    expect(banner.hidden).toBe(false)
    failed = false
    await runtime.refreshDashboardMetadata()
    expect(banner.hidden).toBe(true)
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

  test('shows an editable default-account hostname before legacy routing bootstrap', () => {
    const { elements, runtime } = createRuntime()

    runtime.renderAccounts({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      routingEnabled: false,
      accounts: [{
        name: 'default',
        hostname: 'default-account.localhost',
        isDefault: true,
        tenant: 'github.com',
        github: { status: 'ok', login: 'octocat' },
        copilot: { status: 'ok', modelsLoaded: true },
        quota: { status: 'unavailable' },
      }],
    })

    expect(DASHBOARD_HTML).toContain('id="account-bootstrap-form"')
    expect(DASHBOARD_HTML).toContain('id="account-add-panel" class="panel full-width account-add-panel" hidden')
    expect(DASHBOARD_HTML).toContain('default-account.localhost')
    expect(DASHBOARD_HTML).toContain('You can change this hostname before enabling')
    expect(elements.get('account-bootstrap-panel')?.hidden).toBe(false)
    expect(elements.get('account-add-panel')?.hidden).toBe(true)
    expect(elements.get('account-bootstrap-hostname')?.value)
      .toBe('default-account.localhost')
    expect(elements.get('accounts-summary')?.textContent)
      .toBe('Legacy default default / routing not enabled')
  })

  test.each([
    'http://127.0.0.1:4187/dashboard',
    'http://0.0.0.0:4187/dashboard',
    'http://default-account.localhost:4187/dashboard',
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

  test('renders the M365 section from the target projection', async () => {
    const { elements, runtime } = createRuntime({
      fetch: async (input) => {
        const path = String(input)
        if (path === '/dashboard/api/accounts')
          return Response.json({ baseHostname: 'localhost', defaultAccount: 'default', routingEnabled: true, accounts: [] })
        if (path === '/dashboard/api/models')
          return Response.json({ models: [] })
        if (path === '/dashboard/api/behavior')
          return Response.json({ modelRouting: {}, strategies: {}, parameterHandling: {}, contextManagement: {}, toolCompatibility: {}, effects: [] })
        if (path === '/dashboard/api/m365') {
          return Response.json({
            registered: true,
            hostname: 'm365.localhost',
            account: 'home-account-id-1234',
            modelCount: 1,
            models: ['claude-opus-5.5'],
            availability: { status: 'ready', updatedAt: 1 },
            routing: [
              { target: 'default', hostname: 'default.localhost', kind: 'github', isDefault: true },
              { target: 'm365', hostname: 'm365.localhost', kind: 'm365', isDefault: false },
            ],
            client: { baseUrl: 'http://m365.localhost:4141', model: 'claude-opus-5.5' },
            onboarding: { status: 'available' },
          })
        }
        return Response.json({ active: [], recent: [] })
      },
    })

    const panel = new FakeElement()
    panel.hidden = true
    elements.set('m365-panel', panel)
    const active = new FakeElement()
    active.hidden = true
    elements.set('m365-active', active)

    await runtime.refreshDashboardMetadata()

    expect(elements.get('m365-panel')?.hidden).toBe(false)
    expect(elements.get('m365-active')?.hidden).toBe(false)
    expect(elements.get('m365-status')?.textContent).toBe('Ready.')
    expect(elements.get('m365-client')?.textContent).toContain('http://m365.localhost:4141')
    expect(elements.get('m365-client')?.textContent).toContain('claude-opus-5.5')
    expect(elements.get('m365-routing')?.textContent).toContain('m365 \u2192 m365.localhost')
  })
})
