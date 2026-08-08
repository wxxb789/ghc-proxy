import { describe, expect, test } from 'bun:test'

import {
  LocalModelCooldownError,
  TerminalUpstreamRecoveryError,
  UpstreamRequestQueue,
} from '~/clients/upstream-queue'

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
      random: () => 1,
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

  test.each([
    [502, 'Upstream 502;'],
    [429, 'Upstream rate limited (429);'],
    [529, 'Upstream overloaded (529);'],
  ] as const)('labels upstream %i as %s', async (status, prefix) => {
    const { queue, warnings } = createHarness()
    let calls = 0
    const queued = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(
          calls === 1
            ? new Response('retryable', { status })
            : Response.json({ ok: true }),
        )
      },
      context,
    )

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toStartWith(prefix)
    queued.release()
  })
})

describe('UpstreamRequestQueue capacity cooldown scope', () => {
  test('429 applies an account cooldown', async () => {
    const { queue, timers } = createHarness()

    const queued = await queue.dispatch(
      () => Promise.resolve(new Response('limited', {
        status: 429,
        headers: { 'retry-after': '4' },
      })),
      { ...context, retryable: false, effectiveModel: 'model-a' },
    )
    queued.release()

    let unrelatedCalls = 0
    void queue.dispatch(
      () => {
        unrelatedCalls++
        return Promise.resolve(new Response('ok'))
      },
      { ...context, retryable: false, effectiveModel: 'model-b' },
    )
    await Promise.resolve()

    expect(unrelatedCalls).toBe(0)
    expect(timers.some(timer => timer.delay > 0)).toBe(true)
  })

  test('502 backs off this request without stalling the queue', async () => {
    const { queue, sleeps } = createHarness()

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

    let unrelatedCalls = 0
    const unrelated = await queue.dispatch(
      () => {
        unrelatedCalls++
        return Promise.resolve(new Response('ok'))
      },
      { ...context, retryable: false },
    )

    expect(sleeps).toEqual([100])
    expect(unrelatedCalls).toBe(1)
    unrelated.release()
  })

  test('arms the cooldown before releasing the lease', async () => {
    // A non-resolving sleep parks the dispatch mid-backoff so the queue can be
    // inspected at exactly the moment the lease is released.
    let sleepResolve: (() => void) | undefined
    const queue = new UpstreamRequestQueue(
      { concurrency: 1, maxRetries: 2, baseDelayMs: 5_000, maxDelayMs: 60_000 },
      {
        sleep: () => new Promise<void>((resolve) => { sleepResolve = resolve }),
        random: () => 1,
        logger: { warn: () => {} },
      },
    )

    let waiterCalls = 0
    const first = queue.dispatch(
      () => Promise.resolve(new Response('overloaded', { status: 529 })),
      { ...context, effectiveModel: 'model-a' },
    )
    // Queued behind `first` while it holds the only slot.
    const waiter = queue.dispatch(
      () => {
        waiterCalls++
        return Promise.resolve(new Response('ok'))
      },
      { ...context, effectiveModel: 'model-a' },
    )

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sleepResolve).toBeDefined()

    // release() drains synchronously. With the cooldown installed after the
    // release, this waiter was handed the freed slot and reached fetcher()
    // before any back-pressure existed — exactly the amplification the
    // cooldown is meant to prevent.
    expect(waiterCalls).toBe(0)

    void first
    void waiter
  })

  test('applies a cooldown when the retry budget is exhausted', async () => {
    const { queue, timers } = createHarness({
      maxRetries: 1,
      baseDelayMs: 5_000,
      maxDelayMs: 60_000,
    })

    const queued = await queue.dispatch(
      () => Promise.resolve(new Response('overloaded', { status: 529 })),
      { ...context, effectiveModel: 'model-a' },
    )
    expect(queued.response.status).toBe(529)

    let waiterCalls = 0
    void queue.dispatch(
      () => {
        waiterCalls++
        return Promise.resolve(new Response('ok'))
      },
      { ...context, retryable: false, effectiveModel: 'model-a' },
    )
    queued.release()
    await Promise.resolve()

    expect(waiterCalls).toBe(0)
    expect(timers.at(-1)!.delay).toBeGreaterThan(0)
  })

  test('applies a cooldown for a capacity limit when maxRetries is 0', async () => {
    const { queue, timers, sleeps } = createHarness({ maxRetries: 0 })

    let calls = 0
    const queued = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(
          new Response('rate limited', {
            status: 429,
            headers: { 'retry-after': '6' },
          }),
        )
      },
      context,
    )

    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
    expect(queued.response.status).toBe(429)

    let waiterCalls = 0
    void queue.dispatch(
      () => {
        waiterCalls++
        return Promise.resolve(new Response('ok'))
      },
      { ...context, retryable: false, effectiveModel: 'model-b' },
    )
    queued.release()
    await Promise.resolve()

    expect(waiterCalls).toBe(0)
    expect(timers.some(timer => timer.delay > 0)).toBe(true)
  })
})

