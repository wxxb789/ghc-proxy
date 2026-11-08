/**
 * The one path by which a broker token reaches an M365 route target.
 *
 * Target initialization and the client's per-request refresh both acquire the
 * credential here, so the token projection onto the target's auth and the
 * bounded `unavailable` cause recorded on failure cannot drift. Every write goes
 * to the runtime passed in, never to the ambient request runtime.
 */
import type { AccountRuntime } from '~/state/account-runtime'

import { HTTPError } from '~/lib/error'
import { setTargetAvailability } from '~/state/account-runtime'

import { getMscToken } from './msc-auth'

export type M365CredentialResult
  = | { status: 'ready', accessToken: string }
    | { status: 'unavailable', cause: string }

/**
 * Acquires the target's broker token and projects it onto `runtime.auth`. A
 * failure is recorded on the target and returned, never thrown.
 */
export async function acquireM365Credential(
  runtime: AccountRuntime,
  acquireToken: typeof getMscToken = getMscToken,
): Promise<M365CredentialResult> {
  try {
    const credential = await acquireToken({
      exe: runtime.auth.mscAuthExe,
      account: runtime.auth.mscAuthAccount,
      upn: runtime.auth.mscAuthUpn,
    })
    runtime.auth.copilotToken = credential.accessToken
    runtime.auth.copilotTokenExpiresAt = credential.expiresOn.getTime()
    runtime.auth.copilotTokenLastRefreshAt = Date.now()
    runtime.auth.copilotTokenLastRefreshSucceeded = true
    runtime.auth.mscAuthUsername = credential.username
    runtime.auth.mscAuthTenant = credential.tenant
    return { status: 'ready', accessToken: credential.accessToken }
  }
  catch (error) {
    return { status: 'unavailable', cause: markM365Unavailable(runtime, (error as Error).message) }
  }
}

/** Records the target as unable to serve, with a bounded cause, and returns that cause. */
export function markM365Unavailable(runtime: AccountRuntime, message: string): string {
  runtime.auth.copilotTokenLastRefreshSucceeded = false
  const cause = message.slice(0, 400)
  setTargetAvailability(runtime, { status: 'unavailable', cause })
  return cause
}

/** A catalog 401/403 is an authorization failure, not a discovery outage. */
export function isM365CatalogAccessDenied(error: unknown): error is HTTPError {
  return error instanceof HTTPError && (error.status === 401 || error.status === 403)
}
