import { Elysia } from 'elysia'

import { createRequestRecoveryRecord } from '~/clients/factory'
import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleSystemOneCore } from './handler'

export function createSystemOneRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .post('/systemone', ({ body, request }) => handleSystemOneCore({
      body,
      request,
      recovery: createRequestRecoveryRecord(request),
    }), { guarded: true })
}
