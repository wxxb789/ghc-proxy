import { Elysia } from 'elysia'

import { handleEmbeddingsCore } from './handler'

export { handleEmbeddingsCore } from './handler'

export const embeddingRoutes = new Elysia()
  .post('/embeddings', async ({ body }) => {
    return handleEmbeddingsCore(body)
  })
  .post('/v1/embeddings', async ({ body }) => {
    return handleEmbeddingsCore(body)
  })
