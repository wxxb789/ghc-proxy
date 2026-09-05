import type { DashboardAccountManagement } from './routes/dashboard/route'
import { cors } from '@elysiajs/cors'
import { node } from '@elysiajs/node'

import { Elysia } from 'elysia'
import { HTTPError } from './lib/error'
import { formatElapsed, getOrCreateRequestCorrelation, getRequestModelMapping, getRequestStart, logRequest, markRequestStart, setRequestModelMapping } from './lib/request-logger'
import { isTimeoutLikeError } from './lib/timeout-error'
import { isClientAbortError } from './lib/upstream-signal'
import { classifyObservedEndpoint, sanitizeObservedError } from './observability/request-store'
import { createCompletionRoutes } from './routes/chat-completions/route'
import { createDashboardRoutes } from './routes/dashboard/route'
import { createEmbeddingRoutes } from './routes/embeddings/route'
import { createMessageRoutes } from './routes/messages/route'
import { createModelRoutes } from './routes/models/route'
import { createResponsesRoutes } from './routes/responses/route'
import { createTokenRoute } from './routes/token/route'
import { createUsageRoute } from './routes/usage/route'
import { authStore, getRequestAccountName, modelCache, resolveRequestAccountRuntime, runtimeStore, runWithAccountRuntime } from './state'
import { VERSION } from './util/version'

const isBun = typeof globalThis.Bun !== 'undefined'

// Elysia higher-order wrappers cover both the general fetch handler and Bun's
// per-path system router, keeping every public path inside the same account
// context without leaking that context back to the caller.
const accountRoutingWrapper: Parameters<Elysia['wrap']>[0] = (handle, request) => {
  return () => {
    const runtime = resolveRequestAccountRuntime(request)
    if (!runtime) {
      const { hostname, pathname } = new URL(request.url)
      const message = `No account is configured for hostname ${JSON.stringify(hostname)}.`
      const normalizedPathname = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
      const anthropic = normalizedPathname === '/v1/messages'
        || normalizedPathname === '/v1/messages/count_tokens'
      return Response.json(
        anthropic
          ? { type: 'error', error: { message, type: 'invalid_request_error' } }
          : { error: { message, type: 'invalid_request_error' } },
        { status: 421 },
      )
    }

    return runWithAccountRuntime(runtime, () => handle(request))
  }
}

export interface ServerOptions {
  accountManager?: DashboardAccountManagement
  idleTimeout?: number
  logRequests?: boolean
}

/**
 * Smallest and largest status an error may claim for itself.
 *
 * An error that reports a 2xx/3xx — or a nonsense number — is not describing a
 * failure the client can act on, so it falls through to 500 rather than turning
 * a thrown exception into an apparent success.
 */
const MIN_ERROR_STATUS = 400
const MAX_ERROR_STATUS = 599

/**
 * The status a thrown value claims for itself, when it claims a plausible one.
 *
 * Elysia's built-in error classes (`NotFoundError`, `ParseError`,
 * `ValidationError`, `InternalServerError`) each declare `status: number` as
 * part of their public class contract, and this repo's own `TranslationFailure`
 * declares `status: 400 | 502`. Reading the property instead of mapping
 * `code` covers all of them, and covers whatever Elysia adds next.
 *
 * The read is wrapped because this runs inside the error handler: `status` may
 * be a getter and `error` may be a Proxy, either of which can throw. This
 * hardens this function only — Elysia itself does `set.status = error.status`
 * after `onError` returns (`elysia/dist/compose.mjs`), so a hostile getter
 * still escapes `app.handle()`. Measured on the pre-fix tree as well, so that
 * escape is Elysia's, not something reading the property here introduced.
 * `isTimeoutLikeError` guards its own traversal the same way.
 */
function claimedErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null)
    return undefined

  let status: unknown
  try {
    // Both the `in` check and the read can throw: a Proxy may trap `has`, and
    // `status` may be a getter.
    if (!('status' in error))
      return undefined
    status = (error as { status: unknown }).status
  }
  catch {
    return undefined
  }

  return typeof status === 'number'
    && Number.isInteger(status)
    && status >= MIN_ERROR_STATUS
    && status <= MAX_ERROR_STATUS
    ? status
    : undefined
}

/**
 * Client-facing error `type` for a locally generated failure.
 *
 * The proxy's other error paths already classify by meaning
 * (`invalid_request_error`, `upstream_error`, `rate_limit_error`,
 * `timeout_error`), and `upstreamErrorType` in `src/lib/error.ts` states the
 * rule: a non-standard `type` at the proxy boundary breaks client error
 * handling. Honoring the thrown error's status made this branch reachable at
 * 404/400/422 rather than only 500, so it classifies too instead of labelling
 * every one of them `error`.
 */
function localErrorType(status: number): string {
  if (status === 404)
    return 'not_found_error'
  if (status >= 400 && status < 500)
    return 'invalid_request_error'
  return 'error'
}

/**
 * Elysia's `NotFoundError` carries the bare string `NOT_FOUND` as its message.
 * That is an internal token, not something a client should be shown, so an
 * unmatched route gets a sentence instead.
 */
const NOT_FOUND_MESSAGE = 'Unknown endpoint. Check the request path.'

