import type { ExecutionStrategy, SSEOutput } from '~/lib/execution-strategy'
import type { DecisionsQuestionMapping } from '~/translator/decisions/mapping'

import { afterEach, describe, expect, mock, test } from 'bun:test'
import consola from 'consola'

import { CopilotClient } from '~/clients'
import {
  createDefaultUpstreamRequestQueue,
  LocalModelCooldownError,
  parseRetryAfterMs,
  TerminalUpstreamRecoveryError,
  UpstreamRequestQueue,
} from '~/clients/upstream-queue'
import { HTTPError } from '~/lib/error'
import { runStrategy } from '~/lib/execution-strategy'
import {
  disableIdleTimeout,
  hasStreamingFlag,
  hasStreamingResponsesQuery,
} from '~/lib/request-timeout'
import { isTimeoutLikeError } from '~/lib/timeout-error'
import { ClientAbortError, createUpstreamSignal, isClientAbortError } from '~/lib/upstream-signal'
import { normalizeDecisionsUpstreamError } from '~/translator/decisions/errors'

describe('parseRetryAfterMs', () => {
  test('parses delta seconds', () => {
    const headers = new Headers({ 'retry-after': '2.5' })

    expect(parseRetryAfterMs(headers, 1_000)).toBe(2_500)
  })

  test('parses HTTP dates', () => {
    const headers = new Headers({
      'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT',
    })

    expect(parseRetryAfterMs(headers, Date.parse('Wed, 21 Oct 2015 07:27:55 GMT'))).toBe(5_000)
  })

  test('uses the upstream Date header as the HTTP-date reference', () => {
    const headers = new Headers({
      'date': 'Wed, 21 Oct 2015 07:27:55 GMT',
      'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT',
    })

    expect(parseRetryAfterMs(headers, Date.parse('Thu, 22 Oct 2015 07:27:55 GMT'))).toBe(5_000)
  })

  test.each(['2.5 seconds', '-1', 'Infinity', '1e3'])(
    'rejects non-grammar Retry-After value %s',
    (value) => {
      expect(parseRetryAfterMs(new Headers({ 'retry-after': value }), 1_000)).toBeUndefined()
    },
  )

  test('rejects a numeric Retry-After value that overflows milliseconds', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '9'.repeat(400) }), 1_000)).toBeUndefined()
  })
})

