/**
 * Per-target request gates.
 *
 * A hostname selects a target; the target's own upstream then decides what the
 * request may reach. The M365 gateway serves a personal Microsoft credential,
 * so requests to it are limited to loopback peers and to an allow-list: the
 * Messages endpoint family and Responses creation for inference, plus the
 * root, health, the target's model list, and Dashboard paths, which are not
 * inference and continue to their own handlers and their own guard. Every
 * other path, including Responses resources, the proxy-specific `/token` and
 * `/usage`, is refused. An unavailable target answers inference requests with
 * its recorded cause.
 */
import { initializeM365Target } from '~/accounts/target-runtime'
import { isMessagesPath, normalizeRequestPathname, pathRefusalResponse } from '~/lib/error-dialect'
import { isLoopbackAddress, resolveRequestPeer } from '~/lib/peer'
import { getCurrentAccountRuntime, getTargetAvailability } from '~/state/account-runtime'

const M365_NON_INFERENCE_PATHS = new Set(['/', '/health', '/models', '/v1/models'])
const M365_RESPONSES_PATHS = new Set(['/responses', '/v1/responses'])
const M365_UNSERVED_PATH_MESSAGE
  = 'The Microsoft 365 target serves the Anthropic Messages endpoint and Responses creation only; use /v1/messages or /v1/responses.'

function isM365NonInferencePath(pathname: string): boolean {
  return M365_NON_INFERENCE_PATHS.has(pathname)
    || pathname === '/dashboard'
    || pathname.startsWith('/dashboard/')
}

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

  const pathname = normalizeRequestPathname(new URL(request.url).pathname)

  const peer = resolveRequestPeer(request, server)
  if (peer.live && (!peer.address || !isLoopbackAddress(peer.address))) {
    return pathRefusalResponse(
      pathname,
      403,
      'The Microsoft 365 target is reachable from the local machine only.',
    )
  }

  if (isM365NonInferencePath(pathname))
    return undefined

  if (!isMessagesPath(pathname) && !M365_RESPONSES_PATHS.has(pathname))
    return pathRefusalResponse(pathname, 400, M365_UNSERVED_PATH_MESSAGE)

  if (getTargetAvailability(runtime)?.status !== 'unavailable')
    return undefined

  // A recovered broker must restore service without a restart, so an
  // unavailable target retries acquisition through the helper's single-flight
  // path before the request is refused.
  await initializeM365Target(runtime)
  const availability = getTargetAvailability(runtime)
  if (availability?.status === 'ready')
    return undefined

  return pathRefusalResponse(
    pathname,
    503,
    `The Microsoft 365 target is unavailable: ${availability?.cause ?? 'unknown cause'}`,
  )
}
