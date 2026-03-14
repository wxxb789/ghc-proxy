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
