import { stopAll } from './poller.svelte.ts'
import { raiseFault } from './store.svelte.ts'

const LOOPBACK_HOST_RE = /^(?:localhost|(?:[a-z0-9-]+\.)+localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i

/** Hostnames the Dashboard may redirect to or link at: loopback and `*.localhost`. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOST_RE.test(hostname)
}

/** `<protocol>//<hostname>:<same port>/dashboard#/accounts`, the landing page after bootstrap or self-removal. */
export function baseDashboardUrl(hostname: string, href: string): string {
  const url = new URL('/dashboard', href)
  url.hostname = hostname === '::1' ? '[::1]' : hostname
  url.hash = '#/accounts'
  return url.href
}

type LocationLike = Pick<Location, 'href' | 'replace'>

/**
 * Leaves the current origin for the base hostname. Live and the device-auth
 * timer stop first so nothing polls the old origin. An unexpected hostname
 * records an `accounts` fault instead. Returns whether it redirected.
 */
export function redirectToBase(hostname: string, target: LocationLike = location, stop: () => void = stopAll): boolean {
  if (!isLoopbackHost(hostname)) {
    raiseFault('accounts', new Error(`Unexpected base hostname "${hostname}". Open the Dashboard on that hostname manually.`))
    return false
  }
  stop()
  target.replace(baseDashboardUrl(hostname, target.href))
  return true
}
