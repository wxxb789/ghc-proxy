// The single owner of Dashboard polling (spec §8.1, §8.2, §10.3): one global
// lock, one pending slot, per-scope settling and the connection state machine.
import type { MetadataRefreshResponse, OverviewResponse } from '@contract'
import type { View } from './router.svelte.ts'
import type { DataScope } from './store.svelte.ts'
import { api, ApiError } from './api.ts'
import { loadM365 } from './m365-load.svelte.ts'
import { router } from './router.svelte.ts'
import { isRestart, pushSample, sampleFrom } from './samples.ts'
import { announce, app, clearFault, effectsBaseline, faultMessage, metadataUnavailableReason, raiseFault, samples, timers } from './store.svelte.ts'

const PRIORITY = { selected: 1, all: 2, metadata: 3 } as const
type Pending = keyof typeof PRIORITY

const ALL_SCOPES: DataScope[] = ['overview', 'accounts', 'models', 'behavior', 'requests']
/** Views whose scope Live also polls; Overview and Models add nothing. */
const LIVE_SCOPES: Partial<Record<View, DataScope>> = { requests: 'requests', behavior: 'behavior', accounts: 'accounts' }

let refreshing = false
let pending: Pending | null = null
/** Bumped by `stopAll()`: work begun before a stop must not start more requests. */
let stops = 0

export const LIVE_INTERVAL_MS = 2000

/** Whether a load or refresh currently holds the global lock. */
export const isRefreshing = () => refreshing
/** Compare before and after an await to learn whether `stopAll()` ran in between. */
export const stopCount = () => stops

function enqueue(kind: Pending): void {
  if (!pending || PRIORITY[kind] >= PRIORITY[pending])
    pending = kind
}

function replay(): void {
  const kind = pending
  pending = null
  if (kind === 'selected')
    void refreshSelectedView(router.view)
  else if (kind === 'all')
    void loadAllViews()
  else if (kind === 'metadata')
    void refreshMetadata()
}

/** Runs `task` under the lock, then replays the pending slot unless `stopAll()` ran meanwhile. */
async function run(task: () => Promise<void>): Promise<void> {
  const started = stops
  refreshing = true
  try {
    await task()
  }
  finally {
    refreshing = false
    if (started === stops)
      replay()
    else
      pending = null
  }
}

function locked(kind: Pending, task: () => Promise<void>): Promise<void> {
  if (refreshing) {
    enqueue(kind)
    return Promise.resolve()
  }
  return run(task)
}

// Loaders commit their own data; `settle` owns the fault store.

async function loadOverview(): Promise<void> {
  const started = performance.now()
  let overview: OverviewResponse
  try {
    overview = await api.overview()
  }
  catch (error) {
    recordConnectionFailure(error)
    throw error
  }
  const now = Date.now()
  const connection = app.connection
  connection.rttMs = Math.round(performance.now() - started)
  if (connection.state === 'lost' || connection.state === 'blocked')
    announce('Connection restored')
  Object.assign(connection, { state: 'connected', failures: 0, lostSince: null, blockedMessage: '', blockedStatus: 0 })

  const sample = sampleFrom(overview, now)
  const previous = app.data.overview
  if (previous && isRestart(previous, sample)) {
    samples.list = []
    samples.first = null
    effectsBaseline.map = null
    app.restartedAt = new Date(now)
    announce(`Proxy restarted at ${app.restartedAt.toLocaleTimeString()}`)
  }
  samples.list = pushSample(samples.list, sample)
  samples.first ??= samples.list[0]!
  app.data.overview = overview
  app.loadedAt.overview = new Date(now)
}

/** Connection state machine (spec §2.5.2). Polling continues unchanged in every state. */
function recordConnectionFailure(error: unknown): void {
  const connection = app.connection
  connection.failures++
  const status = error instanceof ApiError ? error.status : 0
  const wasDown = connection.state === 'lost' || connection.state === 'blocked'
  if (status === 403 || status === 421) {
    Object.assign(connection, { state: 'blocked', blockedStatus: status, blockedMessage: faultMessage(error) })
  }
  else if (!status || connection.failures >= 2) {
    connection.state = 'lost'
    connection.lostSince ??= new Date()
  }
  else {
    connection.state = 'reconnecting'
  }
  if (!wasDown && (connection.state === 'lost' || connection.state === 'blocked'))
    announce('Connection lost')
}

