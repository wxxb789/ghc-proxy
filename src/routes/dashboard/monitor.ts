import type { Elysia } from 'elysia'
import type { DashboardRouteOptions } from './types'

import { runtimeStore } from '~/state'
import { apiError, apiResponse, parseDashboardWindow } from './http'
import { getDashboardOverview, getDashboardRequests } from './monitor-projection'

export function registerMonitorRoutes(app: Elysia, options: DashboardRouteOptions) {
  return app
    .get('/dashboard/api/overview', ({ request }) =>
      apiResponse(getDashboardOverview(options, request)))
    .get('/dashboard/api/requests', () => apiResponse(getDashboardRequests()))
    .get('/dashboard/api/metrics', ({ request }) => {
      const window = parseDashboardWindow(request)
      if (window === undefined)
        return apiError('Unknown metric window.', 400)
      const target = new URL(request.url).searchParams.get('target') ?? undefined
      return apiResponse(runtimeStore.requests.queryMetrics(window, target))
    })
}
