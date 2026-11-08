/**
 * Builds route-target runtimes and records whether each target can serve.
 *
 * Every runtime is allocated here so startup, dashboard registration, and the
 * device-auth flow cannot drift in how they set the target's upstream or
 * credential identity. Failures are recorded as target state instead of
 * escaping into the caller; only the M365 target degrades this way, because
 * GitHub targets keep the fail-fast startup they have always had.
 */
import type { getMscToken } from '~/clients/msc-auth'
import type { TargetKind } from '~/lib/account-routing'
import type { AccountRuntime } from '~/state/account-runtime'
import type { AuthStore } from '~/state/auth'

import { acquireM365Credential, isM365CatalogAccessDenied, markM365Unavailable } from '~/clients/m365-credential'
import { fetchM365Models, M365_MODELS } from '~/clients/m365-upstream'
import { getCachedConfig } from '~/lib/config'
import { M365_DEFAULT_ENDPOINT } from '~/lib/m365-endpoints'
import { createAccountRuntime, setTargetAvailability } from '~/state/account-runtime'

export interface TargetRuntimeOptions {
  m365Endpoint?: string
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
      m365Endpoint: options.m365Endpoint ?? getCachedConfig().m365?.endpoint ?? M365_DEFAULT_ENDPOINT,
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
  const fetchCatalog = deps.fetchCatalog ?? fetchM365Models

  const credential = await acquireM365Credential(runtime, deps.acquireToken)
  if (credential.status === 'unavailable')
    return

  try {
    const catalog = await fetchCatalog(credential.accessToken, runtime.auth.m365Endpoint).catch((error: unknown) => {
      if (isM365CatalogAccessDenied(error))
        throw error
      return M365_MODELS
    })
    runtime.models.cacheModels(catalog)
    setTargetAvailability(runtime, { status: 'ready' })
  }
  catch (error) {
    markM365Unavailable(runtime, (error as Error).message)
  }
}
