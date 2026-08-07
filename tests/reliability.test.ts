import type { ServerSentEventMessage } from 'fetch-event-stream'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import consola from 'consola'

import { CopilotClient } from '~/clients'
import { HTTPError } from '~/lib/error'
import { formatElapsed, getOrCreateRequestCorrelation, logRecoveryEvent } from '~/lib/request-logger'
import { createServer, handleRouteError } from '~/server'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
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
 * Bun's `fetch` enforces a built-in ~300s **idle** ceiling — it resets on every
 * byte received, so it fires on a stalled stream long before the configured
 * upstream timeout can, but never on one that keeps trickling. It rejects with
 * a `DOMException` named `TimeoutError` — not `AbortError`.
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
 * no `code` — so the fixture would carry no Node shape at all and could not
 * tell a classifier that handles Node from one that does not.
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
 * Hand-rolled from undici's documented dual-stack behavior, not captured live:
 * `autoSelectFamily` is on by default with a 250ms
 * `autoSelectFamilyAttemptTimeout`, so a slow leg can time out while its
 * sibling is refused. A closed *local* port does not reproduce it — both legs
 * are refused immediately and the cause is a plain `Error` with no `.errors`.
 * Reaching it live needs a host whose one address family blackholes.
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
      type: 'error',
      error: {
        message: 'Upstream error',
        type: 'error',
      },
    })
  })
})

// ── Errors carry their own status ──
//
// `handleRouteError` used to flatten every non-HTTPError to 500. On an
// OpenAI-compatible surface that turned an unknown path into a 500 (the
// reported `500 NaNs` lines) where the client is owed a 404, and it hid
// `TranslationFailure`'s 502 behind a generic 500. The cases below exercise the
// exported seam directly for shapes no live route in this repo can produce.

/**
 * `onAfterResponse` fires after `handle()` resolves, so a real-server request
 * writes its access-log line asynchronously. Without waiting, that line lands
 * inside a later test's `console.log` capture window and trips its single-line
 * assertion.
 */
async function drainAccessLog() {
  await new Promise(resolve => setTimeout(resolve, 50))
}

