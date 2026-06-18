import { describe, expect, test } from 'bun:test'

import { createDefaultUpstreamRequestQueue, parseRetryAfterMs, UpstreamRequestQueue } from '~/clients/upstream-queue'

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
    const blocked = queue.dispatch(
      () => Promise.resolve(new Response('should not run')),
      { url: 'https://test' },
      controller.signal,
    )

    await Promise.resolve()
    controller.abort('client disconnected')

    await expect(blocked).rejects.toBe('client disconnected')
    first.release()
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
    queued.release()

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
