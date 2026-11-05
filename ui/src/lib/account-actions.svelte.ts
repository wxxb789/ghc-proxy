// Accounts mutations (spec §8.3): Set default, Remove (any target, incl. `m365`)
// and Bootstrap. Busy flags live in the app store; outcome lines live here so a
// remount shows the same text. The server is authoritative: every mutation reloads.
import { tick } from 'svelte'
import { api } from './api.ts'
import { confirm } from './confirm.svelte.ts'
import { loadAccounts, loadAllViews } from './poller.svelte.ts'
import { redirectToBase } from './redirect.ts'
import { app, clearFault, faultMessage, raiseFault } from './store.svelte.ts'

export type StatusTone = 'ok' | 'error' | 'busy' | ''
export interface StatusLine { text: string, tone: StatusTone }

/** The page location the redirect leaves from; tests swap in a Location-like object. */
export const page = { location: globalThis.location as Pick<Location, 'href' | 'replace'> }

export const accountsUi = $state({
  /** `#accounts-status`: Set default / Remove outcomes. */
  status: { text: '', tone: '' } as StatusLine,
  /** `#account-bootstrap-status`: progress and errors only. */
  bootstrapStatus: { text: '', tone: '' } as StatusLine,
  /** `#account-bootstrap-hostname` draft; survives re-renders and remounts. */
  bootstrapHostname: '',
})

/** `<protocol>//<hostname>[:port]` on this page's protocol and port. */
export function clientBaseUrl(hostname: string): string {
  const url = new URL(page.location.href)
  return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}`
}

/** Moves focus to the Targets h2 or a target's name cell once it renders. */
export async function focusTargets(name?: string): Promise<void> {
  await tick()
  document.getElementById(name ? `target-${name}` : 'targets-h')?.focus()
}

export async function setDefault(name: string): Promise<void> {
  if (app.accountBusy[name])
    return
  app.accountBusy[name] = 'default'
  accountsUi.status = { text: 'Setting default…', tone: 'busy' }
  try {
    await api.setDefault({ accountName: name })
    await loadAccounts()
    clearFault('accounts')
    accountsUi.status = { text: `Default account is now ${name}.`, tone: 'ok' }
  }
  catch (error) {
    raiseFault('accounts', error)
    accountsUi.status = { text: `Couldn't set the default account: ${faultMessage(error)}`, tone: 'error' }
  }
  finally {
    delete app.accountBusy[name]
  }
}

/**
 * Shared remove flow for any target, including `m365`: confirm dialog, busy
 * flag, DELETE, then redirect (when the removed hostname serves this page) or
 * reload all views, and the `#accounts-status` outcome.
 */
export async function removeTarget(target: { name: string, hostname: string }): Promise<void> {
  const { name, hostname } = target
  if (app.accountBusy[name])
    return
  const confirmed = await confirm({
    title: `Remove ${name}`,
    body: `Remove ${name} from ghc-proxy? This removes proxy configuration, not the upstream or Windows account.`,
    confirmLabel: 'Remove',
  })
  if (!confirmed)
    return
  app.accountBusy[name] = 'remove'
  accountsUi.status = { text: `Removing ${name}…`, tone: 'busy' }
  try {
    const summary = await api.removeAccount(name)
    clearFault('accounts')
    // The removed origin can no longer serve the Dashboard: leave for the base hostname.
    // An unexpected base hostname raises the fault instead; this origin now answers 421, so nothing reloads.
    if (hostname === new URL(page.location.href).hostname) {
      if (!redirectToBase(summary.baseHostname, page.location))
        accountsUi.status = { text: `Removed ${name}.`, tone: 'ok' }
      return
    }
    await loadAllViews()
    accountsUi.status = { text: `Removed ${name}.`, tone: 'ok' }
    await focusTargets()
  }
  catch (error) {
    raiseFault('accounts', error)
    accountsUi.status = { text: `Couldn't remove ${name}: ${faultMessage(error)}`, tone: 'error' }
  }
  finally {
    delete app.accountBusy[name]
  }
}

/** Enables named-account routing with the hostname exactly as typed, then reopens on the base hostname. */
export async function bootstrapRouting(hostname: string): Promise<void> {
  if (app.busy.bootstrap)
    return
  app.busy.bootstrap = true
  accountsUi.bootstrapStatus = { text: 'Enabling named accounts', tone: 'busy' }
  try {
    const summary = await api.bootstrap({ hostname })
    clearFault('accounts')
    accountsUi.bootstrapStatus = { text: '', tone: '' }
    redirectToBase(summary.baseHostname, page.location)
  }
  catch (error) {
    raiseFault('accounts', error)
    accountsUi.bootstrapStatus = { text: `Named accounts could not be enabled: ${faultMessage(error)}`, tone: 'error' }
  }
  finally {
    app.busy.bootstrap = false
  }
}
