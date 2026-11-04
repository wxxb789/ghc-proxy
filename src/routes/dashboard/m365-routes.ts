import type { Elysia } from 'elysia'
import type { DashboardRouteOptions } from './types'

import type { DashboardM365SignIn } from '~/types/dashboard'
import { z } from 'zod'

import { signInMscAccount } from '~/clients/msc-auth'
import { accountManagementError, accountManagementUnavailable, apiError, apiResponse } from './http'
import { getM365DashboardState, probeM365Readiness } from './m365'

const configureM365TargetSchema = z.object({
  account: z.string().nullable().optional(),
  hostname: z.string().min(1).optional(),
}).strict()

const m365SignInSchema = z.object({ upn: z.string().trim().min(1).optional() }).strict()

export function registerM365Routes(app: Elysia, options: DashboardRouteOptions) {
  const accountManager = options.accountManager

  return app
    .get('/dashboard/api/m365', () => apiResponse(getM365DashboardState({
      manager: accountManager,
      serverPort: options.serverPort,
    })))
    .post('/dashboard/api/m365/probe', async () =>
      apiResponse(await probeM365Readiness(accountManager?.getMscAuthExe?.())))
    .post('/dashboard/api/m365/sign-in', async ({ body }) => {
      if (!accountManager)
        return accountManagementUnavailable()
      const parsed = m365SignInSchema.safeParse(body)
      if (!parsed.success)
        return apiError('Invalid M365 sign-in request.', 400)
      try {
        const account = await signInMscAccount({
          exe: accountManager.getMscAuthExe?.(),
          upn: parsed.data.upn,
        })
        return apiResponse<DashboardM365SignIn>({ account })
      }
      catch (error) {
        return apiError((error as Error).message, 502)
      }
    })
    .post('/dashboard/api/m365/register', async ({ body }) => {
      if (!accountManager)
        return accountManagementUnavailable()
      const parsed = configureM365TargetSchema.safeParse(body)
      if (!parsed.success)
        return apiError('Invalid M365 target payload.', 400)
      try {
        await accountManager.registerM365Target(parsed.data)
        return apiResponse(getM365DashboardState({
          manager: accountManager,
          serverPort: options.serverPort,
        }))
      }
      catch (error) {
        return accountManagementError(error)
      }
    })
    .post('/dashboard/api/m365/remove', async () => {
      if (!accountManager)
        return accountManagementUnavailable()
      try {
        await accountManager.removeM365Target()
        return apiResponse(getM365DashboardState({
          manager: accountManager,
          serverPort: options.serverPort,
        }))
      }
      catch (error) {
        return accountManagementError(error)
      }
    })
    .post('/dashboard/api/m365/account', async ({ body }) => {
      if (!accountManager)
        return accountManagementUnavailable()
      const parsed = configureM365TargetSchema.safeParse(body)
      if (!parsed.success)
        return apiError('Invalid account selection payload.', 400)
      try {
        await accountManager.configureM365Target({ account: parsed.data.account })
        return apiResponse(getM365DashboardState({
          manager: accountManager,
          serverPort: options.serverPort,
        }))
      }
      catch (error) {
        return accountManagementError(error)
      }
    })
    .post('/dashboard/api/m365/hostname', async ({ body }) => {
      if (!accountManager)
        return accountManagementUnavailable()
      const parsed = configureM365TargetSchema.safeParse(body)
      if (!parsed.success || parsed.data.hostname === undefined)
        return apiError('Invalid hostname payload.', 400)
      try {
        await accountManager.configureM365Target({ hostname: parsed.data.hostname })
        return apiResponse(getM365DashboardState({
          manager: accountManager,
          serverPort: options.serverPort,
        }))
      }
      catch (error) {
        return accountManagementError(error)
      }
    })
}
