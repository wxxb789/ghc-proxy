import { Elysia } from 'elysia'

import { handleModelsCore } from './handler'

export function createModelRoutes() {
  return new Elysia()
    .get('/models', async () => {
      return handleModelsCore()
    })
}
