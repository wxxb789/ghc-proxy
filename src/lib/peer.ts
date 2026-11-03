/**
 * Peer resolution shared by the dashboard guard and the route-target gates.
 *
 * Bun exposes the socket peer through `server.requestIP`; the Node adapter
 * fills `request.ip` on its srvx request and does not populate `app.server`,
 * so a request with neither is not a live socket and cannot be judged.
 */
export const ADDRESS_BRACKET_RE = /^\[|\]$/g
const LOOPBACK_IPV4_RE = /^127(?:\.\d{1,3}){3}$/

export interface RequestPeer {
  address?: string
  live: boolean
}

interface SrvxNodeRequest extends Request {
  runtime?: { name?: string }
  ip?: string
}

interface RequestIpServer {
  requestIP: (request: Request) => { address: string } | null
}

export function resolveRequestPeer(
  request: Request,
  server: RequestIpServer | null | undefined,
): RequestPeer {
  if (server) {
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
