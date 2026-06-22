import type { ServerSentEventMessage } from 'fetch-event-stream'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { HTTPError } from '~/lib/error'
import { createApp } from './helpers'

// ── retryWithBackoff: mock the sleep module before importing retry so backoff
//    delays are observed without real waiting. ──
const sleepMock = mock((_ms: number) => Promise.resolve())
await mock.module('../src/util/sleep', () => ({
  sleep: sleepMock,
}))

const { retryWithBackoff, formatErrorMessage } = await import('../src/lib/retry')

// ── Snapshot/restore CopilotClient.prototype.createChatCompletions for the
//    describes that stub it, so the stub never leaks into the retry tests. ──
function useCreateChatCompletionsSnapshot() {
  let original: typeof CopilotClient.prototype.createChatCompletions

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
    original
      = descriptor.value as typeof CopilotClient.prototype.createChatCompletions
  })

  afterEach(() => {
    CopilotClient.prototype.createChatCompletions = original
  })
}

function makeRequest(options?: { stream?: boolean }) {
  return createApp('messages').handle(new Request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4.5',
      max_tokens: 64,
      stream: options?.stream ?? false,
      messages: [{ role: 'user', content: 'Hello!' }],
    }),
  }))
}

function createAbortErrorAsError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

describe('Error classification in onError handler', () => {
  useCreateChatCompletionsSnapshot()

  test('AbortError (Error subclass) returns 504', async () => {
    CopilotClient.prototype.createChatCompletions = () =>
      Promise.reject(createAbortErrorAsError())

    const response = await makeRequest()

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

    const response = await makeRequest()

    expect(response.status).toBe(500)
    const json = await response.json()
    expect(json).toEqual({
      error: {
        message: 'Something went wrong',
        type: 'error',
      },
    })
  })

  test('HTTPError returns upstream status code via toResponse()', async () => {
    const { HTTPError } = await import('~/lib/error')
    const httpError = new HTTPError(429, {
      error: { message: 'Upstream error', type: 'error' },
    })
    CopilotClient.prototype.createChatCompletions = () =>
      Promise.reject(httpError)

    const response = await makeRequest()

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

describe('Streaming error handling', () => {
  useCreateChatCompletionsSnapshot()

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

  test('converts TimeoutError to Anthropic SSE error event', async () => {
    CopilotClient.prototype.createChatCompletions = (_payload, _options) =>
      Promise.resolve(createTimeoutStream())

    const response = await makeRequest({ stream: true })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('event: error')
    expect(body).toContain(
      'Upstream streaming request timed out. Please retry.',
    )
  })
})

describe('retryWithBackoff', () => {
  test('returns result on first success', async () => {
    sleepMock.mockClear()
    const fn = mock(() => Promise.resolve('ok'))

    const result = await retryWithBackoff(fn)

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
  })

  test('retries on transient error then succeeds', async () => {
    sleepMock.mockClear()
    let calls = 0
    const fn = mock(() => {
      calls++
      if (calls <= 2)
        throw new Error('network failure')
      return Promise.resolve('recovered')
    })

    const result = await retryWithBackoff(fn)

    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(sleepMock).toHaveBeenCalledTimes(2)
    expect(sleepMock.mock.calls[0]![0]).toBe(5_000)
    expect(sleepMock.mock.calls[1]![0]).toBe(10_000)
  })

  test('exhausts all retries then throws', async () => {
    sleepMock.mockClear()
    const error = new Error('persistent failure')
    const fn = mock(() => Promise.reject(error))

    await expect(retryWithBackoff(fn, { maxRetries: 3 })).rejects.toThrow('persistent failure')

    expect(fn).toHaveBeenCalledTimes(4) // 1 initial + 3 retries
    expect(sleepMock).toHaveBeenCalledTimes(3)
    expect(sleepMock.mock.calls[0]![0]).toBe(5_000)
    expect(sleepMock.mock.calls[1]![0]).toBe(10_000)
    expect(sleepMock.mock.calls[2]![0]).toBe(20_000)
  })

  test('skips retry when shouldRetry returns false', async () => {
    sleepMock.mockClear()
    const httpError = new HTTPError(401, {
      error: { message: 'Unauthorized', type: 'auth_error' },
    })
    const fn = mock(() => Promise.reject(httpError))

    await expect(
      retryWithBackoff(fn, { shouldRetry: e => !(e instanceof HTTPError) }),
    ).rejects.toThrow(httpError)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
  })

  test('calls onRetry callback before each retry', async () => {
    sleepMock.mockClear()
    let calls = 0
    const fn = mock(() => {
      calls++
      if (calls <= 2)
        throw new Error('fail')
      return Promise.resolve('ok')
    })
    const onRetry = mock((_error: unknown, _attempt: number, _delayMs: number) => {})

    await retryWithBackoff(fn, { onRetry })

    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0]![1]).toBe(0) // attempt 0
    expect(onRetry.mock.calls[0]![2]).toBe(5_000) // delay
    expect(onRetry.mock.calls[1]![1]).toBe(1) // attempt 1
    expect(onRetry.mock.calls[1]![2]).toBe(10_000) // delay
  })

  test('respects custom baseDelayMs', async () => {
    sleepMock.mockClear()
    let calls = 0
    const fn = mock(() => {
      calls++
      if (calls <= 1)
        throw new Error('fail')
      return Promise.resolve('ok')
    })

    await retryWithBackoff(fn, { baseDelayMs: 1_000 })

    expect(sleepMock.mock.calls[0]![0]).toBe(1_000)
  })
})

describe('formatErrorMessage', () => {
  test('extracts message from Error', () => {
    expect(formatErrorMessage(new Error('test'))).toBe('test')
  })

  test('converts non-Error to string', () => {
    expect(formatErrorMessage('raw string')).toBe('raw string')
    expect(formatErrorMessage(42)).toBe('42')
    expect(formatErrorMessage(null)).toBe('null')
  })
})
