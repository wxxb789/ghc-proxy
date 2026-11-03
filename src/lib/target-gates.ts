/**
 * Per-target request gates.
 *
 * A hostname selects a target; the target's own upstream then decides what the
 * request may reach. The M365 gateway serves a personal Microsoft credential,
 * so requests to it are limited to loopback peers, only the Messages endpoint
 * family is admitted for inference, and an unavailable target answers with its
 * recorded cause. Dashboard paths and the target's model list are not
 * inference: they continue to their own handlers and their own guard.
 */
import { initializeM365Target } from '~/accounts/target-runtime'
import { isLoopbackAddress, resolveRequestPeer } from '~/lib/peer'
import { getCurrentAccountRuntime, getTargetAvailability } from '~/state/account-runtime'

const MESSAGES_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens'])
const FOREIGN_INFERENCE_SUFFIXES = ['/chat/completions', '/responses', '/embeddings']
const FOREIGN_INFERENCE_MESSAGE
  = 'The Microsoft 365 target serves the Anthropic Messages endpoint only; use /v1/messages.'

interface RequestIpServer {
  requestIP: (request: Request) => { address: string } | null
}

/**
 * Returns a refusal for a request the selected M365 target must not serve, or
 * undefined when the request may proceed. Non-M365 targets are untouched.
 */
export async function enforceTargetGates(
  request: Request,
  server: RequestIpServer | null | undefined,
): Promise<Response | undefined> {
  const runtime = getCurrentAccountRuntime()
  if (runtime.auth.upstream !== 'm365')
    return undefined

  const { pathname: rawPathname } = new URL(request.url)
  const pathname = rawPathname.endsWith('/') ? rawPathname.slice(0, -1) : rawPathname

  const peer = resolveRequestPeer(request, server)
  if (peer.live && (!peer.address || !isLoopbackAddress(peer.address))) {
    return Response.json(
      {
        type: 'error',
        error: {
          message: 'The Microsoft 365 target is reachable from the local machine only.',
          type: 'invalid_request_error',
        },
      },
      { status: 403 },
    )
  }

  if (FOREIGN_INFERENCE_SUFFIXES.some(suffix =>
    pathname.endsWith(suffix) || pathname.includes(`${suffix}/`))) {
    return Response.json(
      { error: { message: FOREIGN_INFERENCE_MESSAGE, type: 'invalid_request_error' } },
      { status: 400 },
    )
  }

  if (!MESSAGES_PATHS.has(pathname))
    return undefined

  if (getTargetAvailability(runtime.name)?.status !== 'unavailable')
    return undefined

  // A recovered broker must restore service without a restart, so an
  // unavailable target retries acquisition through the helper's single-flight
  // path before the request is refused.
  await initializeM365Target(runtime)
  const availability = getTargetAvailability(runtime.name)
  if (availability?.status === 'ready')
    return undefined

  return Response.json(
    {
      type: 'error',
      error: {
        message: `The Microsoft 365 target is unavailable: ${availability?.cause ?? 'unknown cause'}`,
        type: 'invalid_request_error',
      },
    },
    { status: 503 },
  )
}
