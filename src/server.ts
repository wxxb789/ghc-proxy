import { cors } from '@elysiajs/cors'
import { node } from '@elysiajs/node'
import { Elysia } from 'elysia'

import { HTTPError } from './lib/error'
import { formatElapsed, getRequestModelMapping, logRequest, setRequestModelMapping } from './lib/request-logger'
import { createCompletionRoutes } from './routes/chat-completions/route'
import { createEmbeddingRoutes } from './routes/embeddings/route'
import { createMessageRoutes } from './routes/messages/route'
import { createModelRoutes } from './routes/models/route'
import { createResponsesRoutes } from './routes/responses/route'
import { createTokenRoute } from './routes/token/route'
import { createUsageRoute } from './routes/usage/route'

const isBun = typeof globalThis.Bun !== 'undefined'

export interface ServerOptions {
  idleTimeout?: number
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
    .derive(() => ({
      requestStart: Date.now(),
    }))
    .onBeforeHandle(({ body, request }) => {
      if (request.method !== 'POST')
        return
      const model = body && typeof body === 'object' && 'model' in body
        ? (body as Record<string, unknown>).model
        : undefined
      if (typeof model === 'string') {
        setRequestModelMapping(request, { originalModel: model, mappedModel: model })
      }
    })
    .onAfterResponse(({ request, requestStart, set }) => {
      const elapsed = formatElapsed(requestStart)
      const status = typeof set.status === 'number' ? set.status : 200
      logRequest(request.method, request.url, status, elapsed, getRequestModelMapping(request))
    })
    .onError(({ code, error }) => {
      // HTTPError is auto-handled via toResponse() — just let it through
      if (code === 'HTTP')
        return

      if (error instanceof Error && error.name === 'AbortError') {
        return Response.json(
          { error: { message: 'Upstream request was aborted', type: 'timeout_error' } },
          { status: 504 },
        )
      }

      const message = error instanceof Error ? error.message : String(error)
      return Response.json(
        { error: { message, type: 'error' } },
        { status: 500 },
      )
    })
    .get('/', () => 'Server running')
    .use(createCompletionRoutes())
    .use(createModelRoutes())
    .use(createEmbeddingRoutes())
    .use(createResponsesRoutes())
    .use(createTokenRoute())
    .use(createUsageRoute())
    .group('/v1', (app) => {
      return app
        .use(createCompletionRoutes())
        .use(createModelRoutes())
        .use(createEmbeddingRoutes())
        .use(createResponsesRoutes())
        .use(createMessageRoutes())
    })
}
