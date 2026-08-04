import { Elysia } from 'elysia'

import { deliverResult } from '~/deliver'
import { getOrCreateRequestCorrelation } from '~/lib/request-logger'
import { disableIdleTimeout, hasStreamingFlag } from '~/lib/request-timeout'
import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleCompletionCore } from './handler'

export function createCompletionRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .post('/chat/completions', async function* ({ body, request, server }) {
      if (hasStreamingFlag(body)) {
        disableIdleTimeout(server, request)
      }

      const { result, modelMapping } = await handleCompletionCore({
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
}
