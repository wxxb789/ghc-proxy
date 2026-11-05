// M365 mutation flows (spec §5.3.4, F§3.9-3.11): endpoint save / custom
// endpoint, register, account select, hostname save and sign-in, all through
// the shared `postM365` helper. Errors stay local to the panel's status lines.
import type { M365EndpointBody, M365Response, MscAccount } from '@contract'
import { api } from './api.ts'
import { applyM365State, probeM365 } from './m365-load.svelte.ts'
import { loadAccounts } from './poller.svelte.ts'
import { app, faultMessage } from './store.svelte.ts'

/** `#m365-endpoint-status`: progress, outcome or the error copied from `#m365-status`. */
export const m365EndpointStatus = $state({ text: '', tone: '' as '' | 'ok' | 'bad' })

/** Which action holds the shared `m365Target` lock, so only its button shows busy. */
export const m365TargetAction = $state({ current: '' as '' | 'endpoint' | 'custom' | 'register' })

const dedup = (values: (string | undefined)[]) => [...new Set(values.filter(Boolean) as string[])]

export const m365OnboardingAvailable = () => app.m365.view?.onboarding.status === 'available'

/** Endpoint select options: server endpoints, the active one and the dirty draft. */
export function m365EndpointOptions(): string[] {
  const view = app.m365.view
  return view ? dedup([...view.endpoints, view.endpoint, app.m365.drafts.endpoint]) : []
}

/** `#m365-register-account` value: the draft while it is a probe account, else the first one (native select default). */
export function m365RegisterAccount(): string {
  const accounts = app.m365.probe?.accounts ?? []
  const draft = app.m365.drafts.registerAccount
  return accounts.some(account => account.homeAccountId === draft) ? draft : accounts[0]?.homeAccountId ?? ''
}

/** `#m365-account` candidates: probe accounts, with the registered account prepended when the probe lacks it. */
export function m365AccountCandidates(): MscAccount[] {
  const view = app.m365.view
  const candidates = [...app.m365.probe?.accounts ?? []]
  const current = view?.account
  if (current && !candidates.some(account => account.homeAccountId === current || account.upn === current))
    candidates.unshift({ homeAccountId: current, upn: view.username || (current.includes('@') ? current : ''), environment: 'broker' })
  return candidates
}

/** `#m365-account` value: the user's choice while it is a candidate, else the registered account. */
export function m365SelectedAccount(candidates: MscAccount[]): string {
  const { drafts, view } = app.m365
  if (candidates.some(account => account.homeAccountId === drafts.account))
    return drafts.account
  return candidates.find(account => account.homeAccountId === view?.account || account.upn === view?.account)?.homeAccountId ?? ''
}

/**
 * Shared mutation helper: `Working…` → POST → `onSaved` → apply the response
 * (forced) → reload accounts (and m365) → `Saved.` unless unavailable. Errors
 * land in `#m365-status`, are swallowed, and the result is `undefined`.
 */
export async function postM365(send: () => Promise<M365Response>, onSaved?: () => void): Promise<M365Response | undefined> {
  app.m365.status = 'Working…'
  app.m365.statusIsError = false
  try {
    const state = await send()
    onSaved?.()
    applyM365State(state, true)
    await loadAccounts()
    if (state.availability?.status !== 'unavailable')
      app.m365.status = 'Saved.'
    return state
  }
  catch (error) {
    app.m365.status = faultMessage(error)
    app.m365.statusIsError = true
  }
}

/** Use endpoint (`custom = false`) or Add and use endpoint. Shares the `m365Target` lock with register. */
export async function saveM365Endpoint(custom: boolean): Promise<void> {
  if (!m365OnboardingAvailable() || app.busy.m365Target)
    return
  const { drafts, dirty } = app.m365
  const endpoint = custom ? drafts.custom.trim() : drafts.endpoint
  const body: M365EndpointBody = custom ? { endpoint, endpoints: dedup([...m365EndpointOptions(), endpoint]) } : { endpoint }
  app.busy.m365Target = true
  m365TargetAction.current = custom ? 'custom' : 'endpoint'
  Object.assign(m365EndpointStatus, { text: 'Saving upstream endpoint…', tone: '' })
  try {
    const state = await postM365(() => api.m365Endpoint(body), () => {
      dirty.endpoint = false
      if (custom)
        drafts.custom = ''
    })
    Object.assign(m365EndpointStatus, state
      ? { text: `Saved upstream endpoint: ${state.endpoint}`, tone: 'ok' }
      : { text: app.m365.status, tone: 'bad' })
  }
  finally {
    app.busy.m365Target = false
    m365TargetAction.current = ''
  }
}

/** Add M365 target. Shares the `m365Target` lock with the endpoint forms. */
export async function registerM365(): Promise<void> {
  if (!m365OnboardingAvailable() || app.busy.m365Target)
    return
  const { drafts, dirty } = app.m365
  app.busy.m365Target = true
  m365TargetAction.current = 'register'
  try {
    await postM365(() => api.m365Register({
      account: m365RegisterAccount() || null,
      hostname: drafts.registerHostname || 'm365.localhost',
      endpoint: drafts.endpoint,
    }), () => dirty.endpoint = false)
  }
  finally {
    app.busy.m365Target = false
    m365TargetAction.current = ''
  }
}

/** Use this account. */
export async function selectM365Account(): Promise<void> {
  if (app.busy.m365Account)
    return
  app.busy.m365Account = true
  try {
    await postM365(() => api.m365Account({ account: m365SelectedAccount(m365AccountCandidates()) || null }))
  }
  finally {
    app.busy.m365Account = false
  }
}

/** Save hostname. The draft stays dirty unless the save succeeds (fixes quirk 8). */
export async function saveM365Hostname(): Promise<void> {
  if (app.busy.m365Hostname)
    return
  app.busy.m365Hostname = true
  try {
    await postM365(() => api.m365Hostname({ hostname: app.m365.drafts.hostname }), () => app.m365.dirty.hostname = false)
  }
  finally {
    app.busy.m365Hostname = false
  }
}

/** Sign in another M365 account: probe again, then preselect the new account in both selects. Nothing is applied. */
export async function signInM365(): Promise<void> {
  if (app.busy.m365SignIn)
    return
  const m365 = app.m365
  app.busy.m365SignIn = true
  m365.readiness = [{ text: 'Complete sign-in in the Windows account dialog…' }]
  try {
    const upn = m365.drafts.signInUpn.trim()
    const { account } = await api.m365SignIn(upn ? { upn } : {})
    await probeM365()
    m365.drafts.registerAccount = m365.drafts.account = account.homeAccountId
    m365.readiness = [{ text: `Signed in as ${account.upn || account.homeAccountId}. Select Add M365 target or Use this account to apply it.` }]
  }
  catch (error) {
    m365.readiness = [{ text: faultMessage(error), tone: 'bad' }]
  }
  finally {
    app.busy.m365SignIn = false
  }
}
