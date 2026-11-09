/**
 * Error dialect for refusals the proxy answers before any route handler runs.
 *
 * Such a refusal has no handler to choose its envelope, so the request path
 * does: the Anthropic Messages family gets the Anthropic envelope
 * (`{ type: 'error', error }`), every other path the OpenAI one (`{ error }`).
 * Shared by the unknown-hostname 421 in `src/server.ts` and the M365 target
 * gates, so both answer a given path in the same dialect.
 */
import type { HTTPErrorBody } from './error'

const MESSAGES_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens'])

/** Drops one trailing slash so `/v1/messages/` names `/v1/messages`; `/` stays. */
export function normalizeRequestPathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

/** Whether a normalized path belongs to the Anthropic Messages family. */
export function isMessagesPath(pathname: string): boolean {
  return MESSAGES_PATHS.has(pathname)
}

/**
 * An `invalid_request_error` refusal in the envelope the surface of a
 * normalized path expects.
 */
export function pathRefusalResponse(pathname: string, status: number, message: string): Response {
  const body: HTTPErrorBody = { error: { message, type: 'invalid_request_error' } }
  return Response.json(isMessagesPath(pathname) ? { type: 'error', ...body } : body, { status })
}
