// GitHub device-authorization flow (spec §5.3.3, §8.1.7). The session, the
// lock and the form drafts live at module level, so leaving Accounts and coming
// back shows the same card and a remount can never start a second session.
// The poll timer lives in `timers.deviceAuth`, so `stopAll()` clears it.
import type { AddAccountBody } from '@contract'
import type { StatusLine } from './account-actions.svelte.ts'
import { focusTargets } from './account-actions.svelte.ts'
import { api } from './api.ts'
import { loadAccounts, stopCount } from './poller.svelte.ts'
import { app, clearFault, faultMessage, raiseFault, timers } from './store.svelte.ts'

export const DEVICE_AUTH_POLL_MS = 1000

export const addForm = $state({
  name: '',
  hostname: '',
  gheDomain: '',
  /** The hostname stops mirroring the name once the user edits it; reset clears it. */
  hostnameDirty: false,
  /** `#account-add-status`. */
  status: { text: '', tone: '' } as StatusLine,
  /** Shown after a failed authentication. */
  retryHint: false,
})

/** The session whose card already received focus; a remount must not steal focus again. */
let focusedSession = ''

/** True exactly once per session: the first time its card appears. */
export function claimCardFocus(id: string): boolean {
  if (focusedSession === id)
    return false
  focusedSession = id
  return true
}

/** The verification link, only for `https:` URLs (never `javascript:` and the like). */
export function safeVerificationUri(value: string): string | null {
  try {
    return new URL(value).protocol === 'https:' ? value : null
  }
  catch {
    return null
  }
}

export function resetAddForm(): void {
  Object.assign(addForm, { name: '', hostname: '', gheDomain: '', hostnameDirty: false })
}

function finish(): void {
  clearTimeout(timers.deviceAuth)
  timers.deviceAuth = undefined
  app.deviceAuth.busy = false
}

function schedulePoll(id: string): void {
  clearTimeout(timers.deviceAuth)
  const handle = setTimeout(() => void poll(id, handle), DEVICE_AUTH_POLL_MS)
  timers.deviceAuth = handle
}

/**
 * The fired handle stays in `timers.deviceAuth` while the request is in flight,
 * so `stopAll()` (or a newer session) clearing it also cancels this poll.
 */
async function poll(id: string, handle: typeof timers.deviceAuth): Promise<void> {
  const current = () => timers.deviceAuth === handle && app.deviceAuth.session?.id === id
  let session
  try {
    session = (await api.accountAuth(id)).authentication
  }
  catch (error) {
    if (!current())
      return
    finish()
    addForm.status = { text: faultMessage(error), tone: 'error' }
    raiseFault('accounts', error)
    return
  }
  if (!current())
    return
  app.deviceAuth.session = session
  if (session.state === 'pending') {
    schedulePoll(id)
    return
  }
  finish()
  if (session.state === 'succeeded') {
    addForm.status = { text: 'Account added', tone: 'ok' }
    resetAddForm()
    try {
      await loadAccounts()
    }
    catch (error) {
      raiseFault('accounts', error)
    }
    await focusTargets(session.accountName)
  }
  else {
    addForm.status = { text: 'Authentication failed', tone: 'error' }
    addForm.retryHint = true
  }
}

/** Submit of `#account-add-form`: the body is sent exactly as typed (an empty `gheDomain` included). */
export async function startDeviceAuth(body: Required<AddAccountBody>): Promise<void> {
  if (app.deviceAuth.busy)
    return
  clearTimeout(timers.deviceAuth)
  Object.assign(app.deviceAuth, { busy: true, session: null })
  addForm.retryHint = false
  addForm.status = { text: 'Starting authentication', tone: 'busy' }
  const stops = stopCount()
  try {
    const { authentication } = await api.addAccount(body)
    // A redirect stopped everything while the request was in flight: never start the poll chain.
    if (stops !== stopCount())
      return
    app.deviceAuth.session = authentication
    addForm.status = { text: 'Authorize in GitHub', tone: '' }
    clearFault('accounts')
    schedulePoll(authentication.id)
  }
  catch (error) {
    finish()
    raiseFault('accounts', error)
    addForm.status = { text: `Authentication could not start: ${faultMessage(error)}`, tone: 'error' }
  }
}
