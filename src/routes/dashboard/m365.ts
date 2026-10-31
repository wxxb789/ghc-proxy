/**
 * Dashboard projection and mutations for the M365 upstream's broker account.
 *
 * The token broker usually exposes every signed-in work account, but only some of
 * them carry the Copilot subscription that can mint gateway tokens. The selection
 * is stored in `config.json` under `m365.account` as the broker home account id,
 * which is unambiguous when the same UPN exists in several tenants.
 */
import type { MscAccount } from '~/clients/msc-auth'

import { getMscToken, listMscAccounts, resetMscTokenCache } from '~/clients/msc-auth'
import { getCachedConfig, writeConfigField } from '~/lib/config'
import { authStore } from '~/state'

export interface M365DashboardState {
  enabled: boolean
  selected: { account?: string }
  accounts: MscAccount[]
  error?: string
}

export async function getM365DashboardState(): Promise<M365DashboardState> {
  if (authStore.upstream !== 'm365') {
    return { enabled: false, selected: {}, accounts: [] }
  }

  const selected = authStore.mscAuthAccount
    ? { account: authStore.mscAuthAccount }
    : {}
  try {
    const accounts = await listMscAccounts({ exe: authStore.mscAuthExe })
    return { enabled: true, selected, accounts }
  }
  catch (error) {
    return { enabled: true, selected, accounts: [], error: (error as Error).message.slice(0, 400) }
  }
}

/**
 * Persists the selection, drops the cached token, and validates it by acquiring
 * one immediately so the dashboard can report a broker failure on save.
 */
export async function setM365Account(account: string | null): Promise<M365DashboardState> {
  if (authStore.upstream !== 'm365') {
    throw new Error('The M365 upstream is not active.')
  }

  const next = account ?? undefined
  await writeConfigField('m365', { ...getCachedConfig().m365, account: next })
  authStore.mscAuthAccount = next
  resetMscTokenCache()

  let error: string | undefined
  try {
    await getMscToken({ exe: authStore.mscAuthExe, account: next })
  }
  catch (failure) {
    error = (failure as Error).message.slice(0, 400)
  }

  const state = await getM365DashboardState()
  return error ? { ...state, error } : state
}
