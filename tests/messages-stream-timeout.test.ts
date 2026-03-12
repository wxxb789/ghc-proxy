import type { ServerSentEventMessage } from 'fetch-event-stream'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'

import { CopilotClient } from '~/clients'
import { HTTPError } from '~/lib/error'
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

    const app = new Elysia()
      .error({ HTTP: HTTPError })
      .onError(({ code, error }) => {
        if (code === 'HTTP')
          return
        if (error instanceof Error && error.name === 'AbortError') {
          return Response.json(
            { error: { message: 'Upstream request was aborted', type: 'timeout_error' } },
            { status: 504 },
          )
        }
        const message = error instanceof Error ? error.message : String(error)
        return Response.json(
          { error: { message, type: 'error' } },
          { status: 500 },
        )
      })
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

    const response = await app.handle(new Request('http://localhost/v1/messages', {
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
    }))

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('event: error')
    expect(body).toContain(
      'Upstream streaming request timed out. Please retry.',
    )
  })
})
