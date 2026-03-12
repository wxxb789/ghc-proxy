import { Elysia } from 'elysia'

import { sseAdapter } from '~/lib/sse-adapter'
import { runRequestGuard } from '~/routes/middleware/request-guard'

import { handleCountTokensCore } from './count-tokens-handler'
import { handleMessagesCore } from './handler'

export const messageRoutes = new Elysia()
  .post('/v1/messages', async function* ({ body, request }) {
    await runRequestGuard()
    const { result } = await handleMessagesCore({
      body,
      signal: request.signal,
      headers: request.headers,
    })
    if (result.kind === 'json') {
      return result.data
    }
    yield* sseAdapter(result.generator)
  })
  .post('/v1/messages/count_tokens', async ({ body, request }) => {
    return handleCountTokensCore({
      body,
      headers: request.headers,
    })
  })
