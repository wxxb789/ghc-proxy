import { Elysia } from 'elysia'

import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleModelsCore } from './handler'

export function createModelRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .get('/models', async () => {
      return handleModelsCore()
    }, { guarded: true })
}
