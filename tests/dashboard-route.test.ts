import type { DashboardMetadataRefreshService } from '~/routes/dashboard/metadata-refresh'

import type { DashboardAccountManagement } from '~/routes/dashboard/route'
import type { CopilotUsageResponse } from '~/types'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Elysia } from 'elysia'
import { AccountManager } from '~/accounts/manager'
import { compileAccountRouting } from '~/lib/account-routing'
import { DashboardQuotaCache, dashboardQuotaCache } from '~/routes/dashboard/handler'
import {
  DashboardMetadataRefresher,

} from '~/routes/dashboard/metadata-refresh'
import {
  createDashboardRoutes,
  DASHBOARD_ACCOUNT_QUOTA_CONCURRENCY,
  isLoopbackAddress,
} from '~/routes/dashboard/route'
import { createServer } from '~/server'
import {
  authStore,
  configureAccountRuntimes,
  createAccountRuntime,
  resetAccountRuntimes,
  runtimeStore,
} from '~/state'

import {
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

let snapshot: ReturnType<typeof saveStateSnapshot>

beforeEach(() => {
  snapshot = saveStateSnapshot()
  setupDefaultTestState()
  authStore.githubToken = undefined
  runtimeStore.requests.reset()
  dashboardQuotaCache.reset()
})

afterEach(() => {
  runtimeStore.requests.reset()
  dashboardQuotaCache.reset()
  resetAccountRuntimes()
  restoreStateSnapshot(snapshot)
})

describe('dashboard static routes', () => {
  test('serves a self-contained dashboard surface with strict security headers', async () => {
    const server = createServer()
    const htmlResponse = await server.handle(new Request('http://localhost/dashboard'))
    const cssResponse = await server.handle(new Request('http://localhost/dashboard/styles.css'))
    const jsResponse = await server.handle(new Request('http://localhost/dashboard/app.js'))

    expect(htmlResponse.status).toBe(200)
    expect(htmlResponse.headers.get('content-type')).toContain('text/html')
    expect(htmlResponse.headers.get('cache-control')).toBe('no-store')
    expect(htmlResponse.headers.get('content-security-policy')).toContain('script-src \'self\'')
    expect(htmlResponse.headers.get('content-security-policy')).not.toContain('unsafe-inline')
    const html = await htmlResponse.text()
    expect(html).toContain('/dashboard/styles.css')
    expect(html).toContain('/dashboard/app.js')
    expect(html).toContain('Overview')
    expect(html).toContain('Accounts')
    expect(html).toContain('Models')
    expect(html).toContain('Behavior')
    expect(html).toContain('Requests')
    expect(html).toContain('id="theme-toggle"')
    expect(html).toContain('role="switch"')
    expect(html).toContain('id="model-group-vendor"')
    expect(html).toContain('id="model-sort"')
    expect(html).toContain('id="copy-models"')
    expect(html).toContain('id="account-add-form"')

    expect(cssResponse.headers.get('content-type')).toContain('text/css')
    expect(jsResponse.headers.get('content-type')).toContain('text/javascript')
    const js = await jsResponse.text()
    expect(js).toContain('ghc-proxy-dashboard-theme')
    expect(js).toContain('prefers-color-scheme: dark')
    expect(js).toContain('window.location.origin + \'/v1\'')
    expect(js).toContain('\'Model ID\', \'Model Name\', \'Vendor\', \'Version\'')
    expect(js).toContain('[\'Endpoint: \' + localEndpoint, headers.join(\'\\t\')]')
    expect(js).toContain('navigator.clipboard?.writeText')
    expect(js).toContain('/dashboard/api/accounts/default')
    expect(js).toContain('/dashboard/api/account-auth/')
    expect(js).not.toContain('innerHTML')
    expect(await cssResponse.text()).toContain('.account-auth[hidden] { display: none; }')
  })

  test('does not record dashboard polling in the request ring', async () => {
    const response = await createServer().handle(
      new Request('http://localhost/dashboard/api/requests'),
    )
    await response.text()
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(response.status).toBe(200)
    expect(runtimeStore.requests.snapshot()).toMatchObject({ active: [], recent: [] })
  })
})

describe('dashboard API security projection', () => {
  test('recognizes only loopback peer addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.255.255.254')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.10')).toBe(false)
    expect(isLoopbackAddress('203.0.113.7')).toBe(false)
    expect(isLoopbackAddress('127.999.0.1')).toBe(false)
  })

  test('rejects cross-origin browser reads', async () => {
    const server = createServer()
    const response = await server.handle(new Request('http://localhost/dashboard/api/models', {
      headers: { origin: 'https://attacker.example' },
    }))

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        message: 'Dashboard access is restricted to the local machine.',
        type: 'invalid_request_error',
      },
    })
  })

  test('rejects matching attacker-controlled Host and Origin values', async () => {
    const response = await createServer().handle(new Request(
      'http://attacker.example/dashboard/api/models',
      { headers: { origin: 'http://attacker.example' } },
    ))

    expect(response.status).toBe(403)
  })

  test('validates the peer address on srvx live Node requests', async () => {
    const app = createDashboardRoutes()
    const remoteResponse = await app.handle(srvxNodeRequest('203.0.113.7'))
    const loopbackResponse = await app.handle(srvxNodeRequest('127.0.0.1'))

    expect(remoteResponse.status).toBe(403)
    expect(loopbackResponse.status).toBe(200)
  })

  test('never exposes tokens or unsafe quota fields', async () => {
    authStore.githubToken = 'github-secret-token'
    authStore.copilotToken = 'copilot-secret-token'
    authStore.githubLogin = 'octocat'
    authStore.githubValidatedAt = Date.now()
    const quotaCache = new DashboardQuotaCache(async () => usageFixture())
    const app = new Elysia().use(createDashboardRoutes({ quotaCache }))

    const responses = await Promise.all([
      app.handle(new Request('http://localhost/dashboard/api/overview')),
      app.handle(new Request('http://localhost/dashboard/api/models')),
      app.handle(new Request('http://localhost/dashboard/api/behavior')),
      app.handle(new Request('http://localhost/dashboard/api/requests')),
    ])
    const body = (await Promise.all(responses.map(response => response.text()))).join('\n')

    expect(responses.every(response => response.status === 200)).toBe(true)
    expect(body).not.toContain('github-secret-token')
    expect(body).not.toContain('copilot-secret-token')
    expect(body).not.toContain('analytics-secret')
    expect(body).not.toContain('organization-secret')
    expect(body).not.toContain('authorization')
  })
})