describe('UpstreamRequestQueue', () => {
  test('default queue allows 10 concurrent upstream responses', async () => {
    const queue = createDefaultUpstreamRequestQueue()
    const responses = []
    let calls = 0

    for (let i = 0; i < 10; i++) {
      responses.push(await queue.dispatch(
        () => {
          calls++
          return Promise.resolve(new Response('ok'))
        },
        { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages' },
      ))
    }

    const blocked = queue.dispatch(
      () => {
        calls++
        return Promise.resolve(new Response('ok'))
      },
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages' },
    )

    await Promise.resolve()
    expect(calls).toBe(10)

    responses[0]!.release()
    const eleventh = await blocked
    expect(calls).toBe(11)

    eleventh.release()
    for (const response of responses.slice(1)) {
      response.release()
    }
  })

  test('retries upstream 429 using Retry-After before returning a successful response', async () => {
    let now = 1_000
    const sleeps: number[] = []
    const queue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 2,
        baseDelayMs: 10,
        maxDelayMs: 5_000,
      },
      {
        now: () => now,
        sleep: (ms) => {
          sleeps.push(ms)
          now += ms
          return Promise.resolve()
        },
        logger: {
          warn: () => {},
        },
        setTimeout: ((_callback: () => void) => {
          return undefined as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout,
        clearTimeout: (() => {}) as typeof clearTimeout,
      },
    )

    let calls = 0
    const queued = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(
          calls === 1
            ? new Response('too many requests\n', {
                status: 429,
                headers: { 'retry-after': '3' },
              })
            : new Response(JSON.stringify({ ok: true }), {
                headers: { 'content-type': 'application/json' },
              }),
        )
      },
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages', retryable: true },
    )

    expect(calls).toBe(2)
    expect(sleeps).toEqual([3_000])
    expect(await queued.response.json()).toEqual({ ok: true })
    queued.release()
  })

  test('serializes requests until the active response releases its queue slot', async () => {
    const queue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 0,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
      {
        sleep: () => Promise.resolve(),
        logger: {
          warn: () => {},
        },
      },
    )

    const order: string[] = []
    const first = await queue.dispatch(
      () => {
        order.push('first')
        return Promise.resolve(new Response('first'))
      },
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages' },
    )

    const secondPromise = queue.dispatch(
      () => {
        order.push('second')
        return Promise.resolve(new Response('second'))
      },
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages' },
    )

    await Promise.resolve()
    expect(order).toEqual(['first'])

    first.release()
    const second = await secondPromise
    expect(order).toEqual(['first', 'second'])
    second.release()
  })

  test('can update concurrency without replacing retry settings', async () => {
    const queue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 0,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
      {
        sleep: () => Promise.resolve(),
        logger: {
          warn: () => {},
        },
      },
    )

    queue.updateOptions({ concurrency: 2 })

    const order: string[] = []
    const first = await queue.dispatch(
      () => {
        order.push('first')
        return Promise.resolve(new Response('first'))
      },
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages' },
    )
    const second = await queue.dispatch(
      () => {
        order.push('second')
        return Promise.resolve(new Response('second'))
      },
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages' },
    )

    expect(order).toEqual(['first', 'second'])
    first.release()
    second.release()
  })

  test('falls back to default concurrency for NaN input', async () => {
    const queue = new UpstreamRequestQueue(
      { concurrency: Number.NaN } as Partial<import('~/clients/upstream-queue').UpstreamRequestQueueOptions>,
    )

    let calls = 0
    const responses = []
    for (let i = 0; i < 10; i++) {
      responses.push(await queue.dispatch(
        () => {
          calls++
          return Promise.resolve(new Response('ok'))
        },
        { url: 'https://test' },
      ))
    }
    expect(calls).toBe(10)
    for (const r of responses) r.release()
  })

  test('falls back to default concurrency for Infinity input', async () => {
    const queue = new UpstreamRequestQueue(
      { concurrency: Number.POSITIVE_INFINITY },
    )

    const result = await queue.dispatch(
      () => Promise.resolve(new Response('ok')),
      { url: 'https://test' },
    )
    result.release()
  })

  test('rejects dispatch immediately when signal is already aborted', async () => {
    const queue = new UpstreamRequestQueue({ concurrency: 1 })
    const controller = new AbortController()
    controller.abort('cancelled')

    await expect(
      queue.dispatch(
        () => Promise.resolve(new Response('ok')),
        { url: 'https://test' },
        controller.signal,
      ),
    ).rejects.toBe('cancelled')
  })

  test('aborts acquire wait when signal fires', async () => {
    const queue = new UpstreamRequestQueue({ concurrency: 1 })

    const first = await queue.dispatch(
      () => Promise.resolve(new Response('ok')),
      { url: 'https://test' },
    )

    const controller = new AbortController()
    let cancelledFetches = 0
    const blocked = queue.dispatch(
      () => {
        cancelledFetches++
        return Promise.resolve(new Response('should not run'))
      },
      { url: 'https://test' },
      controller.signal,
    )

    await Promise.resolve()
    controller.abort('client disconnected')

    await expect(blocked).rejects.toBe('client disconnected')
    first.release()
    for (let index = 0; index < 5; index++)
      await Promise.resolve()
    expect(cancelledFetches).toBe(0)

    const next = await queue.dispatch(
      () => Promise.resolve(new Response('ok')),
      { url: 'https://test' },
    )
    expect(await next.response.text()).toBe('ok')
    next.release()
  })

  test('aborts backoff sleep when signal fires during retry wait', async () => {
    let sleepResolve: (() => void) | undefined
    const queue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 3,
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
      },
      {
        sleep: () => new Promise<void>((resolve) => { sleepResolve = resolve }),
        logger: { warn: () => {} },
      },
    )

    const controller = new AbortController()
    let calls = 0
    const dispatched = queue.dispatch(
      () => {
        calls++
        return Promise.resolve(new Response('rate limited', { status: 429 }))
      },
      { url: 'https://test', retryable: true },
      controller.signal,
    )

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls).toBe(1)
    expect(sleepResolve).toBeDefined()

    controller.abort('timeout')

    await expect(dispatched).rejects.toBe('timeout')
  })

  test('dispatch works normally when signal is provided but not aborted', async () => {
    const queue = new UpstreamRequestQueue({ concurrency: 1 })
    const controller = new AbortController()

    const result = await queue.dispatch(
      () => Promise.resolve(new Response('ok')),
      { url: 'https://test' },
      controller.signal,
    )

    expect(await result.response.text()).toBe('ok')
    result.release()
  })

  test('does not retry 429 when retryable is false', async () => {
    const queue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 5,
        baseDelayMs: 10,
        maxDelayMs: 5_000,
      },
      {
        sleep: () => Promise.resolve(),
        logger: { warn: () => {} },
      },
    )

    let calls = 0
    const queued = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(new Response('rate limited', { status: 429 }))
      },
      { method: 'POST', url: 'https://api.githubcopilot.com/responses', retryable: false },
    )

    expect(calls).toBe(1)
    expect(queued.response.status).toBe(429)
    queued.release()
  })

  test('does not retry 429 when retryable is omitted (safe default)', async () => {
    const queue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 5,
        baseDelayMs: 10,
        maxDelayMs: 5_000,
      },
      {
        sleep: () => Promise.resolve(),
        logger: { warn: () => {} },
      },
    )

    let calls = 0
    const queued = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(new Response('rate limited', { status: 429 }))
      },
      { method: 'DELETE', url: 'https://api.githubcopilot.com/responses/resp_123' },
    )

    expect(calls).toBe(1)
    expect(queued.response.status).toBe(429)
    queued.release()
  })

  test('applies cooldown even when retryable is false', async () => {
    const now = 1_000
    const timers: Array<{ callback: () => void, delay: number }> = []
    const queue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 5,
        baseDelayMs: 2_000,
        maxDelayMs: 60_000,
      },
      {
        now: () => now,
        sleep: () => Promise.resolve(),
        logger: { warn: () => {} },
        setTimeout: ((callback: () => void, delay: number) => {
          timers.push({ callback, delay })
          return timers.length as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout,
        clearTimeout: (() => {}) as typeof clearTimeout,
      },
    )

    const queued = await queue.dispatch(
      () => Promise.resolve(
        new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '10' },
        }),
      ),
      { method: 'DELETE', url: 'https://api.githubcopilot.com/responses/resp_123', retryable: false },
    )

    expect(queued.response.status).toBe(429)

    let waiterCalls = 0
    void queue.dispatch(
      () => {
        waiterCalls++
        return Promise.resolve(new Response('ok'))
      },
      { method: 'GET', url: 'https://api.githubcopilot.com/models' },
    )
    queued.release()
    await Promise.resolve()

    expect(waiterCalls).toBe(0)
    expect(timers.length).toBeGreaterThanOrEqual(1)
    const lastTimer = timers.at(-1)!
    expect(lastTimer.delay).toBeGreaterThan(0)
  })

  test('retries 429 when retryable is true', async () => {
    const queue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 5,
        baseDelayMs: 10,
        maxDelayMs: 5_000,
      },
      {
        sleep: () => Promise.resolve(),
        logger: { warn: () => {} },
      },
    )

    let calls = 0
    const queued = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(
          calls === 1
            ? new Response('rate limited', { status: 429 })
            : new Response(JSON.stringify({ ok: true })),
        )
      },
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages', retryable: true },
    )

    expect(calls).toBe(2)
    expect(await queued.response.json()).toEqual({ ok: true })
    queued.release()
  })
})

