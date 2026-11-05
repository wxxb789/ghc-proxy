// Accounts view test helpers: module-state reset, a Location-like spy and the render harness.
import type { AccountAuthenticationSession, RoutingSummaryResponse } from '@contract'
import type { RouteHandler } from './fake-fetch.ts'
import { render } from '@testing-library/svelte'
import { tick } from 'svelte'
import { vi } from 'vitest'
import ConfirmDialog from '../components/ConfirmDialog.svelte'
import { accountsUi, page } from '../lib/account-actions.svelte.ts'
import { addForm, resetAddForm } from '../lib/device-auth.svelte.ts'
import { loadAccounts } from '../lib/poller.svelte.ts'
import { app, timers } from '../lib/store.svelte.ts'
import Accounts from '../views/Accounts.svelte'
import { createFakeFetch } from './fake-fetch.ts'
import { clearFaults, dashboardRoutes } from './fixtures.ts'

export function routingSummary(overrides: Partial<RoutingSummaryResponse> = {}): RoutingSummaryResponse {
  return { schemaVersion: 1, generatedAt: '2026-11-05T14:02:11.000Z', baseHostname: 'localhost', defaultAccount: 'personal', routingEnabled: true, ...overrides }
}

export function authSession(overrides: Partial<AccountAuthenticationSession> = {}): AccountAuthenticationSession {
  return {
    id: 'auth-1',
    state: 'pending',
    accountName: 'team',
    hostname: 'team.localhost',
    authorization: { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: new Date(Date.now() + 900_000).toISOString(), pollIntervalSeconds: 5 },
    ...overrides,
  }
}

/** Resets every piece of module state the Accounts view reads or owns. */
export function resetAccountsState(): void {
  clearFaults()
  clearInterval(timers.live)
  clearTimeout(timers.deviceAuth)
  timers.live = undefined
  timers.deviceAuth = undefined
  app.data.accounts = null
  app.data.m365 = null
  app.loadedAt.accounts = null
  app.loadedAt.m365 = null
  app.accountsMode = 'unknown'
  app.accountBusy = {}
  app.busy.bootstrap = false
  app.bootstrapSuggested = ''
  app.ui.detailsOpen.length = 0
  // The view tests never exercise the M365 auto-probe.
  app.m365.probeStarted = true
  Object.assign(app.deviceAuth, { busy: false, session: null })
  accountsUi.status = { text: '', tone: '' }
  accountsUi.bootstrapStatus = { text: 'The current account remains the default.', tone: '' }
  accountsUi.bootstrapHostname = ''
  resetAddForm()
  addForm.status = { text: '', tone: '' }
  addForm.retryHint = false
  page.location = location
}

/** A Location-like object that records `replace` and whether Live and the auth timer were stopped first. */
export function spyLocation(href: string) {
  const events: string[] = []
  return {
    events,
    location: {
      href,
      replace(url: string) {
        events.push(`stopped=${timers.live === undefined && timers.deviceAuth === undefined}`, `replace ${url}`)
      },
    },
  }
}

/** Installs the fake fetch, renders Accounts plus the confirm host and loads accounts once. */
export async function renderAccounts(routes: Record<string, RouteHandler> = {}) {
  const fake = createFakeFetch(dashboardRoutes(routes))
  vi.stubGlobal('fetch', fake.fetch)
  const view = render(Accounts)
  render(ConfirmDialog)
  await loadAccounts()
  await tick()
  return { fake, view }
}
