// Injected `fetch` for UI tests: a request log, per-route handlers and held (deferred) responses.

export interface LoggedRequest {
  method: string
  path: string
  /** Parsed JSON body, when one was sent. */
  body?: unknown
  contentType: string | null
}

/** A route handler result: a Response, a JSON-serialisable body, or a thrown error (network failure). */
export type RouteHandler = (request: LoggedRequest) => Response | object | Promise<Response | object>

interface Held { key: string, release: (response?: Response | object) => void, promise: Promise<Response | object | undefined> }

/** `{ error: { message } }` envelope with a status, as the Dashboard API sends it. */
export function jsonError(status: number, message: string): Response {
  return Response.json({ error: { message, type: 'invalid_request_error' } }, { status })
}

/**
 * Routes are keyed `'<METHOD> <path>'` (e.g. `'POST /dashboard/api/refresh'`) or by bare path for GET.
 * Unrouted requests answer 404 so a missing fixture fails loudly.
 */
export function createFakeFetch(routes: Record<string, RouteHandler> = {}) {
  const log: LoggedRequest[] = []
  const holds: Held[] = []

  async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? 'GET'
    const path = String(input)
    const headers = new Headers(init.headers)
    const request: LoggedRequest = {
      method,
      path,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      contentType: headers.get('content-type'),
    }
    log.push(request)
    const key = `${method} ${path}`
    const holdIndex = holds.findIndex(hold => hold.key === key)
    let result: Response | object | undefined
    if (holdIndex >= 0)
      result = await holds.splice(holdIndex, 1)[0]!.promise
    const handler = routes[key] ?? (method === 'GET' ? routes[path] : undefined)
    result ??= handler ? await handler(request) : jsonError(404, `No fake route for ${key}`)
    return result instanceof Response ? result : Response.json(result)
  }

  return {
    fetch: fakeFetch as typeof fetch,
    log,
    routes,
    /** Holds the next request to `key` until `release()`; release may override the response. */
    hold(key: string) {
      let release!: Held['release']
      const promise = new Promise<Response | object | undefined>(resolve => release = resolve)
      holds.push({ key, release, promise })
      return { release: (response?: Response | object) => release(response) }
    },
    /** `'METHOD path'` strings in request order. */
    calls: () => log.map(request => `${request.method} ${request.path}`),
    count: (method: string, path?: string) => log.filter(request => request.method === method && (!path || request.path === path)).length,
    clear: () => {
      log.length = 0
    },
  }
}

export type FakeFetch = ReturnType<typeof createFakeFetch>
