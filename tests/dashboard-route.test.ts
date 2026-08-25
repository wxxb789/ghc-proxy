import type { CopilotUsageResponse } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
