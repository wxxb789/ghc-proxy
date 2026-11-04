import type { Mock } from 'bun:test'
import type { DashboardMetadataRefreshService } from '~/routes/dashboard/metadata-refresh'

import type { DashboardAccountManagement } from '~/routes/dashboard/types'
import type { CopilotUsageResponse } from '~/types'
import type { DashboardResponse, DashboardTargets } from '~/types/dashboard'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Elysia } from 'elysia'
import { AccountManager } from '~/accounts/manager'
import { createTargetRuntime } from '~/accounts/target-runtime'
import { resetMscTokenCache, setMscHelperRunner } from '~/clients/msc-auth'
import { compileAccountRouting } from '~/lib/account-routing'
import { isLoopbackAddress } from '~/lib/peer'
import { getM365DashboardState } from '~/routes/dashboard/m365'
import {
  DashboardMetadataRefresher,

} from '~/routes/dashboard/metadata-refresh'
import { DashboardQuotaCache, dashboardQuotaCache } from '~/routes/dashboard/quota'
import { createDashboardRoutes } from '~/routes/dashboard/route'
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
  test('does not record dashboard polling or deep links in the request ring', async () => {
    const app = createServer()
    const response = await app.handle(new Request('http://localhost/dashboard/api/requests'))
    const deepLink = await app.handle(new Request('http://localhost/dashboard/traffic?window=1h'))
    await response.text()
    await deepLink.text()
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(response.status).toBe(200)
    expect(deepLink.headers.get('content-type')).toContain('text/html')
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

  test('accepts a preserved dev-proxy Host and Origin without accepting a foreign production Origin', async () => {
    const app = createDashboardRoutes({ ui: null })
    const proxied = await app.handle(new Request('http://work.localhost:5173/dashboard/api/models', {
      headers: { origin: 'http://work.localhost:5173' },
    }))
    const direct = await app.handle(new Request('http://work.localhost:4141/dashboard/api/models', {
      headers: { origin: 'http://work.localhost:5173' },
    }))
    const localProxy = await app.handle(new Request('http://localhost:5173/dashboard/api/models', {
      headers: { origin: 'http://localhost:5173' },
    }))
    const proxiedMutation = await app.handle(new Request('http://work.localhost:5173/dashboard/api/accounts', {
      method: 'POST',
      headers: { origin: 'http://work.localhost:5173' },
    }))
    const directMutation = await app.handle(new Request('http://work.localhost:4141/dashboard/api/accounts', {
      method: 'POST',
      headers: { origin: 'http://work.localhost:5173' },
    }))

    expect(proxied.status).toBe(200)
    expect(localProxy.status).toBe(200)
    expect(direct.status).toBe(403)
    expect(proxiedMutation.status).toBe(409)
    expect(directMutation.status).toBe(403)
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
  test('loads quota only in its own region and refreshes it manually', async () => {
    const manager = accountManagerFixture()
    authStore.githubToken = 'github-default'
    manager.getAccountSnapshot().accounts[0]!.runtime.auth.githubToken = 'github-default'
    configureAccountRuntimes(compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      hostnames: { 'default.localhost': 'default' },
    }, ['default']), [manager.getAccountSnapshot().accounts[0]!.runtime])
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

    const [overview, targets] = await Promise.all([
      app.handle(new Request('http://localhost/dashboard/api/overview')),
      app.handle(new Request('http://localhost/dashboard/api/targets')),
    ])
    expect(overview.status).toBe(200)
    expect(targets.status).toBe(200)
    expect(quotaLoads).toBe(0)
    const quota = await app.handle(new Request('http://localhost/dashboard/api/targets/default/quota'))
    expect(await quota.json()).toMatchObject({ quota: { status: 'ok' } })
    expect(quotaLoads).toBe(1)

    const refresh = await app.handle(new Request(
      'http://localhost/dashboard/api/refresh',
      { method: 'POST', headers: { origin: 'http://localhost' } },
    ))
    await refresh.text()
    expect(quotaLoads).toBe(2)

    await app.handle(new Request('http://localhost/dashboard/api/overview'))
    await app.handle(new Request('http://localhost/dashboard/api/targets/default/quota'))
    expect(quotaLoads).toBe(2)
  })

  test('reports the host target and default routing without remote metadata', async () => {
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

    const response = await app.handle(new Request('http://work.localhost/dashboard/api/targets'))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      hostTarget: 'work',
      routing: { defaultAccount: 'default' },
      targets: [
        { name: 'default', isDefault: true },
        { name: 'work', isDefault: false },
      ],
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

  test('projects routed identities and loads quota in each selected runtime', async () => {
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

    const response = await app.handle(new Request('http://localhost/dashboard/api/targets'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      routing: { defaultAccount: 'default' },
      targets: [
        { name: 'default', isDefault: true, identity: 'alice' },
        { name: 'work', isDefault: false, identity: 'bob' },
      ],
    })
    const quotas = await Promise.all(['default', 'work'].map(async (name) => {
      const quota = await app.handle(new Request(`http://localhost/dashboard/api/targets/${name}/quota`))
      return quota.json()
    }))
    expect(quotas).toMatchObject([
      { target: 'default', quota: { plan: 'github-default', status: 'ok' } },
      { target: 'work', quota: { plan: 'github-work', status: 'ok' } },
    ])
  })

  test('keeps in-flight quota attached to its runtime when a target name is reused', async () => {
    const old = createAccountRuntime('default', { githubToken: 'old-private-token', githubLogin: 'alice' })
    const replacement = createAccountRuntime('default', { githubToken: 'new-private-token', githubLogin: 'bob' })
    const routing = compileAccountRouting({ baseHostname: 'localhost', defaultAccount: 'default', hostnames: { 'default.localhost': 'default' } }, ['default'])
    configureAccountRuntimes(routing, [old])
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const quotaCache = new DashboardQuotaCache(async () => {
      if (authStore.githubLogin === 'alice') {
        started.resolve()
        await release.promise
      }
      return { ...usageFixture(), copilot_plan: authStore.githubLogin === 'alice' ? 'old-plan' : 'replacement-plan' }
    })
    const app = createDashboardRoutes({ quotaCache })
    const first = await (await app.handle(new Request('http://localhost/dashboard/api/targets'))).json() as DashboardResponse<DashboardTargets>
    const oldQuota = app.handle(new Request('http://localhost/dashboard/api/targets/default/quota'))
    await started.promise
    configureAccountRuntimes(routing, [replacement])
    const second = await (await app.handle(new Request('http://localhost/dashboard/api/targets'))).json() as DashboardResponse<DashboardTargets>
    expect(second.targets[0]?.runtimeId).not.toBe(first.targets[0]?.runtimeId)
    release.resolve()
    expect(await (await oldQuota).json()).toMatchObject({ runtimeId: first.targets[0]?.runtimeId, quota: { plan: 'old-plan' } })
    const currentQuota = await app.handle(new Request('http://localhost/dashboard/api/targets/default/quota'))
    expect(await currentQuota.json()).toMatchObject({ runtimeId: second.targets[0]?.runtimeId, quota: { plan: 'replacement-plan' } })
  })

  test('bootstraps legacy routing with an editable dedicated hostname', async () => {
    const manager = accountManagerFixture({ routingEnabled: false })
    const app = createDashboardRoutes({ accountManager: manager })

    const accountsResponse = await app.handle(new Request(
      'http://localhost/dashboard/api/targets',
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
      routing: { routingEnabled: false },
      capabilities: { canBootstrap: true, canAddAccount: false, canRefreshMetadata: false },
      targets: [{
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
      'http://localhost/dashboard/api/targets',
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
      routing: { baseHostname: 'localhost', defaultAccount: 'default' },
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
      { method: 'POST' },
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
  registerM365Target: ReturnType<typeof mock>
  removeM365Target: ReturnType<typeof mock>
  removeAccount: Mock<(accountName: string) => Promise<void>>
  configureM365Target: ReturnType<typeof mock>
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
    registerM365Target: mock(async () => {}),
    removeM365Target: mock(async () => {}),
    removeAccount: mock(async () => {}),
    configureM365Target: mock(async () => {}),
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

describe('M365 broker sign-in boundary', () => {
  test('returns only the signed-in identity and enforces the Origin guard before WAM', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-msc-sign-in-'))
    const previousExe = process.env.GHC_MSC_AUTH_EXE
    process.env.GHC_MSC_AUTH_EXE = join(directory, 'msc-auth.exe')
    writeFileSync(process.env.GHC_MSC_AUTH_EXE, 'unused')
    let brokerCalls = 0
    setMscHelperRunner(async () => {
      brokerCalls++
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          access_token: 'private-broker-token',
          expires_on: new Date(Date.now() + 60_000).toISOString(),
          username: 'operator@example.com',
          tenant: 'tenant',
          home_account_id: 'operator.tenant',
          environment: 'login.microsoftonline.com',
        }),
      }
    })
    try {
      const app = createDashboardRoutes({ accountManager: accountManagerFixture() })
      const request = (origin: string) => new Request('http://localhost/dashboard/api/m365/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ upn: 'operator@example.com' }),
      })
      const denied = await app.handle(request('https://attacker.example'))
      expect(denied.status).toBe(403)
      expect(brokerCalls).toBe(0)
      const response = await app.handle(request('http://localhost'))
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(JSON.parse(body)).toMatchObject({
        account: { upn: 'operator@example.com', homeAccountId: 'operator.tenant' },
      })
      expect(body).not.toContain('private-broker-token')
      expect(body).not.toContain('access_token')
    }
    finally {
      setMscHelperRunner()
      resetMscTokenCache()
      if (previousExe === undefined)
        delete process.env.GHC_MSC_AUTH_EXE
      else
        process.env.GHC_MSC_AUTH_EXE = previousExe
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('M365 target projection', () => {
  function targetManager(registered: boolean) {
    const m365 = createTargetRuntime('m365', 'm365', {
      mscAuthAccount: 'home-account',
      auth: { mscAuthUsername: 'operator@example.com', mscAuthTenant: 'tenant-id' },
    })
    m365.models.cacheModels({
      object: 'list',
      data: [{
        id: 'claude-opus-5.5',
        name: 'Claude Opus 5.5',
        supported_endpoints: ['/v1/messages'],
      }],
    } as never)
    const github = createAccountRuntime('default')
    const accounts = [
      { name: 'default', hostname: 'default.localhost', isDefault: true, runtime: github },
      ...(registered
        ? [{ name: 'm365', hostname: 'm365.localhost', isDefault: false, runtime: m365 }]
        : []),
    ]
    return {
      getAccountSnapshot: () => ({
        routing: {
          baseHostname: 'localhost',
          defaultAccount: 'default',
          routingEnabled: true,
        },
        accounts,
      }),
    }
  }

  test('reports the target as absent on a GitHub-only process', () => {
    const state = getM365DashboardState({ manager: targetManager(false), serverPort: 4141 })

    expect(state.registered).toBe(false)
    expect(state.onboarding.status).toBe('available')
    expect(state.routing.map(row => row.hostname)).toEqual(['default.localhost'])
  })

  test('projects registration, catalog, and the client base URL', () => {
    const state = getM365DashboardState({ manager: targetManager(true), serverPort: 4141 })

    expect(state).toMatchObject({
      registered: true,
      hostname: 'm365.localhost',
      account: 'home-account',
      modelCount: 1,
      models: ['claude-opus-5.5'],
      client: {
        baseUrl: 'http://m365.localhost:4141',
        model: 'claude-opus-5.5',
      },
    })
    expect(state.routing.map(row => row.kind)).toEqual(['github', 'm365'])
  })

  test('does not label the M365 target as a GitHub tenant', async () => {
    const manager = targetManager(true)
    const app = createDashboardRoutes({ accountManager: {
      ...accountManagerFixture(),
      getAccountSnapshot: manager.getAccountSnapshot,
    } })
    const response = await app.handle(new Request('http://localhost/dashboard/api/targets'))
    const body = await response.json() as DashboardResponse<DashboardTargets>

    expect(body.targets.find(account => account.name === 'm365')).toMatchObject({
      kind: 'm365',
      tenant: 'tenant-id',
      identity: 'operator@example.com',
    })
    expect(body.targets.find(account => account.name === 'default')).toMatchObject({
      kind: 'github',
      tenant: 'github.com',
    })
  })

  test('projects a committed M365-only process without inventing management actions', async () => {
    const m365 = targetManager(true).getAccountSnapshot().accounts.find(account => account.name === 'm365')!.runtime
    configureAccountRuntimes(compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'm365',
      hostnames: { 'm365.localhost': 'm365' },
    }, []), [m365])
    const app = createDashboardRoutes({ serverPort: 4141 })
    const response = await app.handle(new Request('http://m365.localhost:4141/dashboard/api/targets'))
    const body = await response.json() as DashboardResponse<DashboardTargets>
    expect(body.routing).toEqual({ baseHostname: 'localhost', defaultAccount: 'm365', routingEnabled: true })
    expect(body.capabilities).toMatchObject({ canAddAccount: false, canBootstrap: false, canManageM365: false, canRefreshMetadata: false })
    expect(body.targets).toMatchObject([{
      name: 'm365',
      kind: 'm365',
      identity: 'operator@example.com',
      health: { github: { status: 'not_applicable' } },
      actions: { canSetDefault: false, canRemove: false },
      client: { openAIBaseUrl: 'http://m365.localhost:4141/v1', anthropicBaseUrl: 'http://m365.localhost:4141' },
    }])
    const quota = await app.handle(new Request('http://m365.localhost:4141/dashboard/api/targets/m365/quota'))
    expect(await quota.json()).toMatchObject({ quota: { status: 'not_applicable' } })
  })

  test('reports onboarding unavailable without account management', () => {
    const state = getM365DashboardState()
    expect(state.onboarding).toMatchObject({ status: 'unavailable' })
  })

  test('serves the projection over the dashboard API', async () => {
    const app = createDashboardRoutes({
      accountManager: accountManagerFixture(),
      serverPort: 4141,
    })
    const response = await app.handle(new Request('http://localhost/dashboard/api/m365'))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ registered: false })
  })

  test('reports a managerless process as unavailable over the API', async () => {
    const app = createDashboardRoutes()
    const response = await app.handle(new Request('http://localhost/dashboard/api/m365'))

    expect(await response.json()).toMatchObject({
      onboarding: { status: 'unavailable' },
    })
  })
})
