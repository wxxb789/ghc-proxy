/**
 * Builds route-target runtimes and records whether each target can serve.
 *
 * Every runtime is allocated here so startup, dashboard registration, and the
 * device-auth flow cannot drift in how they set the target's upstream or
 * credential identity. Failures are recorded as target state instead of
 * escaping into the caller; only the M365 target degrades this way, because
 * GitHub targets keep the fail-fast startup they have always had.
 */
import type { TargetKind } from '~/lib/account-routing'
import type { AccountRuntime } from '~/state/account-runtime'
import type { AuthStore } from '~/state/auth'

import { fetchM365Models, M365_MODELS } from '~/clients/m365-upstream'
import { getMscToken } from '~/clients/msc-auth'
import { HTTPError } from '~/lib/error'
import { createAccountRuntime, setTargetAvailability } from '~/state/account-runtime'

export interface TargetRuntimeOptions {
  mscAuthExe?: string
  mscAuthAccount?: string
  mscAuthUpn?: string
  auth?: Partial<AuthStore>
}

export interface M365InitializationDeps {
  acquireToken?: typeof getMscToken
  fetchCatalog?: typeof fetchM365Models
}

export function createTargetRuntime(
  name: string,
  kind: TargetKind,
  options: TargetRuntimeOptions = {},
): AccountRuntime {
  if (kind === 'm365') {
    return createAccountRuntime(name, {
      ...options.auth,
      upstream: 'm365',
      mscAuthExe: options.mscAuthExe,
      mscAuthAccount: options.mscAuthAccount,
      mscAuthUpn: options.mscAuthUpn,
    })
  }

  return createAccountRuntime(name, { ...options.auth, upstream: 'github' })
}

/**
 * Acquires the target's credential and catalog. A failure is recorded as an
 * unavailable target with a bounded cause; callers keep the process running.
 */
export async function initializeM365Target(
  runtime: AccountRuntime,
  deps: M365InitializationDeps = {},
): Promise<void> {
  const acquireToken = deps.acquireToken ?? getMscToken
  const fetchCatalog = deps.fetchCatalog ?? fetchM365Models

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
    const catalog = await fetchCatalog(credential.accessToken).catch((error: unknown) => {
      if (error instanceof HTTPError && (error.status === 401 || error.status === 403))
        throw error
      return M365_MODELS
    })
    runtime.models.cacheModels(catalog)
    setTargetAvailability(runtime, { status: 'ready' })
  }
  catch (error) {
    runtime.auth.copilotTokenLastRefreshSucceeded = false
    setTargetAvailability(runtime, {
      status: 'unavailable',
      cause: (error as Error).message.slice(0, 400),
    })
  }
}
