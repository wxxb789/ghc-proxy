import type { CopilotClient } from '~/clients'

import { Elysia } from 'elysia'

import { deliverResult } from '~/deliver'
import { throwInvalidRequestError } from '~/lib/error'
import { getOrCreateRequestCorrelation } from '~/lib/request-logger'
import { disableIdleTimeout } from '~/lib/request-timeout'
import { ClientAbortError } from '~/lib/upstream-signal'
import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleImagesCore } from './handler'

async function readImageBody(request: Request, allowMultipart: boolean): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  const multipart = allowMultipart && contentType === 'multipart/form-data'
  if (!multipart && contentType !== 'application/json') {
    throwInvalidRequestError(
      allowMultipart
        ? 'Content-Type must be application/json or multipart/form-data.'
        : 'Content-Type must be application/json.',
      'body',
    )
  }
  try {
    return multipart ? await request.formData() : await request.json()
  }
  catch {
    if (request.signal.aborted)
      throw new ClientAbortError()
    throwInvalidRequestError(
      multipart ? 'The multipart request body could not be parsed.' : 'The request body must be valid JSON.',
      'body',
    )
  }
}

export function createImageRoutes(client?: CopilotClient) {
  return new Elysia()
    .use(requestGuardPlugin)
    .post('/images/generations', async function* ({ request, server }) {
      disableIdleTimeout(server, request)
      const { requestId } = getOrCreateRequestCorrelation(request)
      const result = await handleImagesCore({
        operation: 'generations',
        body: await readImageBody(request, false),
        request,
        requestId,
        client,
      })
      const delivery = deliverResult(request, result)
      if (!delivery.streaming)
        return delivery.data
      yield* delivery.stream
    }, { guarded: true, parse: 'none' })
    .post('/images/edits', async function* ({ request, server }) {
      disableIdleTimeout(server, request)
      const { requestId } = getOrCreateRequestCorrelation(request)
      const result = await handleImagesCore({
        operation: 'edits',
        body: await readImageBody(request, true),
        request,
        requestId,
        client,
      })
      const delivery = deliverResult(request, result)
      if (!delivery.streaming)
        return delivery.data
      yield* delivery.stream
    }, { guarded: true, parse: 'none' })
}
