import { Elysia } from 'elysia'

import { sseAdapter } from '~/lib/sse-adapter'
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
    .post('/responses', async function* ({ body, request }) {
      const result = await handleResponsesCore({
        body,
        signal: request.signal,
        headers: request.headers,
      })
      if (result.kind === 'json') {
        return result.data
      }
      yield* sseAdapter(result.generator)
    }, { guarded: true })
    .post('/responses/input_tokens', async ({ body, request }) => {
      return handleCreateResponseInputTokensCore({
        body,
        headers: request.headers,
        signal: request.signal,
      })
    }, { guarded: true })
    .get('/responses/:responseId/input_items', async ({ params, request }) => {
      return handleListResponseInputItemsCore({
        params,
        url: request.url,
        headers: request.headers,
        signal: request.signal,
      })
    })
    .get('/responses/:responseId', async ({ params, request }) => {
      return handleRetrieveResponseCore({
        params,
        url: request.url,
        headers: request.headers,
        signal: request.signal,
      })
    })
    .delete('/responses/:responseId', async ({ params, request }) => {
      return handleDeleteResponseCore({
        params,
        headers: request.headers,
        signal: request.signal,
      })
    })
}
