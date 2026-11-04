import type { Elysia } from 'elysia'
import type { DashboardRouteOptions } from './types'
import type { DashboardAuthenticationResult, DashboardRouting } from '~/types/dashboard'

import { z } from 'zod'

import { accountManagementError, accountManagementUnavailable, apiError, apiResponse } from './http'
import { dashboardMetadataRefresher } from './metadata-refresh'
import { dashboardQuotaCache } from './quota'
import { getDashboardTargetQuota, getDashboardTargets } from './targets-projection'

const addAccountSchema = z.object({
  accountName: z.string(),
  hostname: z.string(),
  gheDomain: z.string().optional(),
}).strict()

const bootstrapAccountRoutingSchema = z.object({
  hostname: z.string(),
}).strict()

const setDefaultAccountSchema = z.object({
  accountName: z.string(),
}).strict()

export function registerTargetRoutes(
  app: Elysia,
  options: DashboardRouteOptions,
) {
  const accountManager = options.accountManager
  const metadataRefresher = options.metadataRefresher ?? dashboardMetadataRefresher
  const quotaCache = options.quotaCache ?? dashboardQuotaCache

  return app
    .get('/dashboard/api/targets', ({ request }) =>
      apiResponse(getDashboardTargets(options, request)))
    .get('/dashboard/api/targets/:targetName/quota', async ({ params, request }) => {
      const result = await getDashboardTargetQuota(params.targetName, options, request, quotaCache)
      return result ? apiResponse(result) : apiError('Route target was not found.', 404)
    })
    .post('/dashboard/api/refresh', async () => {
      if (!accountManager)
        return accountManagementUnavailable()
      const snapshot = accountManager.getAccountSnapshot()
      if (!snapshot.routing.routingEnabled)
        return accountManagementUnavailable()
      return apiResponse(await metadataRefresher.refresh(snapshot.accounts, quotaCache))
    })
    .post('/dashboard/api/accounts', async ({ body }) => {
      if (!accountManager)
        return accountManagementUnavailable()
      const parsed = addAccountSchema.safeParse(body)
      if (!parsed.success)
        return apiError('Invalid account authentication request.', 400)
      try {
        const session = await accountManager.beginAddAccount({
          ...parsed.data,
          gheDomain: parsed.data.gheDomain?.trim() || undefined,
        })
        return apiResponse<DashboardAuthenticationResult>({ authentication: session }, 202)
      }
      catch (error) {
        return accountManagementError(error)
      }
    })
    .post('/dashboard/api/accounts/bootstrap', async ({ body }) => {
      if (!accountManager)
        return accountManagementUnavailable()
      const parsed = bootstrapAccountRoutingSchema.safeParse(body)
      if (!parsed.success)
        return apiError('Invalid account routing bootstrap request.', 400)
      try {
        await accountManager.bootstrapAccountRouting(parsed.data.hostname)
        return apiResponse<DashboardRouting>(accountManager.getAccountSnapshot().routing)
      }
      catch (error) {
        return accountManagementError(error)
      }
    })
    .get('/dashboard/api/account-auth/:id', ({ params }) => {
      if (!accountManager)
        return accountManagementUnavailable()
      const session = accountManager.getAuthenticationSession(params.id)
      return session
        ? apiResponse<DashboardAuthenticationResult>({ authentication: session })
        : apiError('Account authentication session was not found.', 404)
    })
    .post('/dashboard/api/accounts/default', async ({ body }) => {
      if (!accountManager)
        return accountManagementUnavailable()
      const parsed = setDefaultAccountSchema.safeParse(body)
      if (!parsed.success)
        return apiError('Invalid default account request.', 400)
      try {
        await accountManager.setDefaultAccount(parsed.data.accountName)
        return apiResponse<DashboardRouting>(accountManager.getAccountSnapshot().routing)
      }
      catch (error) {
        return accountManagementError(error)
      }
    })
    .delete('/dashboard/api/accounts/:accountName', async ({ params }) => {
      if (!accountManager)
        return accountManagementUnavailable()
      try {
        await accountManager.removeAccount(params.accountName)
        return apiResponse<DashboardRouting>(accountManager.getAccountSnapshot().routing)
      }
      catch (error) {
        return accountManagementError(error)
      }
    })
}