describe('dashboard account management API', () => {
  test('loads quota during initial Dashboard projections and refreshes it manually', async () => {
    const manager = accountManagerFixture()
    authStore.githubToken = 'github-default'
    manager.getAccountSnapshot().accounts[0]!.runtime.auth.githubToken = 'github-default'
    let quotaLoads = 0
    const quotaCache = new DashboardQuotaCache(async () => {
      quotaLoads++
      return usageFixture()
    })
    const app = createDashboardRoutes({
      accountManager: manager,
      metadataRefresher: new DashboardMetadataRefresher({
        refreshGitHubIdentity: async () => {},
        refreshModels: async () => {},
      }),
      quotaCache,
    })

    const [overview, accounts] = await Promise.all([
      app.handle(new Request('http://localhost/dashboard/api/overview')),
      app.handle(new Request('http://localhost/dashboard/api/accounts')),
    ])
    expect(quotaLoads).toBe(1)
    expect(await overview.json()).toMatchObject({ quota: { status: 'ok' } })
    expect(await accounts.json()).toMatchObject({
      accounts: [{ quota: { status: 'ok' } }],
    })

    const refresh = await app.handle(new Request(
      'http://localhost/dashboard/api/refresh',
      { method: 'POST', headers: { origin: 'http://localhost' } },
    ))
    await refresh.text()
    expect(quotaLoads).toBe(2)

    await app.handle(new Request('http://localhost/dashboard/api/overview'))
    await app.handle(new Request('http://localhost/dashboard/api/accounts'))
    expect(quotaLoads).toBe(2)
  })

  test('reports current, default, and active account count in Overview', async () => {
    const defaultRuntime = createAccountRuntime('default')
    const workRuntime = createAccountRuntime('work')
    const routing = compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      hostnames: {
        'default.localhost': 'default',
        'work.localhost': 'work',
      },
    }, ['default', 'work'])
    configureAccountRuntimes(routing, [defaultRuntime, workRuntime])
    const app = createServer({
      accountManager: new AccountManager({ routing, runtimes: [defaultRuntime, workRuntime] }),
    })

    const response = await app.handle(new Request('http://work.localhost/dashboard/api/overview'))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      auth: {
        accounts: {
          currentAccount: 'work',
          defaultAccount: 'default',
          totalAccounts: 2,
        },
      },
    })
  })

  test('refreshes account metadata through the existing management guard', async () => {
    const manager = accountManagerFixture()
    const refreshes: unknown[][] = []
    const refresher: DashboardMetadataRefreshService = {
      refresh: async (accounts) => {
        refreshes.push(accounts)
        return { status: 'ok', accounts: [] }
      },
    }
    const app = createDashboardRoutes({ accountManager: manager, metadataRefresher: refresher })

    const allowed = await app.handle(new Request(
      'http://localhost/dashboard/api/refresh',
      { method: 'POST', headers: { origin: 'http://localhost' } },
    ))
    const denied = await app.handle(new Request(
      'http://localhost/dashboard/api/refresh',
      { method: 'POST', headers: { origin: 'https://attacker.example' } },
    ))

    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({ status: 'ok', accounts: [] })
    expect(refreshes).toHaveLength(1)
    expect(denied.status).toBe(403)
  })

  test('loads and projects real routed accounts from a cold quota cache', async () => {
    const defaultRuntime = createAccountRuntime('default', {
      githubLogin: 'alice',
      githubToken: 'github-default',
      copilotToken: 'copilot-default',
    })
    const workRuntime = createAccountRuntime('work', {
      githubLogin: 'bob',
      githubToken: 'github-work',
      copilotToken: 'copilot-work',
    })
    defaultRuntime.models.cacheModels({ object: 'list', data: [] })
    workRuntime.models.cacheModels({ object: 'list', data: [] })
    const routing = compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      hostnames: {
        'default.localhost': 'default',
        'work.localhost': 'work',
      },
    }, ['default', 'work'])
    configureAccountRuntimes(routing, [defaultRuntime, workRuntime])
    const quotaCache = new DashboardQuotaCache(async () => ({
      ...usageFixture(),
      copilot_plan: authStore.githubToken ?? 'missing-token',
    }))
    const app = createDashboardRoutes({
      accountManager: new AccountManager({ routing, runtimes: [defaultRuntime, workRuntime] }),
      quotaCache,
    })

    const response = await app.handle(new Request('http://localhost/dashboard/api/accounts'))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      defaultAccount: 'default',
      accounts: [
        { name: 'default', isDefault: true, quota: { plan: 'github-default', status: 'ok' } },
        { name: 'work', isDefault: false, quota: { plan: 'github-work', status: 'ok' } },
      ],
    })
  })

  test('bounds cold quota loads while preserving account order and runtime isolation', async () => {
    const accountCount = DASHBOARD_ACCOUNT_QUOTA_CONCURRENCY * 2 + 1
    const runtimes = Array.from({ length: accountCount }, (_, index) => {
      const name = `account-${index}`
      const runtime = createAccountRuntime(name, {
        githubToken: `github-${index}`,
        copilotToken: `copilot-${index}`,
      })
      runtime.models.cacheModels({ object: 'list', data: [] })
      return runtime
    })
    const routing = compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: runtimes[0]!.name,
      hostnames: Object.fromEntries(
        runtimes.map(runtime => [`${runtime.name}.localhost`, runtime.name]),
      ),
    }, runtimes.map(runtime => runtime.name))
    configureAccountRuntimes(routing, runtimes)

    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let activeLoads = 0
    let maxActiveLoads = 0
    const quotaCache = new DashboardQuotaCache(async () => {
      activeLoads++
      maxActiveLoads = Math.max(maxActiveLoads, activeLoads)
      if (activeLoads === DASHBOARD_ACCOUNT_QUOTA_CONCURRENCY)
        started.resolve()
      try {
        await release.promise
        return {
          ...usageFixture(),
          copilot_plan: authStore.githubToken ?? 'missing-token',
        }
      }
      finally {
        activeLoads--
      }
    })
    const app = createDashboardRoutes({
      accountManager: new AccountManager({ routing, runtimes }),
      quotaCache,
    })

    const pendingResponse = app.handle(new Request('http://localhost/dashboard/api/accounts'))
    await started.promise
    expect(maxActiveLoads).toBe(DASHBOARD_ACCOUNT_QUOTA_CONCURRENCY)
    release.resolve()

    const response = await pendingResponse
    const body = await response.json() as {
      accounts: Array<{ name: string, quota: { plan?: string, status: string } }>
    }
    expect(response.status).toBe(200)
    expect(maxActiveLoads).toBe(DASHBOARD_ACCOUNT_QUOTA_CONCURRENCY)
    expect(body.accounts.map(account => account.name)).toEqual(runtimes.map(runtime => runtime.name))
    expect(body.accounts.map(account => ({
      plan: account.quota.plan,
      status: account.quota.status,
    }))).toEqual(
      Array.from({ length: accountCount }, (_, index) => ({
        plan: `github-${index}`,
        status: 'ok',
      })),
    )
  })

  test('bootstraps legacy routing with an editable dedicated hostname', async () => {
    const manager = accountManagerFixture({ routingEnabled: false })
    const app = createDashboardRoutes({ accountManager: manager })

    const accountsResponse = await app.handle(new Request(
      'http://localhost/dashboard/api/accounts',
    ))
    const bootstrapResponse = await app.handle(new Request(
      'http://localhost/dashboard/api/accounts/bootstrap',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'origin': 'http://localhost',
        },
        body: JSON.stringify({ hostname: 'personal.localhost' }),
      },
    ))

    expect(accountsResponse.status).toBe(200)
    expect(await accountsResponse.json()).toMatchObject({
      routingEnabled: false,
      accounts: [{
        name: 'default',
        hostname: 'default-account.localhost',
        isDefault: true,
      }],
    })
    expect(bootstrapResponse.status).toBe(200)
    expect(manager.bootstrapAccountRouting).toHaveBeenCalledWith('personal.localhost')
    expect(await bootstrapResponse.json()).toMatchObject({ routingEnabled: true })
  })

  test('does not refresh metadata before legacy routing is enabled', async () => {
    const manager = accountManagerFixture({ routingEnabled: false })
    const refresher: DashboardMetadataRefreshService = {
      refresh: mock(async () => ({ status: 'ok' as const, accounts: [] })),
    }
    const app = createDashboardRoutes({ accountManager: manager, metadataRefresher: refresher })

    const response = await app.handle(new Request(
      'http://localhost/dashboard/api/refresh',
      { method: 'POST', headers: { origin: 'http://localhost' } },
    ))

    expect(response.status).toBe(409)
    expect(refresher.refresh).not.toHaveBeenCalled()
  })

  test('serves account data and authentication state without exposing credentials', async () => {
    const manager = accountManagerFixture()
    const app = createDashboardRoutes({ accountManager: manager })

    const accountsResponse = await app.handle(new Request(
      'http://localhost/dashboard/api/accounts',
    ))
    const startResponse = await app.handle(new Request(
      'http://localhost/dashboard/api/accounts',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'origin': 'http://localhost',
        },
        body: JSON.stringify({
          accountName: 'work',
          hostname: 'work.localhost',
          gheDomain: 'company.ghe.com',
        }),
      },
    ))
    const statusResponse = await app.handle(new Request(
      'http://localhost/dashboard/api/account-auth/session-1',
    ))

    expect(accountsResponse.status).toBe(200)
    expect(startResponse.status).toBe(202)
    expect(statusResponse.status).toBe(200)
    expect(manager.beginAddAccount).toHaveBeenCalledWith({
      accountName: 'work',
      hostname: 'work.localhost',
      gheDomain: 'company.ghe.com',
    })
    expect(await accountsResponse.clone().json()).toMatchObject({
      baseHostname: 'localhost',
      defaultAccount: 'default',
    })
    const body = [accountsResponse, startResponse, statusResponse]
      .map(response => response.clone())
    const serialized = (await Promise.all(body.map(response => response.text()))).join('\n')
    expect(serialized).not.toContain('github-secret-token')
    expect(serialized).not.toContain('copilot-secret-token')
    expect(serialized).not.toContain('private-device-code')
  })

  test('switches default through the protected management service', async () => {
    const manager = accountManagerFixture()
    const app = createDashboardRoutes({ accountManager: manager })

    const response = await app.handle(new Request(
      'http://localhost/dashboard/api/accounts/default',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'origin': 'http://localhost',
        },
        body: JSON.stringify({ accountName: 'work' }),
      },
    ))

    expect(response.status).toBe(200)
    expect(manager.setDefaultAccount).toHaveBeenCalledWith('work')
    expect(await response.json()).toMatchObject({ defaultAccount: 'work' })
  })

  test('applies the existing access guard before account mutations', async () => {
    const manager = accountManagerFixture()
    const app = createDashboardRoutes({ accountManager: manager })

    const response = await app.handle(new Request(
      'http://localhost/dashboard/api/accounts/default',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'origin': 'https://attacker.example',
        },
        body: JSON.stringify({ accountName: 'work' }),
      },
    ))

    expect(response.status).toBe(403)
    expect(manager.setDefaultAccount).not.toHaveBeenCalled()
  })

  test('applies the existing access guard before legacy routing bootstrap', async () => {
    const manager = accountManagerFixture({ routingEnabled: false })
    const app = createDashboardRoutes({ accountManager: manager })

    const response = await app.handle(new Request(
      'http://localhost/dashboard/api/accounts/bootstrap',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'origin': 'https://attacker.example',
        },
        body: JSON.stringify({ hostname: 'personal.localhost' }),
      },
    ))

    expect(response.status).toBe(403)
    expect(manager.bootstrapAccountRouting).not.toHaveBeenCalled()
  })

  test('rejects invalid bodies and missing authentication sessions', async () => {
    const manager = accountManagerFixture()
    const app = createDashboardRoutes({ accountManager: manager })

    const invalid = await app.handle(new Request(
      'http://localhost/dashboard/api/accounts',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountName: 'work' }),
      },
    ))
    const missing = await app.handle(new Request(
      'http://localhost/dashboard/api/account-auth/missing',
    ))
    const invalidBootstrap = await app.handle(new Request(
      'http://localhost/dashboard/api/accounts/bootstrap',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    ))

    expect(invalid.status).toBe(400)
    expect(missing.status).toBe(404)
    expect(invalidBootstrap.status).toBe(400)
  })

  test('reports account management as unavailable without a configured manager', async () => {
    const response = await createDashboardRoutes().handle(new Request(
      'http://localhost/dashboard/api/accounts',
    ))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { type: 'invalid_request_error' },
    })
  })
})

