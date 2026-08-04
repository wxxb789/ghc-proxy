import { cors } from '@elysiajs/cors'
import { node } from '@elysiajs/node'
import { Elysia } from 'elysia'

import { HTTPError } from './lib/error'
import { formatElapsed, getOrCreateRequestCorrelation, getRequestModelMapping, logRequest, setRequestModelMapping } from './lib/request-logger'
import { isTimeoutLikeError } from './lib/timeout-error'
import { createCompletionRoutes } from './routes/chat-completions/route'
import { createEmbeddingRoutes } from './routes/embeddings/route'
import { createMessageRoutes } from './routes/messages/route'
import { createModelRoutes } from './routes/models/route'
import { createResponsesRoutes } from './routes/responses/route'
import { createTokenRoute } from './routes/token/route'
import { createUsageRoute } from './routes/usage/route'
import { authStore, modelCache } from './state'
import { VERSION } from './util/version'

const isBun = typeof globalThis.Bun !== 'undefined'

export interface ServerOptions {
  idleTimeout?: number
}

/**
 * Maps a thrown error to a client response.
 *
 * `set.status` is written on every branch because `onError` returns a fresh
 * `Response` instead of falling through Elysia's normal path — `set.status`
 * would otherwise still hold whatever it was before the throw, and the access
 * log in `onAfterResponse` reads it. Without the write-back, a 504 is logged
 * as a 500.
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

  const message = error instanceof Error ? error.message : String(error)
  set.status = 500
  return Response.json(
    { error: { message, type: 'error' } },
    { status: 500 },
  )
}

export function createServer(options?: ServerOptions) {
  return new Elysia({
    adapter: isBun ? undefined : node(),
    serve: options?.idleTimeout !== undefined
      ? { idleTimeout: options.idleTimeout }
      : undefined,
  })
    .use(cors())
    .error({ HTTP: HTTPError })
    .derive(({ request }) => ({
      requestStart: Date.now(),
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
      }
    })
    .onAfterResponse(({ request, requestStart, requestId, set }) => {
      const elapsed = formatElapsed(requestStart)
      const status = typeof set.status === 'number' ? set.status : 200
      logRequest(request.method, request.url, status, elapsed, getRequestModelMapping(request), requestId)
    })
    .onError(({ code, error, set }) => handleRouteError({ code, error, set }))
    .get('/', () => 'Server running')
    .get('/health', () => ({
      status: 'ok',
      copilotToken: !!authStore.copilotToken,
      modelsLoaded: !!modelCache.getModels(),
      version: VERSION,
    }))
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
}
