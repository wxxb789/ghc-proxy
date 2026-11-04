import type { DashboardQuota, DashboardQuotaCache } from './quota'
import type { RoutedAccountDescriptor } from '~/accounts/descriptor'
import type { AccountManagementSnapshot } from '~/accounts/manager'

import { authStore, modelCache, runWithAccountRuntime } from '~/state'
import { getCurrentAccountRuntime, getTargetAvailability } from '~/state/account-runtime'
import { dashboardQuotaCache } from './quota'

export const DASHBOARD_ACCOUNT_QUOTA_CONCURRENCY = 4

export async function getDashboardAccount(
  account: RoutedAccountDescriptor,
  quotaCache: DashboardQuotaCache = dashboardQuotaCache,
) {
  return runWithAccountRuntime(account.runtime, async () => {
    const health = await getDashboardAccountHealth(quotaCache)
    return {
      name: account.name,
      hostname: account.hostname,
      isDefault: account.isDefault,
      upstream: authStore.upstream,
      identity: authStore.upstream === 'm365'
        ? authStore.mscAuthUsername ?? authStore.mscAuthUpn
        : authStore.githubLogin,
      tenant: authStore.upstream === 'm365'
        ? authStore.mscAuthTenant || 'Microsoft 365'
        : authStore.gheDomain ?? 'github.com',
      github: health.github,
      copilot: health.copilot,
      quota: health.quota,
    }
  })
}

export async function getDashboardAccounts(
  accounts: AccountManagementSnapshot['accounts'],
  quotaCache: DashboardQuotaCache,
) {
  const results: Array<Awaited<ReturnType<typeof getDashboardAccount>>> = []
  let nextIndex = 0
  const workerCount = Math.min(DASHBOARD_ACCOUNT_QUOTA_CONCURRENCY, accounts.length)

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < accounts.length) {
      const index = nextIndex++
      const account = accounts[index]
      if (!account)
        return
      results[index] = await getDashboardAccount(account, quotaCache)
    }
  }))

  return results
}

export async function getDashboardAccountHealth(
  quotaCache: DashboardQuotaCache,
) {
  const modelsLoaded = modelCache.getModels() !== undefined
  const isM365 = authStore.upstream === 'm365'
  const githubConfigured = Boolean(authStore.githubToken)
  const copilotConfigured = Boolean(authStore.copilotToken)
  const copilotExpired = authStore.copilotTokenExpiresAt !== undefined
    && authStore.copilotTokenExpiresAt <= Date.now()
  const copilotHealthy = copilotConfigured
    && modelsLoaded
    && !copilotExpired
    && authStore.copilotTokenLastRefreshSucceeded !== false
    && (!isM365 || getTargetAvailability(getCurrentAccountRuntime())?.status !== 'unavailable')
  const quota: DashboardQuota = isM365
    ? { status: 'not_applicable' }
    : githubConfigured
      ? await quotaCache.get()
      : { status: 'unavailable' }

  return {
    status: copilotHealthy ? 'ok' : 'degraded',
    github: {
      status: isM365
        ? 'not_applicable'
        : githubConfigured
          ? authStore.githubValidatedAt ? 'ok' : 'unknown'
          : 'missing',
      login: authStore.githubLogin,
      lastValidatedAt: toIso(authStore.githubValidatedAt),
      accountType: authStore.accountType,
    },
    copilot: {
      status: copilotConfigured
        ? copilotHealthy ? 'ok' : 'degraded'
        : 'missing',
      modelsLoaded,
      expiresAt: toIso(authStore.copilotTokenExpiresAt),
      lastRefreshAt: toIso(authStore.copilotTokenLastRefreshAt),
      lastRefreshSucceeded: authStore.copilotTokenLastRefreshSucceeded,
    },
    quota,
  }
}

function toIso(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined)
    return undefined
  const value = new Date(timestamp)
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
}
