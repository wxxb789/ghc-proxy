import { Elysia } from 'elysia'

import { handleModelsCore } from './handler'

export { handleModelsCore } from './handler'

export const modelRoutes = new Elysia()
  .get('/models', async () => {
    return handleModelsCore()
  })
  .get('/v1/models', async () => {
    return handleModelsCore()
  })
