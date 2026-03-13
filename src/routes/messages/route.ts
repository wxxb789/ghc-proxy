import { Elysia } from 'elysia'

import { setRequestModelMapping } from '~/lib/request-logger'
import { sseAdapter } from '~/lib/sse-adapter'
import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleCountTokensCore } from './count-tokens-handler'
import { handleMessagesCore } from './handler'

export function createMessageRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .post('/messages', async function* ({ body, request }) {
      const { result, modelMapping } = await handleMessagesCore({
        body,
        signal: request.signal,
        headers: request.headers,
      })
      if (modelMapping)
        setRequestModelMapping(request, modelMapping)
      if (result.kind === 'json') {
        return result.data
      }
      yield* sseAdapter(result.generator)
    }, { guarded: true })
    .post('/messages/count_tokens', async ({ body, request }) => {
      return handleCountTokensCore({
        body,
        headers: request.headers,
      })
    }, { guarded: true })
}
