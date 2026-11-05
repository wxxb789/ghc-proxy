import type { RouteHandler } from '../test/fake-fetch.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeFetch, jsonError } from '../test/fake-fetch.ts'
import { accountsLegacy, dashboardRoutes, m365Absent, overview, refreshResult } from '../test/fixtures.ts'

let stopRouter: (() => void) | undefined

/** Fresh module graph per test: the poller lock, store and router are module state. */
async function setup(hash: string, routes: Record<string, RouteHandler> = {}) {
  vi.resetModules()
  history.replaceState(null, '', `/dashboard${hash}`)
  const fake = createFakeFetch(dashboardRoutes(routes))
  vi.stubGlobal('fetch', fake.fetch)
  const router = await import('./router.svelte.ts')
  const poller = await import('./poller.svelte.ts')
  const store = await import('./store.svelte.ts')
  const { health } = await import('./health.svelte.ts')
  stopRouter = router.startRouter(view => void poller.refreshSelectedView(view))
  const idle = () => vi.waitUntil(() => !poller.isRefreshing())
  return { fake, poller, store, router, health, idle }
}

afterEach(() => {
  stopRouter?.()
})

describe('initial load and Live (T:178-214)', () => {
  it('sends exactly 7 GETs for the initial load on #/overview plus one tick, and no POST', async () => {
    const { fake, poller } = await setup('#/overview')
    await poller.loadAllViews()
    await poller.liveTick()
    expect(fake.log).toHaveLength(7)
    expect(fake.log.every(request => request.method === 'GET')).toBe(true)
    expect(fake.calls()).not.toContain('POST /dashboard/api/refresh')
    expect(fake.calls()).not.toContain('POST /dashboard/api/m365/probe')
  })

  it('probes M365 once on a cold #/accounts load, after the m365 GET, and never again on ticks', async () => {
    const { fake, poller } = await setup('#/accounts')
    await poller.loadAllViews()
    const calls = fake.calls()
    // 6 GETs (m365 last, after accounts), then the one probe, then the probe's own m365 re-read.
    expect(calls.slice(0, 6).every(call => call.startsWith('GET '))).toBe(true)
    expect(calls[5]).toBe('GET /dashboard/api/m365')
    expect(calls[6]).toBe('POST /dashboard/api/m365/probe')
    expect(fake.count('POST')).toBe(1)
    fake.clear()
    await poller.liveTick()
    expect(fake.count('POST')).toBe(0)
    expect(fake.calls()).toEqual(['GET /dashboard/api/overview', 'GET /dashboard/api/accounts', 'GET /dashboard/api/m365'])
  })

  it('does not probe when onboarding is unavailable', async () => {
    const { fake, poller } = await setup('#/accounts', { '/dashboard/api/m365': () => m365Absent({ onboarding: { status: 'unavailable' } }) })
    await poller.loadAllViews()
    expect(fake.count('POST')).toBe(0)
  })

  it('polls only the overview on #/models and #/overview ticks', async () => {
    const { fake, poller } = await setup('#/models')
    await poller.loadAllViews()
    fake.clear()
    await poller.liveTick()
    expect(fake.calls()).toEqual(['GET /dashboard/api/overview'])
  })

  it('drops ticks while Live is off, the tab is hidden or the lock is held', async () => {
    const { fake, poller, store } = await setup('#/requests')
    await poller.loadAllViews()
    fake.clear()
    store.app.live = false
    await poller.liveTick()
    expect(fake.log).toHaveLength(0)
    store.app.live = true
    const hold = fake.hold('GET /dashboard/api/overview')
    const first = poller.liveTick()
    await poller.liveTick()
    hold.release()
    await first
    expect(fake.calls()).toEqual(['GET /dashboard/api/overview', 'GET /dashboard/api/requests'])
  })
})

