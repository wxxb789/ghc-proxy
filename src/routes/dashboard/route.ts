import type { EmbeddedUi } from './embedded-ui'
import type { DashboardQuotaCache } from './handler'
import type { DashboardMetadataRefreshService } from './metadata-refresh'

import type {
  AccountAuthenticationSession,
  AccountManagementSnapshot,
  AddAccountInput,
} from '~/accounts/manager'
import { Elysia } from 'elysia'

import { z } from 'zod'
import { AccountManagementError } from '~/accounts/manager'
import { signInMscAccount } from '~/clients/msc-auth'
import { m365EndpointSchema } from '~/lib/m365-endpoints'
import { isLoopbackAddress, resolveRequestPeer } from '~/lib/peer'
import { RECENT_REQUEST_LIMIT } from '~/observability/request-store'
import { DASHBOARD_UI_ASSET_PATHS, DASHBOARD_UI_INDEX_PATH, loadEmbeddedUi } from './embedded-ui'

import {
  dashboardQuotaCache,
  getDashboardAccount,
  getDashboardBehavior,
  getDashboardModels,
  getDashboardOverview,
  getDashboardRequests,
} from './handler'

import { getM365DashboardState, probeM365Readiness } from './m365'
import { dashboardMetadataRefresher } from './metadata-refresh'

const DASHBOARD_CSP = [
  'default-src \'none\'',
  'script-src \'self\'',
  'style-src \'self\'',
  'connect-src \'self\'',
  'img-src \'self\' data:',
  'base-uri \'none\'',
  'frame-ancestors \'none\'',
  'form-action \'none\'',
  'object-src \'none\'',
].join('; ')

export const DASHBOARD_ACCOUNT_QUOTA_CONCURRENCY = 4

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}

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

const configureM365TargetSchema = z.object({
  account: z.string().nullable().optional(),
  hostname: z.string().min(1).optional(),
  endpoint: m365EndpointSchema.optional(),
}).strict()

const m365SignInSchema = z.object({ upn: z.string().trim().min(1).optional() }).strict()

const configureM365EndpointSchema = z.object({
  endpoint: m365EndpointSchema,
  endpoints: z.array(m365EndpointSchema).optional(),
}).strict()

export interface DashboardAccountManagement {
  beginAddAccount: (input: AddAccountInput) => Promise<AccountAuthenticationSession>
  bootstrapAccountRouting: (hostname: string) => Promise<void>
  configureM365Target: (
    input: { account?: string | null, hostname?: string, endpoint?: string, endpoints?: string[] },
  ) => Promise<void>
  getAuthenticationSession: (id: string) => AccountAuthenticationSession | undefined
  getMscAuthExe?: () => string | undefined
  getAccountSnapshot: () => AccountManagementSnapshot
  registerM365Target: (
    input: { account?: string | null, hostname?: string, endpoint?: string },
  ) => Promise<void>
  removeM365Target: () => Promise<void>
  removeAccount: (accountName: string) => Promise<void>
  setDefaultAccount: (accountName: string) => Promise<void>
}

interface DashboardRouteOptions {
  accountManager?: DashboardAccountManagement
  metadataRefresher?: DashboardMetadataRefreshService
  quotaCache?: DashboardQuotaCache
  serverPort?: number
  /** Test seam: a fixed UI manifest, or `null` for an unbuilt checkout. */
  ui?: EmbeddedUi | null
}