describe('createUpstreamSignal', () => {
  test('returns a non-aborted signal initially', () => {
    const { signal } = createUpstreamSignal()
    expect(signal.aborted).toBe(false)
  })

  test('signal aborts after timeout expires', async () => {
    const { signal, cleanup } = createUpstreamSignal(undefined, 50)
    expect(signal.aborted).toBe(false)

    await new Promise(resolve => setTimeout(resolve, 100))
    expect(signal.aborted).toBe(true)

    cleanup()
  })

  test('signal aborts when linked clientSignal aborts', async () => {
    const clientController = new AbortController()
    const onClientAbort = mock()
    const { signal, cleanup } = createUpstreamSignal(
      clientController.signal,
      10_000,
      onClientAbort,
    )

    expect(signal.aborted).toBe(false)
    clientController.abort()

    // Give the event listener time to fire
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(signal.aborted).toBe(true)
    expect(isClientAbortError(signal.reason)).toBe(true)
    expect(onClientAbort).toHaveBeenCalledTimes(1)

    cleanup()
  })

  test('does NOT abort when clientSignal is already aborted', () => {
    const clientController = new AbortController()
    const onClientAbort = mock()
    clientController.abort()

    const { signal, cleanup } = createUpstreamSignal(
      clientController.signal,
      10_000,
      onClientAbort,
    )

    // The key fix: signal should NOT inherit pre-aborted state
    expect(signal.aborted).toBe(false)
    expect(onClientAbort).not.toHaveBeenCalled()

    cleanup()
  })

  test('cleanup clears the timeout', async () => {
    let aborted = false
    const { signal, cleanup } = createUpstreamSignal(undefined, 100)

    signal.addEventListener('abort', () => {
      aborted = true
    })

    cleanup()
    await new Promise(resolve => setTimeout(resolve, 150))

    // Should not abort after cleanup
    expect(aborted).toBe(false)
  })
})

describe('runStrategy abort signal behavior', () => {
  /**
   * Creates a stream that throws an AbortError after the signal is aborted.
   * This simulates an upstream fetch that fails because the proxy timeout fired.
   */
  function createAbortingStream(signal: AbortSignal): AsyncIterable<string> & AsyncGenerator<string> {
    return (async function* () {
      // Wait for the signal to actually abort before throwing
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      throw new DOMException('The operation was aborted.', 'AbortError')
    })()
  }

  function makeStrategy(stream: AsyncIterable<string> & AsyncGenerator<string>): ExecutionStrategy<AsyncIterable<string>, string> {
    return {
      execute: () => Promise.resolve(stream),
      isStream: (_result): _result is AsyncIterable<string> & AsyncIterable<string> => true,
      translateResult: () => null,
      translateStreamChunk: (chunk: string) => ({ data: chunk, event: 'data' }),
      onStreamDone: () => ({ data: '[DONE]', event: 'done' }),
      onStreamError: (error: unknown) => ({
        data: JSON.stringify({
          error: {
            message: error instanceof DOMException ? 'Upstream timeout' : 'Unknown error',
            type: 'timeout_error',
          },
        }),
        event: 'error',
      }),
    }
  }

  async function collectOutputs(generator: AsyncGenerator<SSEOutput>): Promise<SSEOutput[]> {
    const outputs: SSEOutput[] = []
    for await (const output of generator) {
      outputs.push(output)
    }
    return outputs
  }

  test('emits onStreamError when proxy timeout aborts but client is still connected', async () => {
    // Simulate proxy timeout: the combined signal is aborted,
    // but the client signal is NOT aborted (client is still connected).
    const proxyController = new AbortController()
    const clientController = new AbortController()
    const stream = createAbortingStream(proxyController.signal)

    const signal = {
      signal: proxyController.signal,
      clientSignal: clientController.signal,
      cleanup: () => {},
    }

    const observeStreamError = mock()
    const result = await runStrategy(makeStrategy(stream), signal, {
      onStreamError: observeStreamError,
    })
    expect(result.kind).toBe('stream')
    if (result.kind !== 'stream')
      return

    // Fire the proxy timeout
    proxyController.abort()

    const outputs = await collectOutputs(result.generator)

    // Should have the error event because client is still connected
    const errorOutput = outputs.find(o => o.event === 'error')
    expect(errorOutput).toBeDefined()
    expect(errorOutput!.data).toContain('Upstream timeout')
    expect(observeStreamError).toHaveBeenCalledTimes(1)
  })

  test('suppresses onStreamError when client disconnects', async () => {
    // Simulate client disconnect: the client signal IS aborted.
    const proxyController = new AbortController()
    const clientController = new AbortController()
    const stream = createAbortingStream(proxyController.signal)

    const signal = {
      signal: proxyController.signal,
      clientSignal: clientController.signal,
      cleanup: () => {},
    }

    const observeStreamError = mock()
    const result = await runStrategy(makeStrategy(stream), signal, {
      onStreamError: observeStreamError,
    })
    expect(result.kind).toBe('stream')
    if (result.kind !== 'stream')
      return

    // Client disconnects, then proxy abort follows
    clientController.abort()
    proxyController.abort()

    const outputs = await collectOutputs(result.generator)

    // Should NOT have the error event because client disconnected
    const errorOutput = outputs.find(o => o.event === 'error')
    expect(errorOutput).toBeUndefined()
    expect(observeStreamError).not.toHaveBeenCalled()
  })
})