describe('handleRouteError honors an error that carries its own status', () => {
  function mapError(code: string, error: unknown) {
    const set: { status?: number | string } = {}
    const response = handleRouteError({ code, error, set })
    return { set, response }
  }

  test('an unmatched route returns 404 through the real server', async () => {
    const response = await createServer().handle(
      new Request('http://localhost/api/tags'),
    )

    expect(response.status).toBe(404)
    // Elysia's own message is the bare token `NOT_FOUND`, and `type: 'error'`
    // is not in OpenAI's taxonomy. Neither belongs at a boundary this repo
    // promises stays OpenAI-compatible.
    expect(await response.json()).toEqual({
      error: {
        message: 'Unknown endpoint. Check the request path.',
        type: 'not_found_error',
      },
    })
    await drainAccessLog()
  })

  test('a 4xx from a thrown error is classified as invalid_request_error', () => {
    const { response } = mapError('PARSE', { status: 400, message: 'bad json' })

    expect(response?.status).toBe(400)
    return response?.json().then((body) => {
      expect(body).toMatchObject({ error: { type: 'invalid_request_error' } })
    })
  })

  test('a 5xx keeps the generic error type', () => {
    const { response } = mapError('UNKNOWN', new Error('Something went wrong'))

    expect(response?.status).toBe(500)
    return response?.json().then((body) => {
      expect(body).toMatchObject({ error: { message: 'Something went wrong', type: 'error' } })
    })
  })

  test('a malformed JSON body returns 400 through the real server', async () => {
    const response = await createServer().handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not valid json',
      }),
    )

    expect(response.status).toBe(400)
    await drainAccessLog()
  })

  test('a ValidationError-shaped throw maps to 422', () => {
    // No route here declares a TypeBox body schema — ingest validates with Zod
    // and throws HTTPError(400) — so Elysia never builds one on a live path.
    // The generic status read covers it for free if a validator is ever added.
    const { set, response } = mapError('VALIDATION', { status: 422, message: 'bad' })

    expect(set.status).toBe(422)
    expect(response?.status).toBe(422)
  })

  test('an unwrapped TranslationFailure surfaces its own 502, not 500', () => {
    const { set, response } = mapError(
      'UNKNOWN',
      new TranslationFailure('Upstream response contained no choices', {
        status: 502,
        kind: 'upstream_no_choices',
      }),
    )

    expect(set.status).toBe(502)
    expect(response?.status).toBe(502)
  })

  test('a plain Error with no status still returns 500', () => {
    const { set, response } = mapError('UNKNOWN', new Error('Something went wrong'))

    expect(set.status).toBe(500)
    expect(response?.status).toBe(500)
  })

  test('a thrown non-Error value returns 500, never undefined', () => {
    const { set, response } = mapError('UNKNOWN', 'boom')

    expect(set.status).toBe(500)
    expect(response?.status).toBe(500)
  })

  test('an out-of-range or non-integer status never reaches the client', () => {
    // An error must not be able to report success, or a nonsense number.
    for (const status of [200, 302, 99, 600, 404.5, Number.NaN]) {
      const { set, response } = mapError('UNKNOWN', { status, message: 'nope' })

      expect(set.status).toBe(500)
      expect(response?.status).toBe(500)
    }
  })

  test('a non-numeric status is ignored', () => {
    const { set, response } = mapError('UNKNOWN', { status: '404', message: 'nope' })

    expect(set.status).toBe(500)
    expect(response?.status).toBe(500)
  })

  // Reading `status` runs inside the error handler, so this repo's own read
  // must not be the thing that throws. Note this hardens `handleRouteError`
  // only: Elysia itself does `set.status = error.status` after `onError`
  // returns (`elysia/dist/compose.mjs`), so a hostile getter still escapes
  // `app.handle()` end-to-end. Measured on the pre-fix tree too — that escape
  // predates this change and is not ours to fix here.
  test('a status getter that throws degrades to 500 instead of escaping', () => {
    class ThrowingStatusError extends Error {
      get status(): number {
        throw new TypeError('status getter blew up')
      }
    }

    const { set, response } = mapError('UNKNOWN', new ThrowingStatusError('boom'))

    expect(set.status).toBe(500)
    expect(response?.status).toBe(500)
  })

  test('a Proxy whose has-trap throws degrades to 500 instead of escaping', () => {
    const hostile = new Proxy({}, {
      has() {
        throw new TypeError('has trap blew up')
      },
    })

    const { set, response } = mapError('UNKNOWN', hostile)

    expect(set.status).toBe(500)
    expect(response?.status).toBe(500)
  })

  test('code === HTTP still passes through untouched', () => {
    const { set, response } = mapError(
      'HTTP',
      new HTTPError(429, { error: { message: 'Upstream error', type: 'error' } }),
    )

    // HTTPError carries its own toResponse(); the handler must not intercept it.
    expect(response).toBeUndefined()
    expect(set.status).toBeUndefined()
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

function buildMessagesRequest(callerRequestId?: string): Request {
  return new Request('http://localhost/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(callerRequestId ? { 'x-request-id': callerRequestId } : {}),
    },
    body: JSON.stringify({
      model: 'claude-haiku-4.5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Hello!' }],
    }),
  })
}

/**
 * Drive one request through the real server and return its access-log line.
 *
 * `reject` is optional because an unmatched route never reaches upstream —
 * there is nothing to stub for it.
 */
