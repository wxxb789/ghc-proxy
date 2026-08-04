import { Elysia } from 'elysia'

import { deliverResult } from '~/deliver'
import { getOrCreateRequestCorrelation } from '~/lib/request-logger'
import { disableIdleTimeout, hasStreamingFlag } from '~/lib/request-timeout'
import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleCountTokensCore } from './count-tokens-handler'
import { handleMessagesCore } from './handler'

export function createMessageRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .post('/messages', async function* ({ body, request, server }) {
      if (hasStreamingFlag(body)) {
        disableIdleTimeout(server, request)
      }

      const { result, modelMapping } = await handleMessagesCore({
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
    .post('/messages/count_tokens', async ({ body, request }) => {
      return handleCountTokensCore({
        body,
        headers: request.headers,
      })
    }, { guarded: true })
}
