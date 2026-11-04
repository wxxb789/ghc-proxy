import type { StateSnapshot } from './helpers'
import type { DashboardMetrics, DashboardResponse, DashboardTargets } from '~/types/dashboard'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { DashboardQuotaCache } from '~/routes/dashboard/quota'
import { createDashboardRoutes } from '~/routes/dashboard/route'
import { createServer } from '~/server'
import { authStore, resetAccountRuntimes, runtimeStore } from '~/state'

import { restoreStateSnapshot, saveStateSnapshot, setupDefaultTestState } from './helpers'

let snapshot: StateSnapshot

beforeEach(() => {
  snapshot = saveStateSnapshot()
  setupDefaultTestState()
  runtimeStore.requests.reset()
})

afterEach(() => {
  runtimeStore.requests.reset()
  resetAccountRuntimes()
  restoreStateSnapshot(snapshot)
})

describe('Dashboard window projections', () => {
  test('filters terminal-state counts without changing the retained observations', async () => {
    runtimeStore.requests.start({ requestId: 'github-ok', accountName: 'work', method: 'POST', endpoint: '/v1/messages', requestedModel: 'claude-sonnet-4.5' })
    runtimeStore.requests.complete('github-ok', 200)
    runtimeStore.requests.start({ requestId: 'm365-failed', accountName: 'm365', method: 'POST', endpoint: '/v1/messages', requestedModel: 'claude-opus-5.5' })
    runtimeStore.requests.complete('m365-failed', 503)
    const before = runtimeStore.requests.snapshot()
    const app = createServer()

    for (const window of ['15m', '1h', '24h']) {
      const response = await app.handle(new Request(`http://localhost/dashboard/api/metrics?window=${window}`))
      expect(response.status).toBe(200)
      const body = await response.json() as DashboardResponse<DashboardMetrics>
      expect(body.counts).toEqual({ completed: 1, failed: 1, aborted: 0 })
      expect(body.latency.count).toBe(1)
      expect(body.latency.histogram.reduce((sum, count) => sum + count, 0)).toBe(1)
      expect(body.series.reduce((sum, bucket) => sum + bucket.counts.failed, 0)).toBe(1)
      expect(body.startedAt).toBe(runtimeStore.startedAt)
      expect(Date.parse(body.collectionStartedAt)).toBeLessThanOrEqual(Date.parse(body.generatedAt))
    }

    const m365 = await app.handle(new Request('http://localhost/dashboard/api/metrics?window=1h&target=m365'))
    expect((await m365.json() as DashboardMetrics).counts).toEqual({ completed: 0, failed: 1, aborted: 0 })
    const absent = await app.handle(new Request('http://localhost/dashboard/api/metrics?window=1h&target=absent'))
    expect((await absent.json() as DashboardMetrics).counts).toEqual({ completed: 0, failed: 0, aborted: 0 })
    expect((await app.handle(new Request('http://localhost/dashboard/api/metrics?window=2h'))).status).toBe(400)
    expect(runtimeStore.requests.snapshot().recent).toEqual(before.recent)
  })

  test('keeps target health local and isolates quota failure from other reads', async () => {
    authStore.githubToken = 'private-test-token'
    let quotaLoads = 0
    const quotaCache = new DashboardQuotaCache(async () => {
      quotaLoads++
      throw new Error('quota failed with private remote diagnostics')
    })
    const app = createDashboardRoutes({ quotaCache, serverPort: 4141 })
    const targetsResponse = await app.handle(new Request('http://localhost/dashboard/api/targets'))
    expect(targetsResponse.status).toBe(200)
    const targets = await targetsResponse.json() as DashboardResponse<DashboardTargets>
    expect(targets.targets[0]).toMatchObject({ name: 'default', kind: 'github', actions: { canSetDefault: false, canRemove: false } })
    expect(targets.capabilities).toMatchObject({ canAddAccount: false, canBootstrap: false, canRefreshMetadata: false })
    expect(targets.targets[0]?.client).toMatchObject({ openAIBaseUrl: 'http://localhost:4141/v1', anthropicBaseUrl: 'http://localhost:4141' })
    expect((await app.handle(new Request('http://localhost/dashboard/api/overview'))).status).toBe(200)
    expect(quotaLoads).toBe(0)

    const quota = await app.handle(new Request('http://localhost/dashboard/api/targets/default/quota'))
    expect(quota.status).toBe(200)
    expect(await quota.json()).toMatchObject({ target: 'default', runtimeId: targets.targets[0]?.runtimeId, quota: { status: 'unavailable' } })
    expect(quotaLoads).toBe(1)
    expect((await app.handle(new Request('http://localhost/dashboard/api/targets'))).status).toBe(200)
    expect((await app.handle(new Request('http://localhost/dashboard/api/overview'))).status).toBe(200)
  })

  test('excludes each Dashboard read from both the ring and metrics', async () => {
    authStore.githubToken = undefined
    const app = createServer()
    const paths = ['metrics?window=15m', 'targets', 'overview', 'requests', 'targets/default/quota', 'behavior?window=15m']
    for (const path of paths) {
      const response = await app.handle(new Request(`http://localhost/dashboard/api/${path}`))
      expect(response.status).toBe(200)
      await response.text()
    }
    expect(runtimeStore.requests.snapshot()).toMatchObject({ active: [], recent: [], totals: { started: 0, completed: 0, failed: 0, aborted: 0 } })
    expect(runtimeStore.requests.queryMetrics('15m').counts).toEqual({ completed: 0, failed: 0, aborted: 0 })
  })
})
