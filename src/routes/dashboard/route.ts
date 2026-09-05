import type { DashboardQuotaCache } from './handler'
import type { AccountAuthenticationSession, AddAccountInput } from '~/accounts/manager'

import { Elysia } from 'elysia'
import { z } from 'zod'

import { AccountManagementError } from '~/accounts/manager'
import { RECENT_REQUEST_LIMIT } from '~/observability/request-store'
import { DASHBOARD_CSS, DASHBOARD_HTML, DASHBOARD_JS } from './assets'

import {
  dashboardQuotaCache,
  getDashboardBehavior,
  getDashboardModels,
  getDashboardOverview,
  getDashboardRequests,
} from './handler'

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
const ADDRESS_BRACKET_RE = /^\[|\]$/g
const LOOPBACK_IPV4_RE = /^127(?:\.\d{1,3}){3}$/

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

const setDefaultAccountSchema = z.object({
  accountName: z.string(),
}).strict()

export interface DashboardAccountManagement {
  beginAddAccount: (input: AddAccountInput) => Promise<AccountAuthenticationSession>
  getAuthenticationSession: (id: string) => AccountAuthenticationSession | undefined
  getRoutingSummary: () => { baseHostname: string, defaultAccount: string }
  listAccounts: () => Promise<unknown[]>
  setDefaultAccount: (accountName: string) => Promise<void>
}

interface DashboardRouteOptions {
  accountManager?: DashboardAccountManagement
  quotaCache?: DashboardQuotaCache
}

interface DashboardPeer {
  address?: string
  live: boolean
}

interface SrvxNodeRequest extends Request {
  ip?: string
  runtime?: {
    name?: string
  }
}

export function createDashboardRoutes(options: DashboardRouteOptions = {}) {
  const accountManager = options.accountManager
  const quotaCache = options.quotaCache ?? dashboardQuotaCache

  return new Elysia({ name: 'dashboard' })
    .onBeforeHandle(({ request, server }) => {
      const peer = getDashboardPeer(request, server)
      return rejectDashboardAccess(request, peer.address, peer.live)
    })
    .get('/dashboard', () => assetResponse(
      DASHBOARD_HTML,
      'text/html; charset=utf-8',
      { 'content-security-policy': DASHBOARD_CSP },
    ))
    .get('/dashboard/styles.css', () => assetResponse(
      DASHBOARD_CSS,
      'text/css; charset=utf-8',
    ))
    .get('/dashboard/app.js', () => assetResponse(
      DASHBOARD_JS,
      'text/javascript; charset=utf-8',
    ))
    .get('/dashboard/api/overview', async () =>
      apiResponse(await getDashboardOverview(quotaCache)))
    .get('/dashboard/api/models', () =>
      apiResponse({ models: getDashboardModels() }))
    .get('/dashboard/api/behavior', () =>
      apiResponse(getDashboardBehavior()))
    .get('/dashboard/api/requests', () =>
      apiResponse({ capacity: RECENT_REQUEST_LIMIT, ...getDashboardRequests() }))
    .get('/dashboard/api/accounts', async () => {
      if (!accountManager)
        return accountManagementUnavailable()
      return apiResponse({
        ...accountManager.getRoutingSummary(),
        accounts: await accountManager.listAccounts(),
      })
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
        return apiResponse(accountManager.getRoutingSummary())
      }
      catch (error) {
        return accountManagementError(error)
      }
    })
}

function getDashboardPeer(
  request: Request,
  server: { requestIP: (request: Request) => { address: string } | null } | null,
): DashboardPeer {
  if (server !== null) {
    return {
      address: server.requestIP(request)?.address,
      live: true,
    }
  }

  const srvxRequest = request as SrvxNodeRequest
  if (srvxRequest.runtime?.name === 'node') {
    return {
      address: srvxRequest.ip,
      live: true,
    }
  }

  return { live: false }
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

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(ADDRESS_BRACKET_RE, '')
  if (normalized === '::1')
    return true
  const ipv4 = normalized.startsWith('::ffff:')
    ? normalized.slice('::ffff:'.length)
    : normalized
  if (!LOOPBACK_IPV4_RE.test(ipv4))
    return false
  return ipv4.split('.').every(part => Number(part) <= 255)
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

function accountManagementUnavailable(): Response {
  return apiError('Account management requires named-account routing.', 409)
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