describe('UpstreamRequestQueue abort during backoff', () => {
  test('clears backoff timers and releases the lease when aborted', async () => {
    const timers: Array<{ callback: () => void, cleared: boolean }> = []
    const events: Array<Record<string, unknown>> = []
    const queue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 3,
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
      },
      {
        logger: {
          warn: () => {},
          info: (_message, fields) => events.push(fields as unknown as Record<string, unknown>),
        },
        setTimeout: ((callback: () => void) => {
          const timer = { callback, cleared: false }
          timers.push(timer)
          return timer as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout,
        clearTimeout: ((timer: ReturnType<typeof setTimeout>) => {
          (timer as unknown as { cleared: boolean }).cleared = true
        }) as typeof clearTimeout,
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

    for (let index = 0; index < 20 && timers.length < 2; index++)
      await Promise.resolve()
    expect(timers).toHaveLength(2)

    controller.abort('client gone')
    await expect(dispatched).rejects.toBe('client gone')
    expect(timers.every(timer => timer.cleared)).toBe(true)
    expect(events.filter(event => event.decision === 'cancelled')).toHaveLength(1)
    expect(events.filter(event => event.decision === 'deadline-exceeded')).toHaveLength(0)

    // The lease must be back in the pool: with concurrency 1 a leaked lease
    // would leave this dispatch waiting forever.
    const next = await queue.dispatch(
      () => Promise.resolve(new Response('ok')),
      { ...context, retryable: false },
    )
    expect(await next.response.text()).toBe('ok')
    next.release()
  })

  test('classifies a proxy timeout separately from caller cancellation', async () => {
    const events: Array<Record<string, unknown>> = []
    const queue = new UpstreamRequestQueue(
      { concurrency: 1, maxRetries: 0 },
      {
        logger: {
          warn: () => {},
          info: (_message, fields) => events.push(fields as unknown as Record<string, unknown>),
        },
      },
    )
    const caller = new AbortController()
    const proxyTimeout = new AbortController()
    const upstreamSignal = AbortSignal.any([caller.signal, proxyTimeout.signal])
    const timeoutReason = new DOMException('Upstream timeout', 'TimeoutError')
    const dispatched = queue.dispatch(
      signal => new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      }),
      {
        ...context,
        recovery: {
          requestId: 'proxy-timeout',
          callerSignal: caller.signal,
          retryCount: 0,
        },
      },
      upstreamSignal,
    )

    await Promise.resolve()
    proxyTimeout.abort(timeoutReason)

    await expect(dispatched).rejects.toBe(timeoutReason)
    expect(caller.signal.aborted).toBe(false)
    expect(events.filter(event => event.decision === 'cancelled')).toHaveLength(0)
    expect(events.filter(event => event.decision === 'deadline-exceeded')).toEqual([
      expect.objectContaining({ event: 'budget', status: 504 }),
    ])
  })
})

