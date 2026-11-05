// M365 data loading only: GET /m365 with snapshot de-duplication, the
// once-per-lifecycle auto-probe and the shared probe flow. Mutations, sign-in
// and form flows build on these hooks (spec §5.3.4, §8.1.4).
import type { M365DashboardState, M365ProbeResponse } from '@contract'
import type { ReadinessLine } from './store.svelte.ts'
import { api } from './api.ts'
import { router } from './router.svelte.ts'
import { app, faultMessage } from './store.svelte.ts'

/** Snapshot of everything the panel renders; `availability.updatedAt` is excluded on purpose. */
export function m365SnapshotKey(state: M365DashboardState): string {
  return JSON.stringify([
    state.registered,
    state.hostname,
    state.endpoint,
    state.endpoints,
    state.account,
    state.username,
    state.tenant,
    state.tokenExpiresAt,
    state.modelCount,
    state.models,
    state.availability && { status: state.availability.status, cause: state.availability.cause },
    state.routing,
    state.client,
    state.onboarding,
  ])
}

/** `#m365-status` text for a freshly applied state. */
export function m365StatusText(state: M365DashboardState): string {
  if (!state.registered) {
    return state.onboarding.status === 'available'
      ? 'Not added.'
      : state.onboarding.reason || 'Onboarding is unavailable for this process.'
  }
  return state.availability?.status === 'unavailable' ? state.availability.cause || 'The target is unavailable.' : 'Ready.'
}

/** Reseeds form drafts from server state; dirty drafts are left alone. */
export function reseedM365Drafts(state: M365DashboardState): void {
  const { drafts, dirty } = app.m365
  if (!dirty.endpoint)
    drafts.endpoint = state.endpoint
  if (!dirty.hostname)
    drafts.hostname = state.hostname ?? ''
  drafts.registerHostname ||= 'm365.localhost'
}

/**
 * Applies a state to the panel when its snapshot changed (or when `force`d,
 * as after a mutation response). Returns whether the view was replaced.
 */
export function applyM365State(state: M365DashboardState, force = false): boolean {
  const key = m365SnapshotKey(state)
  if (!force && key === app.m365.snapshotKey)
    return false
  app.m365.snapshotKey = key
  app.m365.view = state
  app.m365.status = m365StatusText(state)
  app.m365.statusIsError = false
  reseedM365Drafts(state)
  return true
}

/** GET /m365. Errors go to `#m365-status` only; they never enter the fault store. */
export async function loadM365(): Promise<void> {
  let state: M365DashboardState
  try {
    state = await api.m365()
  }
  catch (error) {
    app.m365.snapshotKey = ''
    app.m365.status = faultMessage(error)
    app.m365.statusIsError = true
    return
  }
  app.data.m365 = state
  app.loadedAt.m365 = new Date()
  applyM365State(state)
  await maybeAutoProbe()
}

/** The one POST outside user action: at most once per page lifecycle, on Accounts, when onboarding is available. */
async function maybeAutoProbe(): Promise<void> {
  if (!app.m365.probeStarted && router.view === 'accounts' && app.data.m365?.onboarding.status === 'available')
    await probeM365()
}

export function readinessLines(result: M365ProbeResponse): ReadinessLine[] {
  const failed = result.failedStep
  const lines: ReadinessLine[] = [
    { text: `Windows platform: ${result.platformSupported ? 'ok' : 'required'}`, tone: result.platformSupported && failed !== 'platform' ? 'ok' : 'bad' },
    { text: `msc-auth helper: ${result.helperAvailable ? 'found' : 'not found'}`, tone: result.helperAvailable && failed !== 'helper' ? 'ok' : 'bad' },
  ]
  if (result.accountCount !== undefined)
    lines.push({ text: `Broker accounts: ${result.accountCount}`, tone: failed === 'accounts' ? 'bad' : undefined })
  if (result.error)
    lines.push({ text: result.error, tone: 'bad' })
  return lines
}

/** Check prerequisites / Refresh broker accounts (shared `m365Probe` busy flag). */
export async function probeM365(): Promise<void> {
  if (app.busy.m365Probe)
    return
  app.m365.probeStarted = true
  app.busy.m365Probe = true
  app.m365.readiness = [{ text: 'Checking prerequisites…' }]
  try {
    const result = await api.m365Probe()
    app.m365.probe = result
    app.m365.readiness = readinessLines(result)
    if (result.accounts?.length)
      app.m365.drafts.registerHostname ||= 'm365.localhost'
    // Re-apply so the registered view picks up the new broker accounts.
    app.m365.snapshotKey = ''
    await loadM365()
  }
  catch (error) {
    app.m365.readiness = [{ text: faultMessage(error), tone: 'bad' }]
  }
  finally {
    app.busy.m365Probe = false
  }
}
