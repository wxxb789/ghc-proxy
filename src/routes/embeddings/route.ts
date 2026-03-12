import { Elysia } from 'elysia'

import { handleEmbeddingsCore } from './handler'

export function createEmbeddingRoutes() {
  return new Elysia()
    .post('/embeddings', async ({ body }) => {
      return handleEmbeddingsCore(body)
    })
}
