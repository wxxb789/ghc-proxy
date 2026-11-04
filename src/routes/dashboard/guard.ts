import { isLoopbackAddress } from '~/lib/peer'
import { BASE_HEADERS } from './http'

export function rejectDashboardAccess(
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
