import type { Elysia } from 'elysia'

import { getDashboardBehavior, getDashboardModels } from './config-projection'
import { apiResponse } from './http'

export function registerConfigRoutes(app: Elysia) {
  return app
    .get('/dashboard/api/models', () =>
      apiResponse({ models: getDashboardModels() }))
    .get('/dashboard/api/behavior', () =>
      apiResponse(getDashboardBehavior()))
}
