import { Elysia } from 'elysia'

import { createRequestRecoveryRecord } from '~/clients/factory'
import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleModelsCore } from './handler'

export function createModelRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .get('/models', async ({ request }) => {
      return handleModelsCore(undefined, createRequestRecoveryRecord(request))
    }, { guarded: true })
}
