import { AccountManagementError } from '~/accounts/manager'

export const BASE_HEADERS = {
  'cache-control': 'no-store',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}

export function assetResponse(
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

export function accountManagementUnavailable(): Response {
  return apiError('Account management is unavailable for this process configuration.', 409)
}

export function accountManagementError(error: unknown): Response {
  return error instanceof AccountManagementError
    ? apiError(error.message, error.status)
    : apiError('Account management request failed.', 500)
}

export function apiError(message: string, status: number): Response {
  return Response.json(
    { error: { message, type: 'invalid_request_error' } },
    { status, headers: BASE_HEADERS },
  )
}

export function apiResponse(data: unknown, status = 200): Response {
  return Response.json(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      ...(typeof data === 'object' && data !== null ? data : { data }),
    },
    { status, headers: BASE_HEADERS },
  )
}
