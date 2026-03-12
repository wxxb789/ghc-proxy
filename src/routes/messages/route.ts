import { Elysia } from 'elysia'

import { sseAdapter } from '~/lib/sse-adapter'
import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleCountTokensCore } from './count-tokens-handler'
import { handleMessagesCore } from './handler'

export function createMessageRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .post('/messages', async function* (ctx) {
      const { body, request } = ctx
      const { result, modelMapping } = await handleMessagesCore({
        body,
        signal: request.signal,
        headers: request.headers,
      })
      if ('requestMeta' in ctx && ctx.requestMeta && typeof ctx.requestMeta === 'object') {
        (ctx.requestMeta as { modelMapping: unknown }).modelMapping = modelMapping
      }
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