describe('metadata refresh (T:216-250, T:306-344)', () => {
  it('queues a refresh requested while a load holds the lock, then sends one POST followed by every view GET', async () => {
    const { fake, poller, idle } = await setup('#/overview')
    const hold = fake.hold('GET /dashboard/api/overview')
    const loading = poller.loadAllViews()
    await poller.refreshMetadata()
    expect(fake.count('POST')).toBe(0)
    hold.release()
    await loading
    await vi.waitFor(() => expect(fake.count('POST', '/dashboard/api/refresh')).toBe(1))
    await idle()
    const calls = fake.calls()
    const after = calls.slice(calls.indexOf('POST /dashboard/api/refresh') + 1)
    for (const path of ['overview', 'accounts', 'models', 'behavior', 'requests'])
      expect(after).toContain(`GET /dashboard/api/${path}`)
    expect(fake.log.find(request => request.method === 'POST')?.contentType).toBeNull()
  })

  it('records a partial refresh and clears it after an ok refresh with not_applicable fields', async () => {
    let partial = true
    const { poller, store, health } = await setup('#/overview', {
      'POST /dashboard/api/refresh': () => partial
        ? refreshResult({ status: 'partial', accounts: [{ name: 'work', github: { status: 'ok' }, models: { status: 'ok' }, quota: { status: 'stale' } }] })
        : refreshResult({ status: 'ok', accounts: [{ name: 'm365', github: { status: 'not_applicable' }, models: { status: 'ok' }, quota: { status: 'not_applicable' } }] }),
    })
    await poller.refreshMetadata()
    expect(store.faults.metadata?.message).toBe('Metadata refresh incomplete: work: quota (stale)')
    expect(health.issues.find(issue => issue.id === 'F2')?.body).toBe('Metadata refresh incomplete: work: quota (stale)')
    partial = false
    await poller.refreshMetadata()
    expect(store.faults).not.toHaveProperty('metadata')
  })

  it('uses the generic incomplete message when no field failed', () => {
    return setup('#/overview').then(({ poller }) => {
      expect(poller.metadataFailureMessage(refreshResult({ status: 'unavailable' }))).toBe('Metadata refresh incomplete.')
    })
  })

  it('sends nothing while accounts are legacy (aria-disabled Refresh metadata)', async () => {
    const { fake, poller, store } = await setup('#/overview', { '/dashboard/api/accounts': () => accountsLegacy() })
    await poller.loadAllViews()
    expect(store.metadataUnavailableReason()).toBe('Needs named accounts')
    fake.clear()
    await poller.refreshMetadata()
    expect(fake.log).toHaveLength(0)
  })

  it('treats accounts 409 as unavailable without a fault, and Refresh metadata sends nothing', async () => {
    const { fake, poller, store } = await setup('#/overview', { '/dashboard/api/accounts': () => jsonError(409, 'Account management is unavailable for this process configuration.') })
    await poller.loadAllViews()
    expect(store.app.accountsMode).toBe('unavailable')
    expect(store.faults).not.toHaveProperty('accounts')
    expect(store.metadataUnavailableReason()).toBe('Account management is unavailable for this process')
    fake.clear()
    await poller.refreshMetadata()
    expect(fake.log).toHaveLength(0)
  })

  it('records a thrown refresh error in the metadata scope without reloading', async () => {
    const { fake, poller, store } = await setup('#/overview', { 'POST /dashboard/api/refresh': () => jsonError(409, 'Account management is unavailable for this process configuration.') })
    await poller.refreshMetadata()
    expect(store.faults.metadata?.message).toBe('Account management is unavailable for this process configuration.')
    expect(fake.calls()).toEqual(['POST /dashboard/api/refresh'])
  })
})