describe('request-timeout helpers', () => {
  test('disableIdleTimeout delegates to Bun server timeout with 0 seconds', () => {
    const timeout = mock()

    const request = new Request('http://localhost/v1/messages')
    disableIdleTimeout({ timeout }, request)

    expect(timeout).toHaveBeenCalledTimes(1)
    expect(timeout).toHaveBeenCalledWith(request, 0)
  })

  test('disableIdleTimeout is a no-op when timeout is unavailable', () => {
    const request = new Request('http://localhost/v1/messages')

    expect(() => disableIdleTimeout(null, request)).not.toThrow()
    expect(() => disableIdleTimeout({}, request)).not.toThrow()
  })

  test('hasStreamingFlag only enables true boolean stream values', () => {
    expect(hasStreamingFlag({ stream: true })).toBe(true)
    expect(hasStreamingFlag({ stream: false })).toBe(false)
    expect(hasStreamingFlag({ stream: 'true' })).toBe(false)
    expect(hasStreamingFlag(undefined)).toBe(false)
  })

  test('hasStreamingResponsesQuery checks the retrieve stream query flag', () => {
    expect(hasStreamingResponsesQuery({
      url: 'http://localhost/v1/responses/resp_123?stream=true',
    })).toBe(true)

    expect(hasStreamingResponsesQuery({
      url: 'http://localhost/v1/responses/resp_123?stream=false',
    })).toBe(false)
  })
})

