import type { Elysia } from 'elysia'
import type { DashboardModels } from '~/types/dashboard'

import { getCurrentAccountName } from '~/state'
import { getDashboardBehavior, getDashboardModels } from './config-projection'
import { apiError, apiResponse, parseDashboardWindow } from './http'

export function registerConfigRoutes(app: Elysia) {
  return app
    .get('/dashboard/api/models', () => {
      const models: DashboardModels = { hostTarget: getCurrentAccountName(), models: getDashboardModels() }
      return apiResponse(models)
    })
    .get('/dashboard/api/behavior', ({ request }) => {
      const window = parseDashboardWindow(request)
      return window === undefined ? apiError('Unknown metric window.', 400) : apiResponse(getDashboardBehavior(window))
    })
}
