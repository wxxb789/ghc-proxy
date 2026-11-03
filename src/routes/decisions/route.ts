import { Elysia } from 'elysia'

import { createRequestRecoveryRecord } from '~/clients/factory'
import { getOrCreateRequestCorrelation } from '~/lib/request-logger'
import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleDecisionsCore } from './handler'

export function createDecisionRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .post('/decisions', async ({ body, request }) => {
      const { requestId } = getOrCreateRequestCorrelation(request)
      return handleDecisionsCore({
        body,
        signal: request.signal,
        headers: request.headers,
        request,
        requestId,
        recovery: createRequestRecoveryRecord(request),
      })
    }, { guarded: true })
}
