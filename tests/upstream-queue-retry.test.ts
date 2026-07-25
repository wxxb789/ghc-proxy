import { describe, expect, test } from 'bun:test'

import { UpstreamRequestQueue } from '~/clients/upstream-queue'

interface HarnessOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

/**
 * Builds a queue with fully injected time so no real timers run.
 * `sleeps` records every backoff duration, `timers` every cooldown drain timer.
 */
function createHarness(options: HarnessOptions = {}) {
  let now = 1_000
  const sleeps: number[] = []
  const warnings: string[] = []
  const timers: Array<{ callback: () => void, delay: number }> = []

  const queue = new UpstreamRequestQueue(
    {
      concurrency: 1,
      maxRetries: options.maxRetries ?? 3,
      baseDelayMs: options.baseDelayMs ?? 100,
      maxDelayMs: options.maxDelayMs ?? 5_000,
    },
    {
      now: () => now,
      sleep: (ms) => {
        sleeps.push(ms)
        now += ms
        return Promise.resolve()
      },
      logger: { warn: message => warnings.push(message) },
      setTimeout: ((callback: () => void, delay: number) => {
        timers.push({ callback, delay })
        return timers.length as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
    },
  )

  return { queue, sleeps, warnings, timers }
}

const context = {
  method: 'POST',
  url: 'https://api.githubcopilot.com/v1/messages',
  retryable: true,
} as const

describe('UpstreamRequestQueue transient status retries', () => {
  test('retries 529 then returns the successful response', async () => {
    const { queue, sleeps } = createHarness()

    let calls = 0
    const queued = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(
          calls === 1
            ? new Response('overloaded', { status: 529 })
            : Response.json({ ok: true }),
        )
      },
      context,
    )

    expect(calls).toBe(2)
    expect(sleeps).toEqual([100])
    expect(queued.response.status).toBe(200)
    expect(await queued.response.json()).toEqual({ ok: true })
    queued.release()
  })

  const retryableStatuses = [408, 500, 502, 503, 504, 529] as const

  for (const status of retryableStatuses) {
    test(`retries upstream ${status}`, async () => {
      const { queue } = createHarness()

      let calls = 0
      const queued = await queue.dispatch(
        () => {
          calls++
          return Promise.resolve(
            calls === 1
              ? new Response('transient', { status })
              : Response.json({ ok: true }),
          )
        },
        context,
      )

      expect(calls).toBe(2)
      expect(queued.response.status).toBe(200)
      queued.release()
    })
  }

  // The guard that matters: retrying a malformed or unauthorized request just
  // multiplies a request that can never succeed.
  const nonRetryableStatuses = [400, 401, 403, 404, 422] as const

  for (const status of nonRetryableStatuses) {
    test(`does not retry upstream ${status}`, async () => {
      const { queue, sleeps } = createHarness()

      let calls = 0
      const queued = await queue.dispatch(
        () => {
          calls++
          return Promise.resolve(new Response('nope', { status }))
        },
        context,
      )

      expect(calls).toBe(1)
      expect(sleeps).toEqual([])
      expect(queued.response.status).toBe(status)
      queued.release()
    })
  }

  test('does not retry 529 when retryable is false', async () => {
    const { queue, sleeps } = createHarness()

    let calls = 0
    const queued = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(new Response('overloaded', { status: 529 }))
      },
      { ...context, retryable: false },
    )

    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
    expect(queued.response.status).toBe(529)
    queued.release()
  })

  test('returns the last response when the retry budget is exhausted', async () => {
    const { queue, sleeps } = createHarness({ maxRetries: 2 })

    let calls = 0
    const queued = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(new Response('overloaded', { status: 529 }))
      },
      context,
    )

    expect(calls).toBe(3)
    expect(sleeps).toEqual([100, 200])
    expect(queued.response.status).toBe(529)
    expect(await queued.response.text()).toBe('overloaded')
    queued.release()
  })

  test('prefers Retry-After over exponential backoff', async () => {
    const { queue, sleeps } = createHarness({ baseDelayMs: 10_000 })

    let calls = 0
    const queued = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(
          calls === 1
            ? new Response('unavailable', {
                status: 503,
                headers: { 'retry-after': '3' },
              })
            : Response.json({ ok: true }),
        )
      },
      context,
    )

    expect(sleeps).toEqual([3_000])
    queued.release()
  })

  test('logs the actual status instead of a rate-limit message', async () => {
    const { queue, warnings } = createHarness()

    let calls = 0
    const queued = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(
          calls === 1
            ? new Response('bad gateway', { status: 502 })
            : Response.json({ ok: true }),
        )
      },
      context,
    )

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toStartWith('Upstream 502;')
    queued.release()
  })
})

describe('UpstreamRequestQueue global cooldown scope', () => {
  test('529 applies a global cooldown', async () => {
    const { queue, timers } = createHarness()

    let calls = 0
    const queued = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(
          calls === 1
            ? new Response('overloaded', {
                status: 529,
                headers: { 'retry-after': '4' },
              })
            : Response.json({ ok: true }),
        )
      },
      context,
    )
    queued.release()

    // A pending drain timer means the queue is holding other requests back.
    expect(timers.some(timer => timer.delay > 0)).toBe(true)
  })

  test('502 backs off this request without stalling the queue', async () => {
    const { queue, timers, sleeps } = createHarness()

    let calls = 0
    const queued = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(
          calls === 1
            ? new Response('bad gateway', { status: 502 })
            : Response.json({ ok: true }),
        )
      },
      context,
    )
    queued.release()

    expect(sleeps).toEqual([100])
    expect(timers.every(timer => timer.delay <= 0)).toBe(true)
  })
})

describe('UpstreamRequestQueue abort during backoff', () => {
  test('rejects and releases the lease when aborted mid-backoff', async () => {
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
    const dispatched = queue.dispatch(
      // 502, not 529: a capacity status would also arm the global cooldown,
      // masking whether the lease itself came back.
      () => Promise.resolve(new Response('bad gateway', { status: 502 })),
      { ...context, retryable: true },
      controller.signal,
    )

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sleepResolve).toBeDefined()

    controller.abort('client gone')
    await expect(dispatched).rejects.toBe('client gone')

    // The lease must be back in the pool: with concurrency 1 a leaked lease
    // would leave this dispatch waiting forever.
    const next = await queue.dispatch(
      () => Promise.resolve(new Response('ok')),
      { ...context, retryable: false },
    )
    expect(await next.response.text()).toBe('ok')
    next.release()
  })
})
