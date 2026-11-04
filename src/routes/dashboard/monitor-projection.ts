import type { DashboardQuotaCache } from './quota'
import type { AccountManagementSnapshot } from '~/accounts/manager'

import { getUpstreamRequestQueueSnapshot } from '~/clients/factory'
import { authStore, getCurrentAccountName, runtimeStore } from '~/state'
import { VERSION } from '~/util/version'
import { dashboardQuotaCache } from './quota'
import { getDashboardAccountHealth } from './targets-projection'

export async function getDashboardOverview(
  quotaCache: DashboardQuotaCache = dashboardQuotaCache,
  accountSnapshot?: AccountManagementSnapshot,
) {
  const requests = runtimeStore.requests.summary()
  const account = await getDashboardAccountHealth(quotaCache)

  return {
    status: account.status,
    version: VERSION,
    startedAt: runtimeStore.startedAt,
    uptimeMs: Math.max(0, Date.now() - Date.parse(runtimeStore.startedAt)),
    auth: {
      upstream: authStore.upstream,
      identity: authStore.upstream === 'm365'
        ? authStore.mscAuthUsername ?? authStore.mscAuthUpn
        : authStore.githubLogin,
      github: account.github,
      copilot: account.copilot,
      accounts: {
        currentAccount: getCurrentAccountName(),
        defaultAccount: accountSnapshot?.routing.defaultAccount ?? getCurrentAccountName(),
        totalAccounts: accountSnapshot?.accounts.length ?? 1,
      },
    },
    quota: account.quota,
    activity: {
      activeRequests: requests.active,
      recentRequests: requests.recent,
      ...requests.totals,
      upstreamQueue: getUpstreamRequestQueueSnapshot(),
    },
  }
}

export function getDashboardRequests() {
  return runtimeStore.requests.snapshot()
}
