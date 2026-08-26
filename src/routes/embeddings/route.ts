import { Elysia } from 'elysia'

import { createRequestRecoveryRecord } from '~/clients/factory'
import { getOrCreateRequestCorrelation } from '~/lib/request-logger'
import { requestGuardPlugin } from '~/routes/middleware/request-guard'
import { runtimeStore } from '~/state'

import { handleEmbeddingsCore } from './handler'

export function createEmbeddingRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .post('/embeddings', async ({ body, request }) => {
      const { requestId } = getOrCreateRequestCorrelation(request)
      return handleEmbeddingsCore(
        body,
        request.headers,
        undefined,
        request.signal,
        createRequestRecoveryRecord(request),
        () => runtimeStore.requests.markAborted(requestId),
      )
    }, { guarded: true })
}
