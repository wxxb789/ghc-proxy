import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import { CopilotClient } from '~/clients'
import { forwardError, HTTPError } from '~/lib/error'
import { handleCompletion as handleMessages } from '~/routes/messages/handler'

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

function createAbortErrorAsDOMException(): DOMException {
  const DOMExceptionCtor = DOMException as unknown as {
    new (message?: string, name?: string): DOMException
  }
  return new DOMExceptionCtor('The operation was aborted.', 'AbortError')
}

function createAbortErrorAsError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

describe('Error classification in forwardError', () => {
  test('AbortError (DOMException) returns 504', async () => {
    CopilotClient.prototype.createChatCompletions = () =>
      Promise.reject(createAbortErrorAsDOMException())

    const app = new Hono()
    app.onError((error, c) => forwardError(c, error))
    app.post('/v1/messages', c => handleMessages(c))

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        max_tokens: 64,
        stream: false,
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    })

    expect(response.status).toBe(504)
    const json = await response.json()
    expect(json).toEqual({
      error: {
        message: 'Upstream request was aborted',
        type: 'timeout_error',
      },
    })
  })

  test('AbortError (Error subclass) returns 504', async () => {
    CopilotClient.prototype.createChatCompletions = () =>
      Promise.reject(createAbortErrorAsError())

    const app = new Hono()
    app.onError((error, c) => forwardError(c, error))
    app.post('/v1/messages', c => handleMessages(c))

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        max_tokens: 64,
        stream: false,
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    })

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

    const app = new Hono()
    app.onError((error, c) => forwardError(c, error))
    app.post('/v1/messages', c => handleMessages(c))

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        max_tokens: 64,
        stream: false,
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    })

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
    const mockResponse = new Response('Upstream error', { status: 429 })
    const httpError = new HTTPError('Rate limited', mockResponse)
    CopilotClient.prototype.createChatCompletions = () =>
      Promise.reject(httpError)

    const app = new Hono()
    app.onError((error, c) => forwardError(c, error))
    app.post('/v1/messages', c => handleMessages(c))

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        max_tokens: 64,
        stream: false,
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    })

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
