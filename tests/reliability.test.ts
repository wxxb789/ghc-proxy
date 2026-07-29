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

/**
 * Node's `fetch` (undici) wraps its own ~300s ceiling in a
 * `TypeError('fetch failed')` and puts the real error on `.cause` — the top
 * level carries no signal, so the classifier has to walk the chain.
 *
 * Hand-rolled rather than imported from `undici`: Bun resolves the bare
 * `undici` specifier to its own shim, whose error classes have no `name` and
 * no `code`, which would make this fixture pass against a broken classifier.
 */
function createNodeHeadersTimeoutError(): TypeError {
  const cause = new Error('Headers Timeout Error')
  cause.name = 'HeadersTimeoutError'
  ;(cause as Error & { code?: string }).code = 'UND_ERR_HEADERS_TIMEOUT'
  return new TypeError('fetch failed', { cause })
}

/** Node's mid-stream variant — `TypeError('terminated')` over a `BodyTimeoutError`. */
function createNodeBodyTimeoutError(): TypeError {
  const cause = new Error('Body Timeout Error')
  cause.name = 'BodyTimeoutError'
  ;(cause as Error & { code?: string }).code = 'UND_ERR_BODY_TIMEOUT'
  return new TypeError('terminated', { cause })
}

/**
 * Negative control: a connection refusal wears the *same*
 * `TypeError('fetch failed')` wrapper as a headers timeout. Only the cause
 * tells them apart, so this must keep mapping to a 500.
 */
function createNodeConnectionRefusedError(): TypeError {
  const cause = new Error('connect ECONNREFUSED 127.0.0.1:443')
  ;(cause as Error & { code?: string }).code = 'ECONNREFUSED'
  return new TypeError('fetch failed', { cause })
}

/** Attaches a Node-style string `code` without widening the return type. */
function withCode<T extends Error>(error: T, code: string): T {
  ;(error as Error & { code?: string }).code = code
  return error
}

/**
 * Node's dual-stack connect. `net.internalConnectMultiple` collects one error
 * per address and wraps them in a `NodeAggregateError` whose `code` is
 * `errors[0].code`, so whichever leg failed first decides the aggregate code
 * and a timed-out leg can end up buried behind a refused one. Nothing in the
 * chain carries a timeout *name* — the leaves are plain `Error`. Only the code
 * set plus the `.errors` walk can classify this.
 *
 * Captured live on Node 24.18 against `http://localhost:<closed port>` with the
 * default dispatcher: `autoSelectFamily` is on by default and
 * `autoSelectFamilyAttemptTimeout` is 250ms, so the `::1` leg times out.
 */
function createNodeDualStackTimeoutFirstError(): TypeError {
  const timedOut = withCode(new Error('connect ETIMEDOUT ::1:443'), 'ETIMEDOUT')
  const refused = withCode(new Error('connect ECONNREFUSED 127.0.0.1:443'), 'ECONNREFUSED')
  const aggregate = withCode(new AggregateError([timedOut, refused], 'all connect attempts failed'), 'ETIMEDOUT')
  return new TypeError('fetch failed', { cause: aggregate })
}

/**
 * Same shape, refused leg first: the aggregate carries `ECONNREFUSED` and only
 * the buried `ETIMEDOUT` leaf identifies the timeout.
 */
function createNodeDualStackRefusedFirstError(): TypeError {
  const refused = withCode(new Error('connect ECONNREFUSED 127.0.0.1:443'), 'ECONNREFUSED')
  const timedOut = withCode(new Error('connect ETIMEDOUT ::1:443'), 'ETIMEDOUT')
  const aggregate = withCode(new AggregateError([refused, timedOut], 'all connect attempts failed'), 'ECONNREFUSED')
  return new TypeError('fetch failed', { cause: aggregate })
}

/**
 * Negative control for the `.errors` walk: every leg refused, no timeout
 * anywhere. Must stay a 500 — an `AggregateError` is not itself a signal.
 */
function createNodeDualStackAllRefusedError(): TypeError {
  const v4 = withCode(new Error('connect ECONNREFUSED 127.0.0.1:443'), 'ECONNREFUSED')
  const v6 = withCode(new Error('connect ECONNREFUSED ::1:443'), 'ECONNREFUSED')
  const aggregate = withCode(new AggregateError([v4, v6], 'all connect attempts failed'), 'ECONNREFUSED')
  return new TypeError('fetch failed', { cause: aggregate })
}

/**
 * undici's TCP/TLS connect ceiling (10s default) — also the only shape a proxy
 * hop produces when the CONNECT tunnel opens and then goes silent.
 */
function createNodeConnectTimeoutError(): TypeError {
  const cause = withCode(new Error('Connect Timeout Error'), 'UND_ERR_CONNECT_TIMEOUT')
  cause.name = 'ConnectTimeoutError'
  return new TypeError('fetch failed', { cause })
}

/**
 * A `cause` that throws on read. The classifier runs inside the error handler,
 * so it must degrade to "not a timeout" rather than become a throw site there.
 */