describe('upstream error diagnostics', () => {
  const originalConsolaError = consola.error

  afterEach(() => {
    consola.error = originalConsolaError
  })

  test('logs upstream status and empty body details', async () => {
    const errorLogs: Array<unknown[]> = []
    consola.error = ((...args: unknown[]) => {
      errorLogs.push(args)
    }) as typeof consola.error

    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        fetch: ((async () =>
          new Response('', {
            status: 400,
            statusText: 'Bad Request',
            headers: { 'content-type': 'text/plain' },
          })) as unknown) as typeof fetch,
      },
    )

    await expect(
      client.createEmbeddings({
        model: 'text-embedding-3-small',
        input: ['hello'],
      }),
    ).rejects.toMatchObject({
      status: 400,
      body: {
        error: {
          message: 'Failed to create embeddings',
          type: 'upstream_error',
        },
      },
    })

    expect(errorLogs).toHaveLength(1)
    expect(errorLogs[0]?.[0]).toBe('Upstream error:')
    expect(errorLogs[0]?.[1]).toMatchObject({
      status: 400,
      statusText: 'Bad Request',
      rawBody: '<empty>',
    })
  })

  test('preserves plain text upstream rate limit errors', async () => {
    const errorLogs: Array<unknown[]> = []
    consola.error = ((...args: unknown[]) => {
      errorLogs.push(args)
    }) as typeof consola.error

    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        fetch: ((async () =>
          new Response('too many requests\n', {
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'content-type': 'text/plain' },
          })) as unknown) as typeof fetch,
      },
    )

    await expect(
      client.createEmbeddings({
        model: 'text-embedding-3-small',
        input: ['hello'],
      }),
    ).rejects.toMatchObject({
      status: 429,
      body: {
        error: {
          message: 'too many requests',
          type: 'rate_limit_error',
        },
      },
    })

    expect(errorLogs).toHaveLength(1)
    expect(errorLogs[0]?.[1]).toMatchObject({
      status: 429,
      statusText: 'Too Many Requests',
      body: {
        error: {
          message: 'too many requests',
          type: 'rate_limit_error',
        },
      },
      rawBody: 'too many requests\n',
    })
  })

  test('classifies upstream 529 as overloaded_error', async () => {
    consola.error = ((..._args: unknown[]) => {}) as typeof consola.error

    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        fetch: ((async () =>
          new Response('overloaded\n', {
            status: 529,
            statusText: 'Overloaded',
            headers: { 'content-type': 'text/plain' },
          })) as unknown) as typeof fetch,
      },
    )

    // Anthropic clients retry `overloaded_error`; leaking `upstream_error`
    // would break their error classification at the proxy boundary.
    await expect(
      client.createEmbeddings({
        model: 'text-embedding-3-small',
        input: ['hello'],
      }),
    ).rejects.toMatchObject({
      status: 529,
      body: {
        error: {
          message: 'overloaded',
          type: 'overloaded_error',
        },
      },
    })
  })

  test('retries queued upstream rate limit responses before surfacing success', async () => {
    let now = 1_000
    const requestQueue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 1,
        baseDelayMs: 25,
        maxDelayMs: 25,
      },
      {
        now: () => now,
        sleep: (ms) => {
          now += ms
          return Promise.resolve()
        },
        logger: {
          warn: () => {},
        },
        setTimeout: ((_callback: () => void) => {
          return undefined as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout,
        clearTimeout: (() => {}) as typeof clearTimeout,
      },
    )
    let calls = 0
    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        requestQueue,
        fetch: ((async () => {
          calls++
          if (calls === 1) {
            return new Response('too many requests\n', {
              status: 429,
              statusText: 'Too Many Requests',
            })
          }
          return Response.json({
            object: 'list',
            data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
            model: 'text-embedding-3-small',
            usage: { prompt_tokens: 1, total_tokens: 1 },
          })
        }) as unknown) as typeof fetch,
      },
    )

    const response = await client.createEmbeddings({
      model: 'text-embedding-3-small',
      input: ['hello'],
    })

    expect(response.data).toHaveLength(1)
    expect(calls).toBe(2)
  })

  test('threads the serialized model and pipeline recovery into a typed terminal 529', async () => {
    consola.error = ((..._args: unknown[]) => {}) as typeof consola.error
    const events: Array<Record<string, unknown>> = []
    const recovery = {
      requestId: 'pipeline-request',
      callerRequestId: 'caller-request',
      retryCount: 0,
    }
    let serializedModel: unknown
    const requestQueue = new UpstreamRequestQueue(
      { concurrency: 1, maxRetries: 0, recoveryBudgetMs: 1_000 },
      {
        logger: {
          warn: () => {},
          info: (_message, fields) => events.push(fields as unknown as Record<string, unknown>),
        },
      },
    )
    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        requestQueue,
        recovery,
        fetch: ((async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          serializedModel = JSON.parse(String(init?.body)).model
          return new Response('overloaded', {
            status: 529,
            headers: { 'retry-after': '3' },
          })
        }) as unknown) as typeof fetch,
      },
    )

    let error: unknown
    try {
      await client.createMessages({
        model: 'claude-opus-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      })
    }
    catch (caught) {
      error = caught
    }

    expect(serializedModel).toBe('claude-opus-5')
    expect(error).toBeInstanceOf(TerminalUpstreamRecoveryError)
    expect(error).toMatchObject({
      status: 529,
      recovery: { requestId: 'pipeline-request', sourceModel: 'claude-opus-5' },
    })
    expect((error as TerminalUpstreamRecoveryError).headers.get('retry-after')).toBe('3')
    expect((error as TerminalUpstreamRecoveryError).toResponse().headers.get('retry-after')).toBe('3')
    expect(events).toContainEqual(expect.objectContaining({
      requestId: 'pipeline-request',
      callerRequestId: 'caller-request',
      effectiveModel: 'claude-opus-5',
      activeSlots: 1,
      maxSlots: 1,
      pendingDepth: 0,
    }))
  })

  test('offers an existing model cooldown through CopilotClient without a second fetch', async () => {
    consola.error = ((..._args: unknown[]) => {}) as typeof consola.error
    const requestQueue = new UpstreamRequestQueue(
      { concurrency: 1, maxRetries: 0, recoveryBudgetMs: 1_000 },
      { logger: { warn: () => {} } },
    )
    let fetchCalls = 0
    const fetchImpl = ((async () => {
      fetchCalls++
      return new Response('overloaded', {
        status: 529,
        headers: { 'retry-after': '3' },
      })
    }) as unknown) as typeof fetch
    const firstClient = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      { requestQueue, fetch: fetchImpl },
    )
    await expect(firstClient.createMessages({
      model: 'claude-opus-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toBeInstanceOf(TerminalUpstreamRecoveryError)

    const secondClient = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        requestQueue,
        fetch: fetchImpl,
        recovery: { requestId: 'second-request', retryCount: 0 },
        offerLocalModelCooldown: true,
      },
    )

    await expect(secondClient.createMessages({
      model: 'claude-opus-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toBeInstanceOf(LocalModelCooldownError)
    expect(fetchCalls).toBe(1)
  })

  test('rejects a fallback waiter when the target cools before its grant', async () => {
    const queue = new UpstreamRequestQueue(
      { concurrency: 1, maxRetries: 0, recoveryBudgetMs: 1_000 },
      {
        logger: { warn: () => {} },
        setTimeout: ((() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown) as typeof setTimeout,
        clearTimeout: (() => {}) as typeof clearTimeout,
      },
    )
    let resolveTarget!: (response: Response) => void
    const targetInFlight = queue.dispatch(
      () => new Promise<Response>(resolve => resolveTarget = resolve),
      {
        method: 'POST',
        url: 'https://api.githubcopilot.com/responses',
        effectiveModel: 'target',
      },
    )
    await Promise.resolve()

    let fallbackFetches = 0
    let fallbackOutcome = 'pending'
    const fallback = queue.dispatch(
      () => {
        fallbackFetches++
        return Promise.resolve(Response.json({ ok: true }))
      },
      {
        method: 'POST',
        url: 'https://api.githubcopilot.com/responses',
        effectiveModel: 'target',
        recovery: { requestId: 'fallback-request', retryCount: 0, sourceModel: 'source' },
        fallbackAttempt: true,
      },
    )
    void fallback.then(
      () => fallbackOutcome = 'resolved',
      () => fallbackOutcome = 'rejected',
    )

    resolveTarget(new Response('overloaded', {
      status: 529,
      headers: { 'retry-after': '2' },
    }))
    const target = await targetInFlight
    target.release()
    for (let index = 0; index < 5; index++)
      await Promise.resolve()

    expect(fallbackOutcome).toBe('rejected')
    expect(fallbackFetches).toBe(0)
  })
})

describe('completion POSTs are not replayed on ambiguous upstream failures', () => {
  function buildClient(status: number, calls: { n: number }) {
    // `now` must advance with `sleep`: a capacity status (429/529) arms the
    // global cooldown, and drain() only releases waiters once `now` has passed
    // it. A frozen clock parks the retry forever.
    let now = 1_000
    const requestQueue = new UpstreamRequestQueue(
      { concurrency: 1, maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 },
      {
        now: () => now,
        sleep: (ms) => {
          now += ms
          return Promise.resolve()
        },
        logger: { warn: () => {} },
        setTimeout: ((_cb: () => void) => undefined as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout,
        clearTimeout: (() => {}) as typeof clearTimeout,
      },
    )

    return new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        requestQueue,
        fetch: ((async () => {
          calls.n++
          if (calls.n === 1) {
            return new Response('upstream failed', { status })
          }
          return Response.json({ id: 'msg_1', content: [] })
        }) as unknown) as typeof fetch,
      },
    )
  }

  const messagesPayload = {
    model: 'claude-opus-5',
    max_tokens: 16,
    messages: [{ role: 'user' as const, content: 'hi' }],
  }

  // A 5xx does not mean the request was refused. It may have been fully
  // processed before failing — a proxy stream-idle timeout surfaces as 408,
  // and Envoy maps upstream connection termination to 503 — so replaying a
  // completion can bill the same client request twice.
  for (const status of [408, 500, 502, 503, 504]) {
    test(`createMessages does not replay upstream ${status}`, async () => {
      const calls = { n: 0 }
      const client = buildClient(status, calls)

      await expect(client.createMessages(messagesPayload)).rejects.toMatchObject({ status })
      expect(calls.n).toBe(1)
    })
  }

  // 429/529 stay retried: the upstream declined to serve rather than failing
  // while serving, and this is the case the queue was built for.
  for (const status of [429, 529]) {
    test(`createMessages still replays upstream ${status}`, async () => {
      const calls = { n: 0 }
      const client = buildClient(status, calls)

      await client.createMessages(messagesPayload)
      expect(calls.n).toBe(2)
    })
  }

  test('createResponses does not replay upstream 500', async () => {
    const calls = { n: 0 }
    const client = buildClient(500, calls)

    await expect(client.createResponses({
      model: 'gpt-5.6-sol',
      input: [],
    })).rejects.toMatchObject({ status: 500 })
    expect(calls.n).toBe(1)
  })

  test('createChatCompletions does not replay upstream 502', async () => {
    const calls = { n: 0 }
    const client = buildClient(502, calls)

    await expect(client.createChatCompletions({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toMatchObject({ status: 502 })
    expect(calls.n).toBe(1)
  })

  // Effect-free reads keep the wide tier — a duplicate costs a round trip.
  test('getModels still replays upstream 500', async () => {
    const calls = { n: 0 }
    const requestQueue = new UpstreamRequestQueue(
      { concurrency: 1, maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 },
      {
        now: () => 1_000,
        sleep: () => Promise.resolve(),
        logger: { warn: () => {} },
        setTimeout: ((_cb: () => void) => undefined as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout,
        clearTimeout: (() => {}) as typeof clearTimeout,
      },
    )
    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        requestQueue,
        fetch: ((async () => {
          calls.n++
          if (calls.n === 1) {
            return new Response('boom', { status: 500 })
          }
          return Response.json({ object: 'list', data: [] })
        }) as unknown) as typeof fetch,
      },
    )

    await client.getModels()
    expect(calls.n).toBe(2)
  })
})

describe('systemone transport', () => {
  const originalConsolaError = consola.error

  afterEach(() => {
    consola.error = originalConsolaError
  })

  test('normalizes validation evidence before the shared upstream logger sees it', async () => {
    let logged = 0
    consola.error = ((..._args: unknown[]) => {
      logged++
    }) as typeof consola.error
    const questions: Array<DecisionsQuestionMapping> = [{
      key: 'q0',
      name: null,
      kind: 'choice',
      choiceValues: [
        { key: 'c0', value: true },
        { key: 'c1', value: false },
      ],
    }]
    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        fetch: ((async () => Response.json({
          detail: [{
            loc: ['body', 'questions', 'q0', 'criteria', 'c1'],
            msg: 'bad choice evidence',
            type: 'value_error',
            input: 'SENSITIVE EVIDENCE',
          }],
        }, { status: 422 })) as unknown) as typeof fetch,
      },
    )

    let error: unknown
    try {
      await client.createSystemOne(
        { model: 'microsoft-decision-1', state: 'evidence', questions: {} },
        {
          errorMapper: (message, response) =>
            normalizeDecisionsUpstreamError(message, response, questions),
        },
      )
    }
    catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(HTTPError)
    const httpError = error as HTTPError
    expect(httpError.status).toBe(422)
    expect(httpError.body.error).toMatchObject({
      type: 'invalid_request_error',
      param: 'questions[0].choices[1]',
      code: 'upstream_validation_error',
      details: [{
        path: 'questions[0].choices[1]',
        message: 'bad choice evidence',
        code: 'value_error',
      }],
    })
    expect(JSON.stringify(httpError.body)).not.toContain('SENSITIVE EVIDENCE')
    expect(logged).toBe(0)
  })

  test('posts the translated payload to /v1/systemone with the caller signal', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        fetch: ((async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          capturedUrl = String(input)
          capturedInit = init
          return Response.json({
            model: 'microsoft-decision-1',
            answers: {},
            usage: { input_tokens: 1, output_tokens: 1 },
          })
        }) as unknown) as typeof fetch,
      },
    )
    const controller = new AbortController()
    const payload = {
      model: 'microsoft-decision-1',
      state: 'evidence',
      questions: {
        q0: { type: 'noul' as const, instructions: 'Is it?' },
      },
    }

    await client.createSystemOne(payload, { signal: controller.signal })

    expect(capturedUrl.endsWith('/v1/systemone')).toBe(true)
    expect(capturedInit?.method).toBe('POST')
    expect(capturedInit?.signal).toBe(controller.signal)
    expect(JSON.parse(String(capturedInit?.body))).toEqual(payload)
    const headers = new Headers(capturedInit?.headers)
    expect(headers.get('authorization')).toBe('Bearer test-token')
    expect(headers.get('copilot-integration-id')).toBe('vscode-chat')
  })

  test('replays capacity failures but not ambiguous 5xx responses', async () => {
    consola.error = ((..._args: unknown[]) => {}) as typeof consola.error
    const valid = {
      model: 'microsoft-decision-1',
      answers: {
        q0: {
          type: 'choice',
          choice: 'c0',
          confidence: 0.9,
          probabilities: { c0: 0.9, c1: 0.1 },
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }

    function buildClient(status: number, calls: { n: number }) {
      let now = 1_000
      const requestQueue = new UpstreamRequestQueue(
        { concurrency: 1, maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 },
        {
          now: () => now,
          sleep: (ms) => {
            now += ms
            return Promise.resolve()
          },
          logger: { warn: () => {} },
          setTimeout: ((_cb: () => void) => undefined as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout,
          clearTimeout: (() => {}) as typeof clearTimeout,
        },
      )
      return new CopilotClient(
        { copilotToken: 'test-token' },
        { accountType: 'individual', vsCodeVersion: '1.99.0' },
        {
          requestQueue,
          fetch: ((async () => {
            calls.n++
            if (calls.n === 1) {
              return new Response('busy', { status })
            }
            return Response.json(valid)
          }) as unknown) as typeof fetch,
        },
      )
    }

    for (const status of [429, 529]) {
      const calls = { n: 0 }
      await buildClient(status, calls).createSystemOne({
        model: 'microsoft-decision-1',
        state: 'evidence',
        questions: {},
      })
      expect(calls.n).toBe(2)
    }

    const calls = { n: 0 }
    await expect(buildClient(500, calls).createSystemOne({
      model: 'microsoft-decision-1',
      state: 'evidence',
      questions: {},
    })).rejects.toMatchObject({ status: 500 })
    expect(calls.n).toBe(1)
  })

  test('prevents dispatch when the caller aborts during queue wait', async () => {
    const requestQueue = new UpstreamRequestQueue(
      { concurrency: 1 },
      { logger: { warn: () => {} } },
    )
    const firstStarted = Promise.withResolvers<void>()
    const heldResponse = Promise.withResolvers<Response>()
    const firstPromise = requestQueue.dispatch(
      () => {
        firstStarted.resolve()
        return heldResponse.promise
      },
      { url: 'https://api.githubcopilot.com/held' },
    )
    await firstStarted.promise
    let fetchCalls = 0
    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        requestQueue,
        fetch: ((async () => {
          fetchCalls++
          return Response.json({})
        }) as unknown) as typeof fetch,
      },
    )
    const controller = new AbortController()

    const pending = client.createSystemOne({
      model: 'microsoft-decision-1',
      state: 'evidence',
      questions: {},
    }, { signal: controller.signal })
    for (let index = 0; index < 20; index++) {
      if (requestQueue.snapshot().pending > 0)
        break
      await Promise.resolve()
    }
    expect(requestQueue.snapshot().pending).toBe(1)
    controller.abort('cancelled')

    await expect(pending).rejects.toBe('cancelled')
    expect(fetchCalls).toBe(0)

    heldResponse.resolve(new Response('ok'))
    const first = await firstPromise
    first.release()
  })

  test('releases the lease when the caller aborts during the body read', async () => {
    const requestQueue = new UpstreamRequestQueue(
      { concurrency: 1 },
      { logger: { warn: () => {} } },
    )
    const fetchStarted = Promise.withResolvers<void>()
    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        requestQueue,
        fetch: ((async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const signal = init?.signal
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener('abort', () => controller.error(signal.reason), {
                once: true,
              })
            },
          })
          fetchStarted.resolve()
          return new Response(stream, { status: 200 })
        }) as unknown) as typeof fetch,
      },
    )
    const controller = new AbortController()

    const pending = client.createSystemOne({
      model: 'microsoft-decision-1',
      state: 'evidence',
      questions: {},
    }, { signal: controller.signal })
    await fetchStarted.promise
    controller.abort()

    await expect(pending).rejects.toBeDefined()
    expect(requestQueue.snapshot().active).toBe(0)
  })
})

