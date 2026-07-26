import { Elysia } from 'elysia'

import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleEmbeddingsCore } from './handler'

export function createEmbeddingRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .post('/embeddings', async ({ body, request }) => {
      return handleEmbeddingsCore(body, request.headers, undefined, request.signal)
    }, { guarded: true })
}
