import type { DashboardAccountManagement } from '~/routes/dashboard/route'

import type { CopilotUsageResponse } from '~/types'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { Elysia } from 'elysia'
import { DashboardQuotaCache, dashboardQuotaCache } from '~/routes/dashboard/handler'
import { createDashboardRoutes, isLoopbackAddress } from '~/routes/dashboard/route'
import { createServer } from '~/server'
import { authStore, runtimeStore } from '~/state'

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
    expect(html).toContain('Models')
    expect(html).toContain('Behavior')
    expect(html).toContain('Requests')
    expect(html).toContain('id="theme-toggle"')
    expect(html).toContain('role="switch"')
    expect(html).toContain('id="model-group-vendor"')
    expect(html).toContain('id="model-sort"')
    expect(html).toContain('id="copy-models"')

    expect(cssResponse.headers.get('content-type')).toContain('text/css')
    expect(jsResponse.headers.get('content-type')).toContain('text/javascript')
    const js = await jsResponse.text()
    expect(js).toContain('ghc-proxy-dashboard-theme')
    expect(js).toContain('prefers-color-scheme: dark')
    expect(js).toContain('window.location.origin + \'/v1\'')
    expect(js).toContain('\'Model ID\', \'Model Name\', \'Vendor\', \'Version\'')
    expect(js).toContain('[\'Endpoint: \' + localEndpoint, headers.join(\'\\t\')]')
    expect(js).toContain('navigator.clipboard?.writeText')
    expect(js).not.toContain('innerHTML')
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

    expect(invalid.status).toBe(400)
    expect(missing.status).toBe(404)
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

function accountManagerFixture(): DashboardAccountManagement & {
  beginAddAccount: ReturnType<typeof mock>
  setDefaultAccount: ReturnType<typeof mock>
} {
  return {
    listAccounts: async () => [{
      name: 'default',
      hostname: 'default.localhost',
      isDefault: true,
      tenant: 'github.com',
      github: { status: 'ok', login: 'octocat' },
      copilot: { status: 'ok', modelsLoaded: true },
      quota: { status: 'unavailable' },
      githubToken: undefined,
      copilotToken: undefined,
    }],
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
    setDefaultAccount: mock(async () => {}),
  }
}
