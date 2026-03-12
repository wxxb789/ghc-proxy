import { Elysia } from 'elysia'

import { sseAdapter } from '~/lib/sse-adapter'
import { runRequestGuard } from '~/routes/middleware/request-guard'

import { handleCompletionCore } from './handler'

export const completionRoutes = new Elysia()
  .post('/chat/completions', async function* ({ body, request }) {
    await runRequestGuard()
    const result = await handleCompletionCore({
      body,
      signal: request.signal,
      headers: request.headers,
    })
    if (result.kind === 'json') {
      return result.data
    }
    yield* sseAdapter(result.generator)
  })
  .post('/v1/chat/completions', async function* ({ body, request }) {
    await runRequestGuard()
    const result = await handleCompletionCore({
      body,
      signal: request.signal,
      headers: request.headers,
    })
    if (result.kind === 'json') {
      return result.data
    }
    yield* sseAdapter(result.generator)
  })
