import type { Elysia } from 'elysia'
import type { DashboardQuotaCache } from './quota'
import type { DashboardAccountManagement } from './types'

import { RECENT_REQUEST_LIMIT } from '~/observability/request-store'
import { apiResponse } from './http'
import { getDashboardOverview, getDashboardRequests } from './monitor-projection'

export function registerMonitorRoutes(
  app: Elysia,
  quotaCache: DashboardQuotaCache,
  accountManager?: DashboardAccountManagement,
) {
  return app
    .get('/dashboard/api/overview', async () =>
      apiResponse(await getDashboardOverview(
        quotaCache,
        accountManager?.getAccountSnapshot(),
      )))
    .get('/dashboard/api/requests', () =>
      apiResponse({ capacity: RECENT_REQUEST_LIMIT, ...getDashboardRequests() }))
}