async function captureAccessLogLine(
  options: {
    request?: Request
    reject?: () => Promise<never>
    callerRequestId?: string
  } = {},
): Promise<string> {
  const lines: Array<string> = []
  // eslint-disable-next-line no-console
  const originalLog = console.log
  // eslint-disable-next-line no-console
  console.log = ((...args: Array<unknown>) => {
    lines.push(args.map(String).join(' '))
  }) as typeof console.log

  try {
    if (options.reject) {
      CopilotClient.prototype.createChatCompletions = options.reject as never
    }
    await createServer().handle(
      options.request ?? buildMessagesRequest(options.callerRequestId),
    )
    await drainAccessLog()
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

/** Same line shape — index 4 is the elapsed duration. */
function accessLogElapsed(line: string): string | undefined {
  return line.split(' ')[4]
}

describe('Access-log status code matches the client response', () => {
  useCreateChatCompletionsSnapshot()

  test('logs 504 for a timeout, not 500', async () => {
    const line = await captureAccessLogLine({
      reject: () => Promise.reject(createBunFetchTimeoutError()),
    })

    expect(accessLogStatus(line)).toBe('504')
  })

  test('logs 504 for a Node-shaped timeout', async () => {
    const line = await captureAccessLogLine({
      reject: () => Promise.reject(createNodeHeadersTimeoutError()),
    })

    expect(accessLogStatus(line)).toBe('504')
  })

  test('logs 500 for a generic error', async () => {
    const line = await captureAccessLogLine({
      reject: () => Promise.reject(new Error('Something went wrong')),
    })

    expect(accessLogStatus(line)).toBe('500')
  })

  test('logs the upstream status for an HTTPError', async () => {
    const line = await captureAccessLogLine({
      reject: () => Promise.reject(
        new HTTPError(429, { error: { message: 'Upstream error', type: 'error' } }),
      ),
    })

    expect(accessLogStatus(line)).toBe('429')
  })

  test('logs the caller request id alongside the unique internal id', async () => {
    const line = await captureAccessLogLine({
      reject: () => Promise.reject(new Error('Something went wrong')),
      callerRequestId: 'caller request/id',
    })

    expect(line).toContain('callerRid=caller_request/id')
    expect(line).toMatch(/\brid=[\da-f]{8}\b/)
  })
})

// ── Access-log elapsed duration ──
//
// `derive` never runs on a route Elysia did not match, so reading the start
// timestamp from there produced `Date.now() - undefined` = NaN and logged the
// literal string `NaNs` on every unmatched path. The start is now recorded in
// `onRequest`, which does fire everywhere.

describe('Access-log elapsed duration is real on every path', () => {
  const DURATION_RE = /^\d+(?:ms|s)$/

  test('an unmatched route logs a real duration, not NaNs', async () => {
    const line = await captureAccessLogLine({
      request: new Request('http://localhost/api/tags'),
    })

    expect(line).not.toContain('NaN')
    expect(accessLogStatus(line)).toBe('404')
    expect(accessLogElapsed(line)).toMatch(DURATION_RE)
  })

  test('a matched route still logs a real duration', async () => {
    const line = await captureAccessLogLine({
      request: new Request('http://localhost/health'),
    })

    expect(line).not.toContain('NaN')
    expect(accessLogStatus(line)).toBe('200')
    expect(accessLogElapsed(line)).toMatch(DURATION_RE)
  })

  // The `onRequest` hook must discard its return value: `WeakMap.set` returns
  // the WeakMap, and Elysia turns any non-undefined `onRequest` return into the
  // response. Without this assertion a setter refactored to a concise arrow
  // would make every response in the proxy `[object WeakMap]` with the suite
  // still green — no other test reads a matched route's body through the real
  // server. `tsc` does not catch it either.
  test('a matched route returns its real body, not a leaked hook return', async () => {
    const response = await createServer().handle(
      new Request('http://localhost/health'),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok' })
    await drainAccessLog()
  })

  test('formatElapsed renders - rather than NaNs when the start is missing', () => {
    expect(formatElapsed(undefined)).toBe('-')
    expect(formatElapsed(Number.NaN)).toBe('-')
  })

  test('formatElapsed still formats a real duration', () => {
    expect(formatElapsed(Date.now())).toMatch(DURATION_RE)
    expect(formatElapsed(Date.now() - 2_000)).toMatch(/^\ds$/)
  })
})

describe('Request correlation and recovery logging', () => {
  test('preserves caller x-request-id on the public response', async () => {
    const response = await createServer().handle(new Request('http://localhost/health', {
      headers: { 'x-request-id': 'caller-request-id' },
    }))

    expect(response.headers.get('x-request-id')).toBe('caller-request-id')
  })

  test('uses a unique internal id while preserving a reused caller request id', () => {
    const first = getOrCreateRequestCorrelation(new Request('http://localhost', {
      headers: { 'x-request-id': 'caller-reused-id' },
    }))
    const second = getOrCreateRequestCorrelation(new Request('http://localhost', {
      headers: { 'x-request-id': 'caller-reused-id' },
    }))

    expect(first.requestId).not.toBe(second.requestId)
    expect(first.callerRequestId).toBe('caller-reused-id')
    expect(second.callerRequestId).toBe('caller-reused-id')
    expect(first.responseRequestId).toBe('caller-reused-id')
  })

  test('reuses one correlation record for the same Request object', () => {
    const request = new Request('http://localhost')
    expect(getOrCreateRequestCorrelation(request)).toBe(getOrCreateRequestCorrelation(request))
  })

  test('structured recovery events emit only allowlisted scalar fields', () => {
    const calls: Array<Array<unknown>> = []
    const logger = {
      info: (...args: Array<unknown>) => calls.push(args),
    }

    logRecoveryEvent({
      requestId: 'internal-id',
      callerRequestId: `caller id\n${'x'.repeat(200)}`,
      event: 'retry',
      retryCount: 1,
      status: 529,
      decision: 'retry',
      payload: { prompt: 'secret' },
      headers: { authorization: 'Bearer secret' },
      token: 'secret',
    } as never, logger)

    expect(calls).toEqual([[
      'Upstream recovery',
      {
        requestId: 'internal-id',
        callerRequestId: `caller_id_${'x'.repeat(118)}`,
        event: 'retry',
        retryCount: 1,
        status: 529,
        decision: 'retry',
      },
    ]])
  })

  test('default recovery logs are concise, safe, and keep terminal summaries', () => {
    const originalInfo = consola.info
    const calls: unknown[][] = []
    consola.info = ((...args: unknown[]) => {
      calls.push(args)
    }) as unknown as typeof consola.info

    try {
      logRecoveryEvent({
        requestId: 'normal-grant-id',
        event: 'grant',
        effectiveModel: 'gpt-5.6-luna',
        queueWaitMs: 0,
        decision: 'granted',
      })
      logRecoveryEvent({
        requestId: 'retry-id',
        event: 'retry',
        retryCount: 1,
        status: 429,
        effectiveModel: 'gpt-5.6-luna',
        decision: 'retry',
      })
      logRecoveryEvent({
        requestId: 'recovered-id',
        event: 'retry',
        retryCount: 1,
        status: 200,
        effectiveModel: 'gpt\nforged',
        decision: 'recovered',
      })
      logRecoveryEvent({
        requestId: 'rate-limit-id',
        event: 'budget',
        retryCount: 1,
        status: 429,
        effectiveModel: 'gpt-5.6-luna',
        scope: 'account',
        remainingBudgetMs: 12_000,
        decision: 'retry-limit',
      })
    }
    finally {
      consola.info = originalInfo
    }

    expect(calls).toEqual([
      ['Upstream recovery recovered status=200 model=gpt\\nforged retry=1 rid=recovere'],
      ['Upstream rate limit retry-limit status=429 model=gpt-5.6-luna scope=account retry=1 budget=12s rid=rate-lim'],
    ])
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