function srvxNodeRequest(ip: string): Request {
  return Object.assign(
    new Request('http://localhost/dashboard/api/models'),
    {
      ip,
      runtime: { name: 'node', node: {} },
    },
  )
}

function usageFixture(): CopilotUsageResponse {
  const quota = {
    entitlement: 100,
    overage_count: 0,
    overage_permitted: false,
    percent_remaining: 80,
    quota_id: 'quota-secret',
    quota_remaining: 80,
    remaining: 80,
    unlimited: false,
  }
  return {
    access_type_sku: 'sku',
    analytics_tracking_id: 'analytics-secret',
    assigned_date: '2026-08-01',
    can_signup_for_limited: false,
    chat_enabled: true,
    copilot_plan: 'individual',
    organization_login_list: ['organization-secret'],
    organization_list: ['organization-secret'],
    quota_reset_date: '2026-09-01',
    quota_snapshots: {
      chat: quota,
      completions: quota,
      premium_interactions: quota,
    },
  }
}

function accountManagerFixture(
  options: { routingEnabled?: boolean } = {},
): DashboardAccountManagement & {
  beginAddAccount: ReturnType<typeof mock>
  bootstrapAccountRouting: ReturnType<typeof mock>
  setDefaultAccount: ReturnType<typeof mock>
} {
  let defaultAccount = 'default'
  let routingEnabled = options.routingEnabled ?? true
  const runtime = createAccountRuntime('default')
  return {
    getAccountSnapshot: () => ({
      routing: {
        baseHostname: 'localhost',
        defaultAccount,
        routingEnabled,
      },
      accounts: [{
        name: 'default',
        hostname: routingEnabled ? 'default.localhost' : 'default-account.localhost',
        isDefault: true,
        runtime,
      }],
    }),
    beginAddAccount: mock(async () => ({
      id: 'session-1',
      state: 'pending' as const,
      accountName: 'work',
      hostname: 'work.localhost',
      authorization: {
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresAt: '2026-09-05T12:00:00.000Z',
        pollIntervalSeconds: 5,
      },
    })),
    getAuthenticationSession: id => id === 'session-1'
      ? {
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
        }
      : undefined,
    bootstrapAccountRouting: mock(async () => {
      routingEnabled = true
    }),
    setDefaultAccount: mock(async (accountName: string) => {
      defaultAccount = accountName
    }),
  }
}
