import { Elysia } from 'elysia'

import { sseAdapter } from '~/lib/sse-adapter'
import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleCompletionCore } from './handler'

export function createCompletionRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .post('/chat/completions', async function* (ctx) {
      const { body, request } = ctx
      const { result, modelMapping } = await handleCompletionCore({
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
}