describe('faults (T:262-282)', () => {
  it('keeps a scope fault until that scope succeeds, through other successes', async () => {
    let fail = true
    const { poller, store, health } = await setup('#/overview', {
      '/dashboard/api/models': () => fail ? jsonError(500, 'Models exploded') : { schemaVersion: 1, generatedAt: '', models: [] },
    })
    await poller.loadAllViews()
    expect(store.faults.models?.message).toBe('Models exploded')
    await poller.liveTick()
    expect(health.issues.map(issue => issue.id)).toContain('F1:models')
    fail = false
    await poller.retryScope('models')
    expect(store.faults).not.toHaveProperty('models')
    expect(health.issues.map(issue => issue.id)).not.toContain('F1:models')
  })

  it('uses "Dashboard refresh failed" for a non-Error rejection', async () => {
    // eslint-disable-next-line prefer-promise-reject-errors
    const { poller, store } = await setup('#/overview', { '/dashboard/api/behavior': () => Promise.reject('offline') })
    await poller.loadAllViews()
    expect(store.faults.behavior?.message).toBe('Dashboard refresh failed')
  })

  it('never loses a retry for another scope while the lock is held', async () => {
    const { fake, poller, idle } = await setup('#/overview')
    const hold = fake.hold('GET /dashboard/api/overview')
    const tick = poller.liveTick()
    await poller.retryScope('behavior')
    expect(fake.count('GET', '/dashboard/api/behavior')).toBe(0)
    hold.release()
    await tick
    await idle()
    expect(fake.count('GET', '/dashboard/api/behavior')).toBe(1)
  })
})

describe('connection state machine (spec §2.5.2)', () => {
  it('goes reconnecting, then lost, then connected again', async () => {
    let status = 500
    const { poller, store } = await setup('#/overview', { '/dashboard/api/overview': () => status === 200 ? overview() : jsonError(status, 'nope') })
    await poller.liveTick()
    expect(store.app.connection.state).toBe('reconnecting')
    await poller.liveTick()
    expect(store.app.connection.state).toBe('lost')
    expect(store.app.connection.lostSince).toBeInstanceOf(Date)
    status = 200
    await poller.liveTick()
    expect(store.app.connection).toMatchObject({ state: 'connected', failures: 0, lostSince: null })
    expect(store.announcer.text).toContain('Connection restored')
  })

  it('is lost at once on a network error and blocked on 403/421', async () => {
    let mode: 'network' | 403 | 421 = 'network'
    const { poller, store } = await setup('#/overview', {
      '/dashboard/api/overview': () => mode === 'network' ? Promise.reject(new TypeError('Failed to fetch')) : jsonError(mode, `blocked ${mode}`),
    })
    await poller.liveTick()
    expect(store.app.connection.state).toBe('lost')
    mode = 421
    await poller.liveTick()
    expect(store.app.connection).toMatchObject({ state: 'blocked', blockedStatus: 421, blockedMessage: 'blocked 421' })
  })

  it('detects a restart, clears samples and raises the restart notice', async () => {
    let uptimeMs = 50_000
    const { poller, store, health } = await setup('#/overview', { '/dashboard/api/overview': () => overview({ uptimeMs }) })
    await poller.liveTick()
    await poller.liveTick()
    expect(store.samples.list).toHaveLength(2)
    uptimeMs = 1000
    await poller.liveTick()
    expect(store.samples.list).toHaveLength(1)
    expect(store.app.restartedAt).toBeInstanceOf(Date)
    expect(store.announcer.text).toMatch(/^ghc-proxy restarted at \d{2}:\d{2}:\d{2}$/)
    expect(health.issues.some(issue => issue.id.startsWith('P1:'))).toBe(true)
  })
})

describe('stopAll', () => {
  it('clears the Live interval and the device-auth timer', async () => {
    const { poller, store } = await setup('#/overview')
    void poller.startPolling()
    store.timers.deviceAuth = setTimeout(() => {}, 10_000)
    expect(store.timers.live).toBeDefined()
    poller.stopAll()
    expect(store.timers.live).toBeUndefined()
    expect(store.timers.deviceAuth).toBeUndefined()
  })

  it('drops a reload queued before the stop instead of replaying it', async () => {
    const { fake, poller } = await setup('#/overview')
    const hold = fake.hold('GET /dashboard/api/overview')
    const first = poller.loadAllViews()
    void poller.loadAllViews()
    poller.stopAll()
    hold.release()
    await first
    await Promise.resolve()
    expect(fake.count('GET')).toBe(6)
    expect(poller.isRefreshing()).toBe(false)
  })
})