function createThrowingCauseError(): Error {
  const error = new Error('fetch failed')
  Object.defineProperty(error, 'cause', {
    get() {
      throw new Error('cause getter exploded')
    },
  })
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

  // Regression: on Node the same ~300s ceiling arrives as
  // TypeError('fetch failed') with the undici error on `.cause`. The
  // name-only classifier missed it and the client got a 500 reading
  // "fetch failed".
  for (const stream of [false, true]) {
    test(`Node fetch HeadersTimeoutError returns 504 (stream=${stream})`, async () => {
      CopilotClient.prototype.createChatCompletions = () =>
        Promise.reject(createNodeHeadersTimeoutError())

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

  // The wrapper alone cannot classify: a refused connection wears the same
  // TypeError('fetch failed'). Only the cause separates them.
  test('Node connection refusal still returns 500, not 504', async () => {
    CopilotClient.prototype.createChatCompletions = () =>
      Promise.reject(createNodeConnectionRefusedError())

    const response = await makeRequest()

    expect(response.status).toBe(500)
    const json = await response.json()
    expect(json).toEqual({
      error: { message: 'fetch failed', type: 'error' },
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

  // Node's mid-stream ceiling: TypeError('terminated') over BodyTimeoutError.
  async function* createNodeBodyTimeoutStream(): AsyncGenerator<
    ServerSentEventMessage,
    void,
    unknown
  > {
    await Promise.resolve()
    throw createNodeBodyTimeoutError()
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

  test('converts Node BodyTimeoutError to the same timeout SSE error event', async () => {
    CopilotClient.prototype.createChatCompletions = (_payload, _options) =>
      Promise.resolve(createNodeBodyTimeoutStream())

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

/** `<- POST /v1/messages 504 12ms [model=... ] [rid=...]` — index 3 is the status. */
function accessLogStatus(line: string): string | undefined {
  return line.split(' ')[3]
}

describe('Access-log status code matches the client response', () => {
  useCreateChatCompletionsSnapshot()

  test('logs 504 for a timeout, not 500', async () => {
    const line = await captureAccessLogLine(() =>
      Promise.reject(createBunFetchTimeoutError()))

    expect(accessLogStatus(line)).toBe('504')
  })

  test('logs 504 for a Node-shaped timeout', async () => {
    const line = await captureAccessLogLine(() =>
      Promise.reject(createNodeHeadersTimeoutError()))

    expect(accessLogStatus(line)).toBe('504')
  })

  test('logs 500 for a generic error', async () => {
    const line = await captureAccessLogLine(() =>
      Promise.reject(new Error('Something went wrong')))

    expect(accessLogStatus(line)).toBe('500')
  })

  test('logs the upstream status for an HTTPError', async () => {
    const line = await captureAccessLogLine(() => Promise.reject(
      new HTTPError(429, { error: { message: 'Upstream error', type: 'error' } }),
    ))

    expect(accessLogStatus(line)).toBe('429')
  })
})

describe('Timeout classification: Node dual-stack and cause-chain edges', () => {
  useCreateChatCompletionsSnapshot()

  // Regression: the timed-out leg is only visible as `ETIMEDOUT` inside
  // `AggregateError.errors`. No name anywhere in the chain says "timeout".
  test('dual-stack connect with a timed-out leg returns 504', async () => {
    CopilotClient.prototype.createChatCompletions = () =>
      Promise.reject(createNodeDualStackTimeoutFirstError())

    const response = await makeRequest()

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({
      error: {
        message: 'Upstream request timed out before a response was received.',
        type: 'timeout_error',
      },
    })
  })

  // Same failure with the legs reordered: the aggregate reports ECONNREFUSED,
  // so only the walk into `.errors` finds the ETIMEDOUT leaf.
  test('dual-stack connect with the timed-out leg buried returns 504', async () => {
    CopilotClient.prototype.createChatCompletions = () =>
      Promise.reject(createNodeDualStackRefusedFirstError())

    const response = await makeRequest()

    expect(response.status).toBe(504)
  })

  // Negative control: an AggregateError with no timeout leaf is not a timeout.
  test('dual-stack connect with every leg refused still returns 500', async () => {
    CopilotClient.prototype.createChatCompletions = () =>
      Promise.reject(createNodeDualStackAllRefusedError())

    const response = await makeRequest()

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { message: 'fetch failed', type: 'error' },
    })
  })

  test('ConnectTimeoutError on the cause returns 504', async () => {
    CopilotClient.prototype.createChatCompletions = () =>
      Promise.reject(createNodeConnectTimeoutError())

    const response = await makeRequest()

    expect(response.status).toBe(504)
  })

  // The classifier runs inside the error handler, where a throwing accessor
  // would replace the client's 500 with an unhandled throw.
  test('a cause that throws on read degrades to 500, not a crash', async () => {
    CopilotClient.prototype.createChatCompletions = () =>
      Promise.reject(createThrowingCauseError())

    const response = await makeRequest()

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { message: 'fetch failed', type: 'error' },
    })
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