/** GET /accounts (lock-free, also used by mutations), then GET /m365 in `finally`. A 409 means "unavailable", not a fault. */
export async function loadAccounts(): Promise<void> {
  try {
    const accounts = await api.accounts()
    app.data.accounts = accounts
    app.loadedAt.accounts = new Date()
    app.accountsMode = accounts.routingEnabled ? 'routing' : 'legacy'
    if (!accounts.routingEnabled && !accounts.accounts.find(account => account.isDefault)?.hostname)
      throw new Error('Legacy default account is missing its dedicated hostname.')
  }
  catch (error) {
    if (!(error instanceof ApiError && error.status === 409))
      throw error
    app.accountsMode = 'unavailable'
    app.data.accounts = null
    app.loadedAt.accounts = new Date()
  }
  finally {
    await loadM365()
  }
}

async function loadModels(): Promise<void> {
  app.data.models = await api.models()
  app.loadedAt.models = new Date()
}

async function loadBehavior(): Promise<void> {
  const behavior = await api.behavior()
  effectsBaseline.map ??= new Map(behavior.effects.map(effect => [effect.id, effect.count]))
  app.data.behavior = behavior
  app.loadedAt.behavior = new Date()
}

async function loadRequests(): Promise<void> {
  app.data.requests = await api.requests()
  app.loadedAt.requests = new Date()
}

const LOADERS: Record<DataScope, () => Promise<void>> = {
  overview: loadOverview,
  accounts: loadAccounts,
  models: loadModels,
  behavior: loadBehavior,
  requests: loadRequests,
}

/** `Promise.allSettled` over the scopes; each commits independently (data, `loadedAt`, fault). */
async function settle(scopes: DataScope[]): Promise<void> {
  const results = await Promise.allSettled(scopes.map(scope => LOADERS[scope]()))
  results.forEach((result, index) => {
    const scope = scopes[index]!
    if (result.status === 'rejected')
      raiseFault(scope, result.reason)
    else
      clearFault(scope)
  })
}

/** Initial load and post-mutation reload: every view's scope under the lock. */
export function loadAllViews(): Promise<void> {
  return locked('all', () => settle(ALL_SCOPES))
}

/** View entry: that view's scope under the lock, or the `selected` slot (replayed with the view active then). */
export function refreshSelectedView(view: View): Promise<void> {
  return locked('selected', () => settle([view]))
}

/** Live tick: dropped (never queued) when Live is off, the tab is hidden or the lock is held. */
export function liveTick(): Promise<void> {
  if (!app.live || document.hidden || refreshing)
    return Promise.resolve()
  const scope = LIVE_SCOPES[router.view]
  return run(() => settle(scope ? ['overview', scope] : ['overview']))
}

/** Retry for one scope; never lost while the lock is held (spec §8.1.5). */
export function retryScope(scope: DataScope | 'metadata'): Promise<void> {
  if (scope === 'metadata')
    return refreshMetadata()
  if (scope === router.view)
    return refreshSelectedView(router.view)
  if (refreshing) {
    enqueue('all')
    return Promise.resolve()
  }
  return run(() => settle([scope]))
}

export function metadataFailureMessage(result: MetadataRefreshResponse): string {
  const failures = result.accounts.flatMap(account => (['github', 'models', 'quota'] as const)
    .filter(field => account[field].status === 'stale' || account[field].status === 'unavailable')
    .map(field => `${account.name}: ${field} (${account[field].status})`))
  return `Metadata refresh incomplete${failures.length ? `: ${failures.join('; ')}` : '.'}`
}

/** POST /refresh, then reload every view. Never triggered by polling or shortcuts (spec §8.2). */
export async function refreshMetadata(): Promise<void> {
  if (refreshing) {
    enqueue('metadata')
    return
  }
  if (metadataUnavailableReason())
    return
  app.busy.metadata = true
  await run(async () => {
    try {
      const result = await api.refreshMetadata()
      if (result.status === 'ok')
        clearFault('metadata')
      else
        raiseFault('metadata', new Error(metadataFailureMessage(result)))
      await settle(ALL_SCOPES)
    }
    catch (error) {
      raiseFault('metadata', error)
    }
    finally {
      app.busy.metadata = false
    }
  })
}

function onVisibilityChange(): void {
  if (!document.hidden)
    void liveTick()
}

/** Initial 6-GET load, then the Live interval and the visibility listener. */
export function startPolling(): Promise<void> {
  const initial = loadAllViews()
  clearInterval(timers.live)
  timers.live = setInterval(() => void liveTick(), LIVE_INTERVAL_MS)
  document.addEventListener('visibilitychange', onVisibilityChange)
  return initial
}

/** Stops Live, the device-auth timer and queued reloads. A redirect calls this before `location.replace`. */
export function stopAll(): void {
  stops++
  pending = null
  clearInterval(timers.live)
  clearTimeout(timers.deviceAuth)
  timers.live = undefined
  timers.deviceAuth = undefined
  document.removeEventListener('visibilitychange', onVisibilityChange)
}