describe('UpstreamRequestQueue scoped cooldown scheduling', () => {
  function createScopedHarness(maxQueueDepth = 10, concurrency = 1) {
    let now = 1_000
    const timers: Array<{ callback: () => void, delay: number }> = []
    const queue = new UpstreamRequestQueue(
      {
        concurrency,
        maxRetries: 0,
        baseDelayMs: 100,
        maxDelayMs: 100,
        maxQueueDepth,
      },
      {
        now: () => now,
        random: () => 1,
        sleep: () => Promise.resolve(),
        logger: { warn: () => {} },
        setTimeout: ((callback: () => void, delay: number) => {
          timers.push({ callback, delay })
          return timers.length as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout,
        clearTimeout: (() => {}) as typeof clearTimeout,
      },
    )

    return {
      queue,
      timers,
      advance(ms: number) {
        now += ms
        timers.at(-1)?.callback()
      },
    }
  }

  test('model 529 parks the same model while an unrelated model uses the free slot', async () => {
    const { queue } = createScopedHarness()
    const source = await queue.dispatch(
      () => Promise.resolve(new Response('overloaded', {
        status: 529,
        headers: { 'retry-after': '10' },
      })),
      { ...context, effectiveModel: 'model-a' },
    )
    source.release()

    const order: string[] = []
    void queue.dispatch(
      () => {
        order.push('a')
        return Promise.resolve(new Response('a'))
      },
      { ...context, retryable: false, effectiveModel: 'model-a' },
    )
    const modelB = await queue.dispatch(
      () => {
        order.push('b')
        return Promise.resolve(new Response('b'))
      },
      { ...context, retryable: false, effectiveModel: 'model-b' },
    )

    expect(order).toEqual(['b'])
    modelB.release()
  })

  test('wakes only the free slots in FIFO order when a model cooldown expires', async () => {
    const { queue, advance } = createScopedHarness(10, 2)
    const source = await queue.dispatch(
      () => Promise.resolve(new Response('overloaded', {
        status: 529,
        headers: { 'retry-after': '10' },
      })),
      { ...context, retryable: false, effectiveModel: 'model-a' },
    )
    source.release()

    const order: string[] = []
    const pending = ['first', 'second', 'third'].map(name => queue.dispatch(
      () => {
        order.push(name)
        return Promise.resolve(new Response(name))
      },
      { ...context, retryable: false, effectiveModel: 'model-a' },
    ))

    advance(10_000)
    for (let index = 0; index < 5; index++)
      await Promise.resolve()
    expect(order).toEqual(['first', 'second'])

    const first = await pending[0]!
    const second = await pending[1]!
    first.release()
    const third = await pending[2]!
    expect(order).toEqual(['first', 'second', 'third'])

    second.release()
    third.release()
  })

  test('model-less 529 remains request-scoped', async () => {
    const { queue } = createScopedHarness()
    const source = await queue.dispatch(
      () => Promise.resolve(new Response('overloaded', {
        status: 529,
        headers: { 'retry-after': '10' },
      })),
      context,
    )
    source.release()

    let dispatched = false
    const unrelated = await queue.dispatch(
      () => {
        dispatched = true
        return Promise.resolve(new Response('ok'))
      },
      { ...context, retryable: false, effectiveModel: 'model-b' },
    )

    expect(dispatched).toBe(true)
    unrelated.release()
  })

  test('eligible request bypasses cooled waiters that fill pending depth when a slot is free', async () => {
    const { queue } = createScopedHarness(1)
    const source = await queue.dispatch(
      () => Promise.resolve(new Response('overloaded', {
        status: 529,
        headers: { 'retry-after': '10' },
      })),
      { ...context, effectiveModel: 'model-a' },
    )
    source.release()

    void queue.dispatch(
      () => Promise.resolve(new Response('a')),
      { ...context, retryable: false, effectiveModel: 'model-a' },
    )
    const modelB = await queue.dispatch(
      () => Promise.resolve(new Response('b')),
      { ...context, retryable: false, effectiveModel: 'model-b' },
    )

    expect(await modelB.response.text()).toBe('b')
    modelB.release()
  })

  test('slices a cooldown beyond the JavaScript timer range without shortening its deadline', async () => {
    const { queue, timers } = createScopedHarness()
    let resolveSource: ((response: Response) => void) | undefined
    const sourcePromise = queue.dispatch(
      () => new Promise<Response>((resolve) => { resolveSource = resolve }),
      { ...context, retryable: false },
    )
    void queue.dispatch(
      () => Promise.resolve(new Response('too early')),
      { ...context, retryable: false },
    )
    await new Promise(resolve => setTimeout(resolve, 0))

    resolveSource!(new Response('limited', {
      status: 429,
      headers: { 'retry-after': '2147484' },
    }))
    const source = await sourcePromise
    source.release()

    expect(timers.at(-1)?.delay).toBe(2_147_483_647)
  })

  test('keeps oversized Retry-After telemetry from leaking a queue slot', async () => {
    const { queue } = createScopedHarness()
    const source = await queue.dispatch(
      () => Promise.resolve(new Response('overloaded', {
        status: 529,
        headers: { 'retry-after': '9999999999999999' },
      })),
      { ...context, retryable: false, effectiveModel: 'model-a' },
    )
    expect(source.response.status).toBe(529)
    source.release()

    const unrelated = await queue.dispatch(
      () => Promise.resolve(new Response('ok')),
      { ...context, retryable: false, effectiveModel: 'model-b' },
    )
    expect(await unrelated.response.text()).toBe('ok')
    unrelated.release()
  })

  test('updates a shared cooldown wake incrementally at maximum pending depth', async () => {
    const { queue } = createScopedHarness(1_000)
    const source = await queue.dispatch(
      () => Promise.resolve(new Response('overloaded', {
        status: 529,
        headers: { 'retry-after': '10' },
      })),
      { ...context, retryable: false, effectiveModel: 'model-a' },
    )
    source.release()

    const internals = queue as unknown as {
      getActiveCooldown: (effectiveModel?: string) => unknown
    }
    const getActiveCooldown = internals.getActiveCooldown.bind(queue)
    let cooldownChecks = 0
    internals.getActiveCooldown = (effectiveModel) => {
      cooldownChecks++
      return getActiveCooldown(effectiveModel)
    }

    const controllers: AbortController[] = []
    for (let index = 0; index < 1_000; index++)
      controllers.push(new AbortController())
    const pending = controllers.map(controller => queue.dispatch(
      () => Promise.resolve(new Response('too early')),
      { ...context, retryable: false, effectiveModel: 'model-a' },
      controller.signal,
    ))
    for (const promise of pending)
      void promise.catch(() => {})

    const enqueueChecks = cooldownChecks
    expect(enqueueChecks).toBeLessThan(5_000)
    for (const controller of controllers)
      controller.abort('cancelled')
    await Promise.allSettled(pending)
    expect(cooldownChecks - enqueueChecks).toBeLessThan(1_000)
  })
})

describe('UpstreamRequestQueue bounded recovery', () => {
  function createRecoveryHarness(options: {
    maxRetries?: number
    recoveryBudgetMs?: number
    random?: () => number
  } = {}) {
    let now = 1_000
    const sleeps: number[] = []
    const timers: Array<{ callback: () => void, delay: number }> = []
    const events: Array<Record<string, unknown>> = []
    const queue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: options.maxRetries,
        baseDelayMs: 100,
        maxDelayMs: 500,
        recoveryBudgetMs: options.recoveryBudgetMs ?? 1_000,
      },
      {
        now: () => now,
        wallNow: () => 10_000,
        random: options.random ?? (() => 1),
        sleep: (ms) => {
          sleeps.push(ms)
          now += ms
          return Promise.resolve()
        },
        logger: {
          warn: () => {},
          info: (_message, fields) => events.push(fields as unknown as Record<string, unknown>),
        },
        setTimeout: ((callback: () => void, delay: number) => {
          timers.push({ callback, delay })
          return timers.length as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout,
        clearTimeout: (() => {}) as typeof clearTimeout,
      },
    )
    return { queue, sleeps, timers, events }
  }

  test('defaults to one retry and caps configured retries at two', async () => {
    for (const [maxRetries, expectedCalls] of [[undefined, 2], [99, 3]] as const) {
      const { queue } = createRecoveryHarness({ maxRetries })
      let calls = 0
      const result = await queue.dispatch(
        () => {
          calls++
          return Promise.resolve(new Response('overloaded', { status: 529 }))
        },
        { ...context, retryable: 'capacity' },
      )

      expect(calls).toBe(expectedCalls)
      expect(result.response.status).toBe(529)
      result.release()
    }
  })

  test('emits one terminal decision after a recovered retry', async () => {
    const { queue, events } = createRecoveryHarness({ maxRetries: 1, random: () => 0 })
    let calls = 0
    const result = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(calls === 1
          ? new Response('overloaded', { status: 529 })
          : new Response('ok'))
      },
      { ...context, retryable: 'capacity', effectiveModel: 'model-a' },
    )

    expect(events.filter(event => event.decision === 'recovered')).toHaveLength(1)
    result.release()
  })

  test('emits one terminal decision when connection retries are exhausted', async () => {
    const { queue, events } = createRecoveryHarness({ maxRetries: 0 })
    const connectionError = Object.assign(new Error('dns unavailable'), { code: 'ENOTFOUND' })

    await expect(queue.dispatch(
      () => Promise.reject(connectionError),
      { ...context, retryable: 'capacity' },
    )).rejects.toBe(connectionError)

    expect(events.filter(event => event.decision === 'retry-exhausted')).toHaveLength(1)
  })

  test('emits one terminal decision when capacity retries are exhausted', async () => {
    const { queue, events } = createRecoveryHarness({ maxRetries: 0 })
    const result = await queue.dispatch(
      () => Promise.resolve(new Response('overloaded', { status: 529 })),
      { ...context, retryable: 'capacity', effectiveModel: 'model-a' },
    )

    expect(events.filter(event => event.decision === 'retry-limit')).toHaveLength(1)
    result.release()
  })

  test('deduplicates terminal decisions across dispatches sharing one recovery', async () => {
    const { queue, events } = createRecoveryHarness({ maxRetries: 0 })
    const recovery = { requestId: 'shared-recovery', retryCount: 0 }
    const source = await queue.dispatch(
      () => Promise.resolve(new Response('overloaded', { status: 529 })),
      {
        ...context,
        retryable: 'capacity',
        effectiveModel: 'model-a',
        recovery,
      },
    )
    source.release()

    const fallback = await queue.dispatch(
      () => Promise.resolve(new Response('ok')),
      {
        ...context,
        retryable: false,
        effectiveModel: 'model-b',
        recovery,
        fallbackAttempt: true,
      },
    )
    fallback.release()

    const terminalDecisions = events.filter(event =>
      event.decision === 'retry-limit' || event.decision === 'recovered',
    )
    expect(terminalDecisions).toHaveLength(1)
    expect(terminalDecisions[0]?.decision).toBe('retry-limit')
  })

  test('surfaces a fallback fetch deadline as 504 without source retry metadata', async () => {
    let now = 1_000
    const timers: Array<{ callback: () => void, cleared: boolean }> = []
    const events: Array<Record<string, unknown>> = []
    const queue = new UpstreamRequestQueue(
      { concurrency: 1, maxRetries: 0, recoveryBudgetMs: 1_000 },
      {
        now: () => now,
        logger: {
          warn: () => {},
          info: (_message, fields) => events.push(fields as unknown as Record<string, unknown>),
        },
        setTimeout: ((callback: () => void) => {
          const timer = { callback, cleared: false }
          timers.push(timer)
          return timer as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout,
        clearTimeout: ((timer: ReturnType<typeof setTimeout>) => {
          (timer as unknown as { cleared: boolean }).cleared = true
        }) as typeof clearTimeout,
      },
    )
    const recovery = {
      requestId: 'fallback-timeout',
      retryCount: 1,
      retryLimit: 1,
      startedAtMonotonicMs: now,
      deadlineMonotonicMs: now + 1_000,
      sourceModel: 'source',
      publicError: { status: 529, retryAfter: '9' },
    }
    const dispatched = queue.dispatch(
      signal => new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      }),
      {
        ...context,
        retryable: 'capacity',
        effectiveModel: 'target',
        recovery,
        fallbackAttempt: true,
      },
    )

    for (let index = 0; index < 20 && timers.length === 0; index++)
      await Promise.resolve()
    now = 2_000
    timers[0]!.callback()

    let error: unknown
    try {
      await dispatched
    }
    catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ status: 504 })
    expect((error as { headers: Headers }).headers.get('retry-after')).toBeNull()
    expect(events.filter(event => event.decision === 'deadline-exceeded')).toHaveLength(1)
  })

  test('does not shorten a server minimum that exceeds the recovery budget', async () => {
    const { queue, sleeps } = createRecoveryHarness({ maxRetries: 2, recoveryBudgetMs: 1_000 })
    let calls = 0
    const result = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(new Response('overloaded', {
          status: 529,
          headers: { 'retry-after': '2' },
        }))
      },
      { ...context, retryable: 'capacity', effectiveModel: 'model-a' },
    )

    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
    expect(result.response.headers.get('retry-after')).toBe('2')
    result.release()

    let earlyRetry = false
    await expect(queue.dispatch(
      () => {
        earlyRetry = true
        return Promise.resolve(new Response('too early'))
      },
      { ...context, retryable: false, effectiveModel: 'model-a' },
    )).rejects.toBeInstanceOf(TerminalUpstreamRecoveryError)
    expect(earlyRetry).toBe(false)
  })

  test('cancels a private retry response body before the next fetch', async () => {
    const { queue } = createRecoveryHarness({ maxRetries: 1, random: () => 0 })
    let cancelled = false
    let calls = 0
    const result = await queue.dispatch(
      () => {
        calls++
        if (calls === 1) {
          return Promise.resolve(new Response(new ReadableStream({
            cancel() {
              cancelled = true
            },
          }), { status: 529 }))
        }
        return Promise.resolve(new Response('ok'))
      },
      { ...context, retryable: 'capacity' },
    )

    expect(cancelled).toBe(true)
    expect(calls).toBe(2)
    result.release()
  })

  test('does not let a pending body cancellation escape the recovery budget', async () => {
    const { queue } = createRecoveryHarness({ maxRetries: 1, random: () => 0 })
    let resolveCancellation: (() => void) | undefined
    let calls = 0
    const dispatched = queue.dispatch(
      () => {
        calls++
        if (calls === 1) {
          return Promise.resolve(new Response(new ReadableStream({
            cancel() {
              return new Promise<void>((resolve) => {
                resolveCancellation = resolve
              })
            },
          }), { status: 529 }))
        }
        return Promise.resolve(new Response('ok'))
      },
      { ...context, retryable: 'capacity' },
    )

    for (let index = 0; index < 20; index++) {
      if (calls >= 2)
        break
      await Promise.resolve()
    }
    const callsBeforeCancellationSettled = calls
    resolveCancellation!()
    const result = await dispatched

    expect(callsBeforeCancellationSettled).toBe(2)
    result.release()
  })

  test.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ConnectionRefused'])(
    'retries measured pre-connection failure %s once',
    async (code) => {
      const { queue } = createRecoveryHarness({ maxRetries: 1, random: () => 0 })
      let calls = 0
      const result = await queue.dispatch(
        () => {
          calls++
          if (calls === 1) {
            const cause = Object.assign(new Error(code), { code })
            return Promise.reject(new TypeError('fetch failed', { cause }))
          }
          return Promise.resolve(new Response('ok'))
        },
        { ...context, retryable: 'capacity' },
      )

      expect(calls).toBe(2)
      result.release()
    },
  )

  test.each([
    ['caller abort shape', new DOMException('aborted', 'AbortError')],
    ['timeout', Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })],
    ['reset', Object.assign(new Error('reset'), { code: 'ECONNRESET' })],
    ['TLS', Object.assign(new Error('certificate'), { code: 'CERT_HAS_EXPIRED' })],
    ['generic TypeError', new TypeError('fetch failed')],
  ])('does not retry excluded connection failure %s', async (_name, error) => {
    const { queue } = createRecoveryHarness({ maxRetries: 1 })
    let calls = 0
    await expect(queue.dispatch(
      () => {
        calls++
        return Promise.reject(error)
      },
      { ...context, retryable: 'capacity' },
    )).rejects.toBe(error)
    expect(calls).toBe(1)
  })

  test('preserves the causal connection error when retry reacquisition exhausts the budget', async () => {
    let now = 1_000
    let resolveBackoff: (() => void) | undefined
    const timers: Array<{ callback: () => void, cleared: boolean }> = []
    const queue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 1,
        recoveryBudgetMs: 1_000,
      },
      {
        now: () => now,
        random: () => 0,
        sleep: () => new Promise<void>((resolve) => { resolveBackoff = resolve }),
        logger: { warn: () => {} },
        setTimeout: ((callback: () => void) => {
          const timer = { callback, cleared: false }
          timers.push(timer)
          return timer as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout,
        clearTimeout: ((timer: ReturnType<typeof setTimeout>) => {
          (timer as unknown as { cleared: boolean }).cleared = true
        }) as typeof clearTimeout,
      },
    )
    const originalError = Object.assign(new Error('dns unavailable'), { code: 'ENOTFOUND' })
    const retried = queue.dispatch(
      () => Promise.reject(originalError),
      { ...context, retryable: 'capacity' },
    )

    for (let index = 0; index < 20; index++) {
      if (resolveBackoff)
        break
      await Promise.resolve()
    }
    const blocker = await queue.dispatch(
      () => Promise.resolve(new Response('busy')),
      { ...context, retryable: false },
    )
    resolveBackoff!()
    for (let index = 0; index < 20 && !(timers.length >= 2 && timers[0]!.cleared); index++)
      await Promise.resolve()

    now = 2_000
    timers.findLast(timer => !timer.cleared)!.callback()
    await expect(retried).rejects.toBe(originalError)
    blocker.release()
  })

  test('aborts a recovery fetch at the queue-owned deadline and surfaces the prior 529', async () => {
    const { queue, timers } = createRecoveryHarness({ maxRetries: 1, random: () => 0 })
    let calls = 0
    const dispatched = queue.dispatch(
      (signal) => {
        calls++
        if (calls === 1)
          return Promise.resolve(new Response('overloaded', { status: 529 }))
        return new Promise<Response>((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
        })
      },
      { ...context, retryable: 'capacity', effectiveModel: 'model-a' },
    )

    for (let i = 0; i < 5; i++) {
      if (calls >= 2)
        break
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(calls).toBe(2)
    timers.at(-1)!.callback()
    await expect(dispatched).rejects.toBeInstanceOf(TerminalUpstreamRecoveryError)
  })

  test('keeps caller cancellation linked after a retry Response commits', async () => {
    const { queue } = createRecoveryHarness({ maxRetries: 1, random: () => 0 })
    const controller = new AbortController()
    let calls = 0
    let committedSignal: AbortSignal | undefined
    const result = await queue.dispatch(
      (signal) => {
        calls++
        if (calls === 1)
          return Promise.resolve(new Response('overloaded', { status: 529 }))
        committedSignal = signal
        return Promise.resolve(new Response('ok'))
      },
      { ...context, retryable: 'capacity' },
      controller.signal,
    )

    expect(committedSignal?.aborted).toBe(false)
    controller.abort('caller gone')
    expect(committedSignal?.aborted).toBe(true)
    result.release()
  })

  test('offers a pre-existing model cooldown as a one-shot typed handoff', async () => {
    const { queue } = createRecoveryHarness({ maxRetries: 0 })
    const source = await queue.dispatch(
      () => Promise.resolve(new Response('overloaded', {
        status: 529,
        headers: { 'retry-after': '2' },
      })),
      { ...context, retryable: false, effectiveModel: 'model-a' },
    )
    source.release()

    const recovery = { requestId: 'request-1', retryCount: 0 }
    let error: unknown
    try {
      await queue.dispatch(
        () => Promise.resolve(new Response('too early')),
        {
          ...context,
          retryable: 'capacity',
          effectiveModel: 'model-a',
          recovery,
          offerLocalModelCooldown: true,
        },
      )
    }
    catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(LocalModelCooldownError)
    expect(recovery.retryCount).toBe(0)
    expect(recovery).toMatchObject({
      sourceModel: 'model-a',
      cooldown: { scope: 'model', effectiveModel: 'model-a' },
    })
    expect((error as LocalModelCooldownError).claimFallback()).toBe(true)
    expect((error as LocalModelCooldownError).claimFallback()).toBe(false)
  })
})