describe('decisions error-body transport', () => {
  const originalConsolaError = consola.error

  afterEach(() => {
    consola.error = originalConsolaError
  })

  test('preserves a client abort while the error body is read', async () => {
    consola.error = ((..._args: unknown[]) => {}) as typeof consola.error
    const requestQueue = new UpstreamRequestQueue(
      { concurrency: 1 },
      { logger: { warn: () => {} } },
    )
    const bodyStarted = Promise.withResolvers<void>()
    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        requestQueue,
        fetch: ((async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const signal = init?.signal
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              bodyStarted.resolve()
              signal?.addEventListener('abort', () => controller.error(signal.reason), {
                once: true,
              })
            },
          })
          return new Response(stream, { status: 422 })
        }) as unknown) as typeof fetch,
      },
    )
    const questions: Array<DecisionsQuestionMapping> = [{
      key: 'q0',
      name: null,
      kind: 'choice',
      choiceValues: [
        { key: 'c0', value: true },
        { key: 'c1', value: false },
      ],
    }]
    const controller = new AbortController()
    const abortReason = new ClientAbortError()

    const pending = client.createSystemOne(
      { model: 'microsoft-decision-1', state: 'evidence', questions: {} },
      {
        signal: controller.signal,
        errorMapper: (message, response) =>
          normalizeDecisionsUpstreamError(message, response, questions),
      },
    )
    await bodyStarted.promise
    controller.abort(abortReason)

    let error: unknown
    try {
      await pending
    }
    catch (caught) {
      error = caught
    }

    expect(isClientAbortError(error)).toBe(true)
    expect(requestQueue.snapshot().active).toBe(0)
  })

  test('preserves a deadline miss while the error body is read', async () => {
    consola.error = ((..._args: unknown[]) => {}) as typeof consola.error
    const requestQueue = new UpstreamRequestQueue(
      { concurrency: 1 },
      { logger: { warn: () => {} } },
    )
    const bodyStarted = Promise.withResolvers<void>()
    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        requestQueue,
        fetch: ((async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const signal = init?.signal
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              bodyStarted.resolve()
              signal?.addEventListener('abort', () => controller.error(signal.reason), {
                once: true,
              })
            },
          })
          return new Response(stream, { status: 422 })
        }) as unknown) as typeof fetch,
      },
    )
    const questions: Array<DecisionsQuestionMapping> = [{
      key: 'q0',
      name: null,
      kind: 'choice',
      choiceValues: [
        { key: 'c0', value: true },
        { key: 'c1', value: false },
      ],
    }]
    const controller = new AbortController()
    const deadline = new DOMException('The operation was aborted.', 'AbortError')

    const pending = client.createSystemOne(
      { model: 'microsoft-decision-1', state: 'evidence', questions: {} },
      {
        signal: controller.signal,
        errorMapper: (message, response) =>
          normalizeDecisionsUpstreamError(message, response, questions),
      },
    )
    await bodyStarted.promise
    controller.abort(deadline)

    let error: unknown
    try {
      await pending
    }
    catch (caught) {
      error = caught
    }

    expect(isTimeoutLikeError(error)).toBe(true)
    expect(requestQueue.snapshot().active).toBe(0)
  })
})

