import type { ServerSentEventMessage } from 'fetch-event-stream'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { HTTPError } from '~/lib/error'
import { createServer } from '~/server'
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

/**
 * Bun's `fetch` enforces a built-in ~300s ceiling that fires before the
 * configured upstream timeout can, and rejects with a `DOMException` named
 * `TimeoutError` — not `AbortError`.
 */
function createBunFetchTimeoutError(): DOMException {
  const DOMExceptionCtor = DOMException as unknown as {
    new (message?: string, name?: string): DOMException
  }
  return new DOMExceptionCtor('The operation timed out.', 'TimeoutError')
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
        message: 'Upstream request timed out before a response was received.',
        type: 'timeout_error',
      },
    })
  })

  // Regression: Bun's fetch ceiling rejects with `TimeoutError`, which the
  // classifier used to miss — the request surfaced as a generic 500 carrying
  // the raw DOMException message.
  for (const stream of [false, true]) {
    test(`Bun fetch TimeoutError returns 504 (stream=${stream})`, async () => {
      CopilotClient.prototype.createChatCompletions = () =>
        Promise.reject(createBunFetchTimeoutError())

      const response = await makeRequest({ stream })

      expect(response.status).toBe(504)
      const json = await response.json()
      expect(json).toEqual({
        error: {
          message: 'Upstream request timed out before a response was received.',
          type: 'timeout_error',
        },
      })
    })
  }

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

  async function* createTimeoutStream(): AsyncGenerator<
    ServerSentEventMessage,
    void,
    unknown
  > {
    await Promise.resolve()
    throw createBunFetchTimeoutError()
    yield { data: '' }
  }

  // The transducer's timeout classifier used to recognize only TimeoutError,
  // so a proxy-side abort produced the generic "unexpected error" frame.
  async function* createAbortErrorStream(): AsyncGenerator<
    ServerSentEventMessage,
    void,
    unknown
  > {
    await Promise.resolve()
    throw createAbortErrorAsError()
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

  test('converts AbortError to the same timeout SSE error event', async () => {
    CopilotClient.prototype.createChatCompletions = (_payload, _options) =>
      Promise.resolve(createAbortErrorStream())

    const response = await makeRequest({ stream: true })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('event: error')
    expect(body).toContain(
      'Upstream streaming request timed out. Please retry.',
    )
  })
})

// ── Access-log status code ──
//
// `onAfterResponse` reads `set.status`, but `onError` returns a fresh Response
// instead of falling through Elysia's normal path. Without an explicit
// write-back, every error routed through `onError` was logged as 500 —
// including the ones the client received as 504. These tests need the real
// `createServer()`; `createApp()` omits the logging hook.

// Built from a char code so the source carries no literal control character.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'g')

async function captureAccessLogLine(
  reject: () => Promise<never>,
): Promise<string> {
  const lines: Array<string> = []
  // eslint-disable-next-line no-console
  const originalLog = console.log
  // eslint-disable-next-line no-console
  console.log = ((...args: Array<unknown>) => {
    lines.push(args.map(String).join(' '))
  }) as typeof console.log

  try {
    CopilotClient.prototype.createChatCompletions = reject as never
    await createServer().handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    }))
    // onAfterResponse runs after handle() resolves.
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  finally {
    // eslint-disable-next-line no-console
    console.log = originalLog
  }

  expect(lines).toHaveLength(1)
  return lines[0]!.replace(ANSI_RE, '')
}

describe('Access-log status code matches the client response', () => {
  useCreateChatCompletionsSnapshot()

  test('logs 504 for a timeout, not 500', async () => {
    const line = await captureAccessLogLine(() =>
      Promise.reject(createBunFetchTimeoutError()))

    expect(line).toContain('504')
    expect(line).not.toContain('500')
  })

  test('logs 500 for a generic error', async () => {
    const line = await captureAccessLogLine(() =>
      Promise.reject(new Error('Something went wrong')))

    expect(line).toContain('500')
  })

  test('logs the upstream status for an HTTPError', async () => {
    const line = await captureAccessLogLine(() => Promise.reject(
      new HTTPError(429, { error: { message: 'Upstream error', type: 'error' } }),
    ))

    expect(line).toContain('429')
    expect(line).not.toContain('500')
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
