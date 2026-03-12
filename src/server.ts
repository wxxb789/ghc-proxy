import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'

import { createErrorResponse } from './lib/error'
import { computeElapsed, logRequest } from './lib/request-logger'
import { completionRoutes } from './routes/chat-completions/route'
import { embeddingRoutes } from './routes/embeddings/route'
import { messageRoutes } from './routes/messages/route'
import { modelRoutes } from './routes/models/route'
import { responsesRoutes } from './routes/responses/route'
import { tokenRoute } from './routes/token/route'
import { usageRoute } from './routes/usage/route'

export const server = new Elysia()
  .use(cors())
  .derive(({ request }) => {
    return {
      requestStart: Date.now(),
      requestMethod: request.method,
      requestUrl: request.url,
      modelMappingInfo: undefined as
      | { originalModel?: string, mappedModel?: string }
      | undefined,
    }
  })
  .onAfterHandle(({ requestMethod, requestUrl, requestStart, modelMappingInfo, set }) => {
    const elapsed = computeElapsed(requestStart)
    const status = typeof set.status === 'number' ? set.status : 200
    logRequest(requestMethod, requestUrl, status, elapsed, modelMappingInfo)
  })
  .onError(async ({ error }) => {
    return createErrorResponse(error)
  })
  .get('/', () => 'Server running')
  .use(completionRoutes)
  .use(modelRoutes)
  .use(embeddingRoutes)
  .use(usageRoute)
  .use(tokenRoute)
  .use(responsesRoutes)
  .use(messageRoutes)
