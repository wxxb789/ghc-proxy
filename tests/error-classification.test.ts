import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'

import { CopilotClient } from '~/clients'
import { createErrorResponse } from '~/lib/error'
import { sseAdapter } from '~/lib/sse-adapter'
import { handleMessagesCore } from '~/routes/messages/handler'
import { runRequestGuard } from '~/routes/middleware/request-guard'

let originalCreateChatCompletions: typeof CopilotClient.prototype.createChatCompletions

beforeEach(() => {
  const descriptor = Object.getOwnPropertyDescriptor(
    CopilotClient.prototype,
    'createChatCompletions',
  )
  if (!descriptor?.value) {
    throw new Error(
      'createChatCompletions not found on CopilotClient prototype',
    )
  }
  originalCreateChatCompletions
    = descriptor.value as typeof CopilotClient.prototype.createChatCompletions
})

afterEach(() => {
  CopilotClient.prototype.createChatCompletions = originalCreateChatCompletions
})

function createAbortErrorAsError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function createTestApp() {
  return new Elysia()
    .onError(async ({ error }) => createErrorResponse(error))
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
}

function makeRequest(app: ReturnType<typeof createTestApp>) {
  return app.handle(new Request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4.5',
      max_tokens: 64,
      stream: false,
      messages: [{ role: 'user', content: 'Hello!' }],
    }),
  }))
}

describe('Error classification in createErrorResponse', () => {
  test('AbortError (Error subclass) returns 504', async () => {
    CopilotClient.prototype.createChatCompletions = () =>
      Promise.reject(createAbortErrorAsError())

    const app = createTestApp()
    const response = await makeRequest(app)

    expect(response.status).toBe(504)
    const json = await response.json()
    expect(json).toEqual({
      error: {
        message: 'Upstream request was aborted',
        type: 'timeout_error',
      },
    })
  })

  test('Generic Error returns 500', async () => {
    const genericError = new Error('Something went wrong')
    CopilotClient.prototype.createChatCompletions = () =>
      Promise.reject(genericError)

    const app = createTestApp()
    const response = await makeRequest(app)

    expect(response.status).toBe(500)
    const json = await response.json()
    expect(json).toEqual({
      error: {
        message: 'Something went wrong',
        type: 'error',
      },
    })
  })

  test('HTTPError returns upstream status code', async () => {
    const { HTTPError } = await import('~/lib/error')
    const mockResponse = new Response('Upstream error', { status: 429 })
    const httpError = new HTTPError('Rate limited', mockResponse)
    CopilotClient.prototype.createChatCompletions = () =>
      Promise.reject(httpError)

    const app = createTestApp()
    const response = await makeRequest(app)

    expect(response.status).toBe(429)
    const json = await response.json()
    expect(json).toEqual({
      error: {
        message: 'Upstream error',
        type: 'error',
      },
    })
  })
})