export function createDashboardRoutes(options: DashboardRouteOptions = {}) {
  const accountManager = options.accountManager
  const metadataRefresher = options.metadataRefresher ?? dashboardMetadataRefresher
  const quotaCache = options.quotaCache ?? dashboardQuotaCache
  const resolveUi = async () => options.ui === undefined ? await loadEmbeddedUi() : options.ui ?? undefined

  const app = new Elysia({ name: 'dashboard' })
    .onBeforeHandle(({ request, server }) => {
      const peer = resolveRequestPeer(request, server)
      return rejectDashboardAccess(request, peer.address, peer.live)
    })
    .get('/dashboard', async () => {
      const ui = await resolveUi()
      if (!ui)
        return dashboardUiNotBuilt()
      const index = ui[DASHBOARD_UI_INDEX_PATH]
      return assetResponse(index.content, index.contentType, { 'content-security-policy': DASHBOARD_CSP })
    })
    .get('/dashboard/api/overview', async () =>
      apiResponse(await getDashboardOverview(
        quotaCache,
        accountManager?.getAccountSnapshot(),
      )))
    .get('/dashboard/api/models', () =>
      apiResponse({ models: getDashboardModels() }))
    .get('/dashboard/api/behavior', () =>
      apiResponse(getDashboardBehavior()))
    .get('/dashboard/api/requests', () =>
      apiResponse({ capacity: RECENT_REQUEST_LIMIT, ...getDashboardRequests() }))
    .get('/dashboard/api/accounts', async () => {
      if (!accountManager)
        return accountManagementUnavailable()
      const snapshot = accountManager.getAccountSnapshot()
      return apiResponse({
        ...snapshot.routing,
        accounts: await getDashboardAccounts(snapshot.accounts, quotaCache),
      })
    })
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
        return apiResponse({ account })
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
    .post('/dashboard/api/m365/endpoint', async ({ body }) => {
      if (!accountManager)
        return accountManagementUnavailable()
      const parsed = configureM365EndpointSchema.safeParse(body)
      if (!parsed.success)
        return apiError('Invalid M365 endpoint payload. Use an HTTPS URL without credentials, query, or fragment.', 400)
      try {
        await accountManager.configureM365Target(parsed.data)
        return apiResponse(getM365DashboardState({
          manager: accountManager,
          serverPort: options.serverPort,
        }))
      }
      catch (error) {
        return accountManagementError(error)
      }
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
        return apiResponse({ authentication: session }, 202)
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
        return apiResponse(accountManager.getAccountSnapshot().routing)
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
        ? apiResponse({ authentication: session })
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
        return apiResponse(accountManager.getAccountSnapshot().routing)
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
        return apiResponse(accountManager.getAccountSnapshot().routing)
      }
      catch (error) {
        return accountManagementError(error)
      }
    })

  // Exact asset routes (no wildcard): typos under /dashboard/ stay 404s.
  for (const path of DASHBOARD_UI_ASSET_PATHS) {
    app.get(path, async () => {
      const ui = await resolveUi()
      if (!ui)
        return apiError('Dashboard UI is not built.', 503)
      const asset = ui[path]
      return assetResponse(asset.content, asset.contentType)
    })
  }
  return app
}

async function getDashboardAccounts(
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

function rejectDashboardAccess(
  request: Request,
  peerAddress: string | undefined,
  hasLiveServer: boolean,
): Response | undefined {
  if (hasLiveServer && (!peerAddress || !isLoopbackAddress(peerAddress)))
    return dashboardAccessDenied()

  const requestUrl = new URL(request.url)
  if (!isLoopbackHostname(requestUrl.hostname)) {
    return dashboardAccessDenied()
  }

  const origin = request.headers.get('origin')
  if (origin && origin !== requestUrl.origin)
    return dashboardAccessDenied()
}

function dashboardAccessDenied(): Response {
  return Response.json(
    {
      error: {
        message: 'Dashboard access is restricted to the local machine.',
        type: 'invalid_request_error',
      },
    },
    { status: 403, headers: BASE_HEADERS },
  )
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '0.0.0.0'
    || isLoopbackAddress(normalized)
}

function assetResponse(
  body: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, {
    headers: {
      ...BASE_HEADERS,
      ...extraHeaders,
      'content-type': contentType,
    },
  })
}

function dashboardUiNotBuilt(): Response {
  return new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dashboard not built</title></head>'
    + '<body><h1>Dashboard not built</h1><p>Run <code>bun run build:ui</code> to build the Dashboard in a source checkout.</p></body></html>',
    {
      status: 503,
      headers: {
        ...BASE_HEADERS,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': DASHBOARD_CSP,
      },
    },
  )
}

function accountManagementUnavailable(): Response {
  return apiError('Account management is unavailable for this process configuration.', 409)
}

function accountManagementError(error: unknown): Response {
  return error instanceof AccountManagementError
    ? apiError(error.message, error.status)
    : apiError('Account management request failed.', 500)
}

function apiError(message: string, status: number): Response {
  return Response.json(
    { error: { message, type: 'invalid_request_error' } },
    { status, headers: BASE_HEADERS },
  )
}

function apiResponse(data: unknown, status = 200): Response {
  return Response.json(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      ...(typeof data === 'object' && data !== null ? data : { data }),
    },
    { status, headers: BASE_HEADERS },
  )
}
