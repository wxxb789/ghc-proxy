import { Elysia } from 'elysia'

import { setRequestModelMapping } from '~/lib/request-logger'
import { sseAdapter } from '~/lib/sse-adapter'
import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleCompletionCore } from './handler'

export function createCompletionRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .post('/chat/completions', async function* ({ body, request }) {
      const { result, modelMapping } = await handleCompletionCore({
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
}
