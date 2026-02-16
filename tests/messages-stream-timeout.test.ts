import type { ServerSentEventMessage } from 'fetch-event-stream'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import { CopilotClient } from '~/clients'
import { forwardError } from '~/lib/error'
import { handleCompletion } from '~/routes/messages/handler'

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

function createTimeoutError(): DOMException {
  const DOMExceptionCtor = DOMException as unknown as {
    new (message?: string, name?: string): DOMException
  }
  return new DOMExceptionCtor('The operation timed out.', 'TimeoutError')
}

async function* createTimeoutStream(): AsyncGenerator<
  ServerSentEventMessage,
  void,
  unknown
> {
  await Promise.resolve()
  throw createTimeoutError()
  yield { data: '' }
}

const timeoutCreateChatCompletions: typeof CopilotClient.prototype.createChatCompletions
  = (_payload, _options) => Promise.resolve(createTimeoutStream())

describe('POST /v1/messages streaming error handling', () => {
  test('converts TimeoutError to Anthropic SSE error event', async () => {
    CopilotClient.prototype.createChatCompletions = timeoutCreateChatCompletions

    const app = new Hono()
    app.onError((error, c) => forwardError(c, error))
    app.post('/v1/messages', c => handleCompletion(c))

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('event: error')
    expect(body).toContain(
      'Upstream streaming request timed out. Please retry.',
    )
  })
})
