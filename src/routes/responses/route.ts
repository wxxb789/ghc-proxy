import { Elysia } from 'elysia'

import { sseAdapter } from '~/lib/sse-adapter'
import { runRequestGuard } from '~/routes/middleware/request-guard'

import { handleResponsesCore } from './handler'
import {
  handleCreateResponseInputTokensCore,
  handleDeleteResponseCore,
  handleListResponseInputItemsCore,
  handleRetrieveResponseCore,
} from './resource-handler'

export const responsesRoutes = new Elysia()
  .post('/responses', async function* ({ body, request }) {
    await runRequestGuard()
    const result = await handleResponsesCore({
      body,
      signal: request.signal,
      headers: request.headers,
    })
    if (result.kind === 'json') {
      return result.data
    }
    yield* sseAdapter(result.generator)
  })
  .post('/v1/responses', async function* ({ body, request }) {
    await runRequestGuard()
    const result = await handleResponsesCore({
      body,
      signal: request.signal,
      headers: request.headers,
    })
    if (result.kind === 'json') {
      return result.data
    }
    yield* sseAdapter(result.generator)
  })
  .post('/responses/input_tokens', async ({ body, request }) => {
    await runRequestGuard()
    return handleCreateResponseInputTokensCore({
      body,
      headers: request.headers,
      signal: request.signal,
    })
  })
  .post('/v1/responses/input_tokens', async ({ body, request }) => {
    await runRequestGuard()
    return handleCreateResponseInputTokensCore({
      body,
      headers: request.headers,
      signal: request.signal,
    })
  })
  .get('/responses/:responseId/input_items', async ({ params, request }) => {
    await runRequestGuard()
    return handleListResponseInputItemsCore({
      params,
      url: request.url,
      headers: request.headers,
      signal: request.signal,
    })
  })
  .get('/v1/responses/:responseId/input_items', async ({ params, request }) => {
    await runRequestGuard()
    return handleListResponseInputItemsCore({
      params,
      url: request.url,
      headers: request.headers,
      signal: request.signal,
    })
  })
  .get('/responses/:responseId', async ({ params, request }) => {
    await runRequestGuard()
    return handleRetrieveResponseCore({
      params,
      url: request.url,
      headers: request.headers,
      signal: request.signal,
    })
  })
  .get('/v1/responses/:responseId', async ({ params, request }) => {
    await runRequestGuard()
    return handleRetrieveResponseCore({
      params,
      url: request.url,
      headers: request.headers,
      signal: request.signal,
    })
  })
  .delete('/responses/:responseId', async ({ params, request }) => {
    await runRequestGuard()
    return handleDeleteResponseCore({
      params,
      headers: request.headers,
      signal: request.signal,
    })
  })
  .delete('/v1/responses/:responseId', async ({ params, request }) => {
    await runRequestGuard()
    return handleDeleteResponseCore({
      params,
      headers: request.headers,
      signal: request.signal,
    })
  })