describe('native decisions transport', () => {
  const originalConsolaError = consola.error

  afterEach(() => {
    consola.error = originalConsolaError
  })

  function buildClient(responses: Array<() => Response>, captured: Array<{ url: string, init?: RequestInit }>) {
    let now = 1_000
    const requestQueue = new UpstreamRequestQueue(
      { concurrency: 1, maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 },
      {
        now: () => now,
        sleep: (ms) => {
          now += ms
          return Promise.resolve()
        },
        logger: { warn: () => {} },
        setTimeout: ((_cb: () => void) => undefined as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout,
        clearTimeout: (() => {}) as typeof clearTimeout,
      },
    )
    return new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        requestQueue,
        fetch: ((async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          captured.push({ url: String(input), init })
          return responses[captured.length - 1]!()
        }) as unknown) as typeof fetch,
      },
    )
  }

  const payload = {
    model: 'gpt-6-luna-decisions',
    input: 'evidence',
    questions: [{ type: 'predicate' as const, name: 'q', instructions: 'Is it?' }],
  }

  test('posts the public payload to /v1/decisions and replays capacity failures', async () => {
    const captured: Array<{ url: string, init?: RequestInit }> = []
    const result = { model: 'gpt-6-luna', answers: [], usage: {} }
    const client = buildClient([
      () => new Response('busy', { status: 429 }),
      () => Response.json(result),
    ], captured)

    expect(await client.createDecisions(payload)).toEqual(result)
    expect(captured).toHaveLength(2)
    expect(captured[1]?.url.endsWith('/v1/decisions')).toBe(true)
    expect(JSON.parse(String(captured[1]?.init?.body))).toEqual(payload)
  })

  test('passes public error envelopes through and wraps plain-text gateway errors', async () => {
    consola.error = ((..._args: unknown[]) => {}) as typeof consola.error
    const envelope = {
      error: {
        message: 'Choice values must be unique within the question.',
        type: 'invalid_request_error',
        param: 'questions[0].choices[1].value',
        code: null,
      },
    }
    const captured: Array<{ url: string, init?: RequestInit }> = []
    const client = buildClient([
      () => Response.json(envelope, { status: 400 }),
      () => new Response('Bad Request', { status: 400, headers: { 'content-type': 'text/plain' } }),
    ], captured)

    await expect(client.createDecisions(payload)).rejects.toMatchObject({ status: 400, body: envelope })
    await expect(client.createDecisions(payload)).rejects.toMatchObject({
      status: 400,
      body: { error: { message: 'Bad Request' } },
    })
    expect(captured).toHaveLength(2)
  })
})