/**
 * Maps a thrown error to a client response.
 *
 * `set.status` is written on every branch because `onError` returns a fresh
 * `Response` instead of falling through Elysia's normal path — `set.status`
 * would otherwise still hold whatever it was before the throw, and the access
 * log in `onAfterResponse` reads it. Without the write-back, a 504 is logged
 * as a 500.
 *
 * Errors that carry their own plausible status keep it. Flattening every
 * non-HTTPError to 500 turned an unmatched route into `500 NaNs` on an
 * OpenAI-compatible surface where an unknown path owes the client a 404, and
 * hid `TranslationFailure`'s 502 behind a generic 500.
 *
 * Exported so tests exercise this mapping rather than a copy of it.
 */
export function handleRouteError(
  { code, error, set }: {
    code: string | number
    error: unknown
    set: { status?: number | string }
  },
): Response | undefined {
  // HTTPError is auto-handled via toResponse() — just let it through
  if (code === 'HTTP')
    return

  if (isTimeoutLikeError(error)) {
    set.status = 504
    return Response.json(
      {
        error: {
          message: 'Upstream request timed out before a response was received.',
          type: 'timeout_error',
        },
      },
      { status: 504 },
    )
  }

  const status = claimedErrorStatus(error) ?? 500
  const rawMessage = error instanceof Error ? error.message : String(error)
  const message = code === 'NOT_FOUND' ? NOT_FOUND_MESSAGE : rawMessage
  set.status = status
  return Response.json(
    { error: { message, type: localErrorType(status) } },
    { status },
  )
}

export function createServer(options?: ServerOptions) {
  const app = new Elysia({
    adapter: isBun ? undefined : node(),
    serve: options?.idleTimeout !== undefined
      ? { idleTimeout: options.idleTimeout }
      : undefined,
  })
    .wrap(accountRoutingWrapper)
    .error({ HTTP: HTTPError })
    // Block body, not a concise arrow: Elysia turns any non-undefined
    // `onRequest` return into the response, and a WeakMap setter returns the
    // WeakMap. `markRequestStart` is typed `: void` for the same reason.
    .onRequest(({ request }) => {
      const endpoint = classifyObservedEndpoint(request.url)
      if (endpoint === undefined)
        return

      markRequestStart(request)
      const { requestId } = getOrCreateRequestCorrelation(request)
      runtimeStore.requests.start({
        requestId,
        accountName: getRequestAccountName(request),
        method: request.method,
        endpoint,
      })
    })
    .use(cors())
    .derive(({ request }) => ({
      ...getOrCreateRequestCorrelation(request),
    }))
    .onBeforeHandle(({ body, request, responseRequestId, set }) => {
      set.headers['x-request-id'] = responseRequestId
      if (request.method !== 'POST')
        return
      const model = body && typeof body === 'object' && 'model' in body
        ? (body as Record<string, unknown>).model
        : undefined
      if (typeof model === 'string') {
        setRequestModelMapping(request, { originalModel: model, steps: [] })
        runtimeStore.requests.recordRequestedModel(
          getOrCreateRequestCorrelation(request).requestId,
          model,
        )
      }
    })
    .onAfterResponse(({ callerRequestId, request, requestId, set }) => {
      const correlation = getOrCreateRequestCorrelation(request)
      const internalRequestId = requestId ?? correlation.requestId
      const status = typeof set.status === 'number' ? set.status : 200
      if (!runtimeStore.requests.complete(internalRequestId, status))
        return
      if (options?.logRequests === false)
        return

      const elapsed = formatElapsed(getRequestStart(request))
      const externalRequestId = callerRequestId ?? correlation.callerRequestId
      const modelMapping = getRequestModelMapping(request)
      logRequest(
        request.method,
        request.url,
        status,
        elapsed,
        modelMapping,
        internalRequestId,
        externalRequestId,
        getRequestAccountName(request),
      )
    })
    .onError(({ code, error, request, set }) => {
      const response = handleRouteError({ code, error, set })
      const status = response?.status
        ?? (error instanceof HTTPError ? error.status : 500)
      if (!isClientAbortError(error)) {
        runtimeStore.requests.recordError(
          getOrCreateRequestCorrelation(request).requestId,
          sanitizeObservedError(error, code, status),
        )
      }
      return response
    })
    .get('/', () => 'Server running')
    .get('/health', () => ({
      status: 'ok',
      copilotToken: !!authStore.copilotToken,
      modelsLoaded: !!modelCache.getModels(),
      version: VERSION,
    }))
    .use(createDashboardRoutes({ accountManager: options?.accountManager }))
    // Root-level routes: completions, models, embeddings, responses are registered here
    // for clients that omit the /v1 prefix. Token and usage routes are root-only
    // because they are proxy-specific endpoints, not part of any upstream API spec.
    .use(createCompletionRoutes())
    .use(createModelRoutes())
    .use(createEmbeddingRoutes())
    .use(createResponsesRoutes())
    .use(createTokenRoute())
    .use(createUsageRoute())
    // /v1-prefixed routes: mirrors the root-level API routes under /v1 for clients
    // that include the standard OpenAI/Anthropic prefix. Messages (Anthropic native)
    // is /v1-only since Anthropic clients always use /v1/messages.
    .group('/v1', (app) => {
      return app
        .use(createCompletionRoutes())
        .use(createModelRoutes())
        .use(createEmbeddingRoutes())
        .use(createResponsesRoutes())
        .use(createMessageRoutes())
    })

  return app
}
