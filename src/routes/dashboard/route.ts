import type { DashboardQuotaCache } from './handler'

import { Elysia } from 'elysia'

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

interface DashboardRouteOptions {
  quotaCache?: DashboardQuotaCache
}

export function createDashboardRoutes(options: DashboardRouteOptions = {}) {
  const quotaCache = options.quotaCache ?? dashboardQuotaCache

  return new Elysia({ name: 'dashboard' })
    .onBeforeHandle(({ request, server }) => rejectDashboardAccess(
      request,
      server ? server.requestIP(request)?.address : undefined,
      server !== null,
    ))
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

function apiResponse(data: unknown): Response {
  return Response.json(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      ...(typeof data === 'object' && data !== null ? data : { data }),
    },
    { headers: BASE_HEADERS },
  )
}
