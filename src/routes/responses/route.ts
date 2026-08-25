import { Elysia } from 'elysia'

import { createRequestRecoveryRecord } from '~/clients/factory'
import { deliverResult } from '~/deliver'
import { getOrCreateRequestCorrelation } from '~/lib/request-logger'
import { disableIdleTimeout, hasStreamingResponsesQuery } from '~/lib/request-timeout'
import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleResponsesCore } from './handler'
import {
  handleCreateResponseInputTokensCore,
  handleDeleteResponseCore,
  handleListResponseInputItemsCore,
  handleRetrieveResponseCore,
} from './resource-handler'

export function createResponsesRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .post('/responses', async function* ({ body, request, server }) {
      disableIdleTimeout(server, request)

      const { result, modelMapping } = await handleResponsesCore({
        body,
        signal: request.signal,
        headers: request.headers,
        ...getOrCreateRequestCorrelation(request),
      })
      const delivery = deliverResult(request, result, modelMapping)
      if (!delivery.streaming)
        return delivery.data
      yield* delivery.stream
    }, { guarded: true })
    .post('/responses/input_tokens', async ({ body, request, server }) => {
      disableIdleTimeout(server, request)
      return handleCreateResponseInputTokensCore({
        body,
        headers: request.headers,
        signal: request.signal,
        recovery: createRequestRecoveryRecord(request),
      })
    }, { guarded: true })
    .get('/responses/:responseId/input_items', async ({ params, request }) => {
      return handleListResponseInputItemsCore({
        params,
        url: request.url,
        headers: request.headers,
        signal: request.signal,
        recovery: createRequestRecoveryRecord(request),
      })
    }, { guarded: true })
    .get('/responses/:responseId', async ({ params, request, server }) => {
      if (hasStreamingResponsesQuery(request)) {
        disableIdleTimeout(server, request)
      }

      return handleRetrieveResponseCore({
        params,
        url: request.url,
        headers: request.headers,
        signal: request.signal,
        recovery: createRequestRecoveryRecord(request),
      })
    }, { guarded: true })
    .delete('/responses/:responseId', async ({ params, request }) => {
      return handleDeleteResponseCore({
        params,
        headers: request.headers,
        signal: request.signal,
        recovery: createRequestRecoveryRecord(request),
      })
    }, { guarded: true })
}
