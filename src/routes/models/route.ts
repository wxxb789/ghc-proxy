import { Elysia } from 'elysia'

import { createRequestRecoveryRecord } from '~/clients/factory'
import { getOrCreateRequestCorrelation } from '~/lib/request-logger'
import { requestGuardPlugin } from '~/routes/middleware/request-guard'
import { runtimeStore } from '~/state'

import { handleModelsCore } from './handler'

export function createModelRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .get('/models', async ({ request }) => {
      const { requestId } = getOrCreateRequestCorrelation(request)
      return handleModelsCore(
        undefined,
        createRequestRecoveryRecord(request),
        request.signal,
        () => runtimeStore.requests.markAborted(requestId),
      )
    }, { guarded: true })
}
