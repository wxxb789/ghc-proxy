import type { ModelMappingInfo } from './lib/request-logger'

import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'

import { HTTPError } from './lib/error'
import { formatElapsed, logRequest } from './lib/request-logger'
import { createCompletionRoutes } from './routes/chat-completions/route'
import { createEmbeddingRoutes } from './routes/embeddings/route'
import { createMessageRoutes } from './routes/messages/route'
import { createModelRoutes } from './routes/models/route'
import { createResponsesRoutes } from './routes/responses/route'
import { createTokenRoute } from './routes/token/route'
import { createUsageRoute } from './routes/usage/route'

export interface ServerOptions {
  idleTimeout?: number
}

export function createServer(options?: ServerOptions) {
  return new Elysia({
    serve: options?.idleTimeout !== undefined
      ? { idleTimeout: options.idleTimeout }
      : undefined,
  })
    .use(cors())
    .error({ HTTP: HTTPError })
    .derive(() => {
      return {
        requestStart: Date.now(),
        requestMeta: {
          modelMapping: undefined as ModelMappingInfo | undefined,
        },
      }
    })
    .onAfterHandle(({ request, requestStart, requestMeta, set }) => {
      const elapsed = formatElapsed(requestStart)
      const status = typeof set.status === 'number' ? set.status : 200
      logRequest(request.method, request.url, status, elapsed, requestMeta.modelMapping)
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
