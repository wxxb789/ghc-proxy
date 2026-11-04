import type { DashboardWindowId } from '~/types/dashboard'

import { describe, expect, test } from 'bun:test'
import { WindowedMetrics } from '~/observability/windowed-metrics'

describe('windowed request metrics', () => {
  test('attributes terminal states and successful latency by completion and target', () => {
    let now = 60_005
    const metrics = new WindowedMetrics(() => now)
    metrics.record({ accountName: 'work', endpoint: '/v1/messages', effectiveModel: 'model-a', state: 'completed', durationMs: 37 }, now)
    now += 10
    metrics.record({ accountName: 'personal', endpoint: '/v1/messages', requestedModel: 'model-a', state: 'failed', durationMs: 80 }, now)
    now += 10
    metrics.record({ accountName: 'work', endpoint: '/v1/responses', state: 'aborted', durationMs: 90 }, now)

    const view = metrics.query('15m')
    expect(view.counts).toEqual({ completed: 1, failed: 1, aborted: 1 })
    expect(view.latency).toMatchObject({
      count: 1,
      sumMs: 37,
      p50: { valueMs: 37, kind: 'exact' },
      p95: { valueMs: 37, kind: 'exact' },
    })
    expect(view.byModel).toEqual([
      { kind: 'named', value: 'model-a', requests: 2, failures: 1 },
      { kind: 'none', requests: 1, failures: 0 },
    ])
    expect(view.series.find(bucket => bucket.startMs === 60_000)?.counts).toEqual({ completed: 1, failed: 1, aborted: 1 })
    expect(metrics.query('15m', 'work').counts).toEqual({ completed: 1, failed: 0, aborted: 1 })
    expect(metrics.query('15m', 'missing').counts).toEqual({ completed: 0, failed: 0, aborted: 0 })
  })
})

type Sample = Parameters<WindowedMetrics['record']>[0]

function record(metrics: WindowedMetrics, at: number, overrides: Partial<Sample> = {}): Sample {
  const sample: Sample = { endpoint: '/v1/messages', state: 'completed', durationMs: 100, ...overrides }
  metrics.record(sample, at)
  return sample
}

const windows: Array<{ window: DashboardWindowId, bucketMs: number, slots: number }> = [
  { window: '15m', bucketMs: 10_000, slots: 90 },
  { window: '1h', bucketMs: 60_000, slots: 60 },
  { window: '24h', bucketMs: 900_000, slots: 96 },
]

describe('window boundaries and coverage', () => {
  test.each(windows)('$window uses half-open buckets and expires without another write', ({ window, bucketMs, slots }) => {
    let now = 0
    const metrics = new WindowedMetrics(() => now)
    now = bucketMs - 1
    record(metrics, now)
    now = bucketMs
    record(metrics, now, { state: 'failed' })

    const first = metrics.query(window)
    expect(first.series.find(bucket => bucket.startMs === 0)?.counts.completed).toBe(1)
    expect(first.series.find(bucket => bucket.startMs === bucketMs)?.counts.failed).toBe(1)
    now = slots * bucketMs
    expect(metrics.query(window).counts).toEqual({ completed: 0, failed: 1, aborted: 0 })
    now += bucketMs
    expect(metrics.query(window).counts).toEqual({ completed: 0, failed: 0, aborted: 0 })
    record(metrics, now, { state: 'aborted' })
    expect(metrics.query(window).counts).toEqual({ completed: 0, failed: 0, aborted: 1 })
  })

  test('distinguishes uncollected, partial and open data after a recent start', () => {
    let now = 1_234_567
    const metrics = new WindowedMetrics(() => now)
    const began = now
    now += 120_000
    const view = metrics.query('24h')

    expect(Date.parse(view.collectionStartedAt)).toBe(began)
    expect(view.coveredMs).toBe(120_000)
    expect(view.series.find(bucket => bucket.startMs === 0)?.coverage).toBe('not-collected')
    expect(view.series.find(bucket => bucket.startMs === 900_000)?.coverage).toBe('partial-start')
    now = 1_810_000
    expect(metrics.query('24h').series.at(-1)?.coverage).toBe('open')
    expect(view.latency.p95).toBeNull()
  })

  test('accepts a backward in-window completion and resets a tier after a large clock regression', () => {
    let now = 1_000_000
    const metrics = new WindowedMetrics(() => now)
    record(metrics, now)
    now -= 10_000
    record(metrics, now, { state: 'failed' })
    now += 20_000
    expect(metrics.query('15m').counts).toEqual({ completed: 1, failed: 1, aborted: 0 })

    now -= 1_000_000
    record(metrics, now, { state: 'aborted' })
    const reset = metrics.query('15m')
    expect(reset.counts).toEqual({ completed: 0, failed: 0, aborted: 1 })
    expect(Date.parse(reset.collectionStartedAt)).toBe(now)
  })

  test('returned snapshots cannot corrupt later metrics', () => {
    const metrics = new WindowedMetrics(() => 10_000)
    record(metrics, 10_000, { effectiveModel: 'safe-model' })
    const view = metrics.query('15m')
    view.counts.completed = 800
    view.latency.histogram.fill(800)
    view.byModel[0]!.requests = 800
    view.series.at(-1)!.counts.completed = 800

    const next = metrics.query('15m')
    expect(next.counts.completed).toBe(1)
    expect(next.latency.histogram.reduce((sum, count) => sum + count, 0)).toBe(1)
    expect(next.byModel[0]?.requests).toBe(1)
    expect(next.series.at(-1)?.counts.completed).toBe(1)
  })
})

describe('bounded model identity', () => {
  test('shares admission across buckets and targets instead of naming a hot overflow model', () => {
    let now = 100_000
    const metrics = new WindowedMetrics(() => now)
    for (let index = 0; index < 16; index++) {
      record(metrics, now, { accountName: index % 2 ? 'personal' : 'work', effectiveModel: `model-${index.toString().padStart(2, '0')}` })
      now += 10_000
    }
    for (let index = 0; index < 5; index++)
      record(metrics, now, { accountName: 'm365', effectiveModel: `extra-${index}` })
    for (let index = 0; index < 100; index++)
      record(metrics, now, { accountName: 'work', effectiveModel: 'extra-0' })
    for (let index = 0; index < 5; index++)
      record(metrics, now, { accountName: 'personal', effectiveModel: 'model-00' })

    const view = metrics.query('15m')
    expect(view.byModel.some(row => row.kind === 'named' && row.value === 'extra-0')).toBe(false)
    expect(view.byModel.find(row => row.kind === 'other')?.requests).toBe(113)
    expect(view.byModel.find(row => row.value === 'model-00')?.requests).toBe(6)
    expect(metrics.query('15m', 'work').byModel.find(row => row.value === 'model-00')?.requests).toBe(1)
    expect(metrics.query('15m', 'personal').byModel.find(row => row.value === 'model-00')?.requests).toBe(5)
    expect(view.byModel.reduce((sum, row) => sum + row.requests, 0)).toBe(126)
    expect(view.byModel.at(-1)?.kind).toBe('other')
  })

  test('never splits retained overflow history when named slots expire', () => {
    let now = 0
    const metrics = new WindowedMetrics(() => now)
    for (let index = 0; index < 16; index++)
      record(metrics, now, { effectiveModel: `initial-${index}` })
    now = 500_000
    record(metrics, now, { effectiveModel: 'later-model' })
    now = 900_000
    record(metrics, now, { effectiveModel: 'later-model' })

    const folded = metrics.query('15m')
    expect(folded.byModel).toEqual([{ kind: 'other', requests: 2, failures: 0 }])
    now = 1_810_000
    record(metrics, now, { effectiveModel: 'later-model' })
    expect(metrics.query('15m').byModel).toEqual([{ kind: 'named', value: 'later-model', requests: 1, failures: 0 }])
  })

  test('keeps literal fold-like names and the absent model separate', () => {
    const metrics = new WindowedMetrics(() => 10_000)
    for (const model of ['other', 'constructor', 'toString'])
      record(metrics, 10_000, { effectiveModel: model })
    record(metrics, 10_000)

    const rows = metrics.query('15m').byModel
    expect(rows).toEqual(expect.arrayContaining([
      { kind: 'named', value: 'other', requests: 1, failures: 0 },
      { kind: 'named', value: 'constructor', requests: 1, failures: 0 },
      { kind: 'named', value: 'toString', requests: 1, failures: 0 },
      { kind: 'none', requests: 1, failures: 0 },
    ]))
    expect(rows.some(row => row.kind === 'other')).toBe(false)
  })

  test('distinguishes the account named all from an unfiltered query', () => {
    const metrics = new WindowedMetrics(() => 10_000)
    record(metrics, 10_000, { accountName: 'all' })
    record(metrics, 10_000, { accountName: 'work', state: 'failed' })
    record(metrics, 10_000, { state: 'aborted' })

    expect(metrics.query('15m', 'all').counts).toEqual({ completed: 1, failed: 0, aborted: 0 })
    expect(metrics.query('15m').byTarget).toEqual(expect.arrayContaining([
      { kind: 'named', value: 'all', requests: 1, failures: 0 },
      { kind: 'named', value: 'work', requests: 1, failures: 1 },
      { kind: 'none', requests: 1, failures: 0 },
    ]))
  })
})

describe('mergeable latency and late cancellation', () => {
  test('marks bounded quantiles honestly and merges distributions rather than percentiles', () => {
    const metrics = new WindowedMetrics(() => 10_000)
    for (const durationMs of [100, 125])
      record(metrics, 10_000, { accountName: 'work', durationMs })
    for (const durationMs of [160, 200])
      record(metrics, 10_000, { accountName: 'personal', durationMs })
    const latency = metrics.query('15m').latency

    expect(latency).toMatchObject({
      count: 4,
      sumMs: 585,
      p50: { valueMs: 125, kind: 'approximate' },
      p95: { valueMs: 200, kind: 'approximate' },
    })
    const left = metrics.query('15m', 'work').latency.histogram
    const right = metrics.query('15m', 'personal').latency.histogram
    expect(latency.histogram).toEqual(left.map((count, index) => count + right[index]!))
  })

  test.each([
    { durations: [10, 20], valueMs: 50, kind: 'at-most' },
    { durations: [3_000_000, 4_000_000], valueMs: 2_000_000, kind: 'at-least' },
  ])('reports $kind for an open-ended histogram bin', ({ durations, valueMs, kind }) => {
    const metrics = new WindowedMetrics(() => 10_000)
    for (const durationMs of durations)
      record(metrics, 10_000, { durationMs })
    expect(metrics.query('15m').latency.p95).toEqual({ valueMs, kind })
  })

  test('subtracts a late-aborted extreme and leaves the remaining single sample exact', () => {
    let now = 10_000
    const metrics = new WindowedMetrics(() => now)
    const first = record(metrics, now, { effectiveModel: 'model-a', durationMs: 50 })
    record(metrics, now, { effectiveModel: 'model-a', durationMs: 58 })
    metrics.reclassifyAborted(first, now)

    const view = metrics.query('15m')
    expect(view.counts).toEqual({ completed: 1, failed: 0, aborted: 1 })
    expect(view.latency).toMatchObject({ count: 1, sumMs: 58, p95: { valueMs: 58, kind: 'exact' } })
    expect(view.byModel).toEqual([{ kind: 'named', value: 'model-a', requests: 2, failures: 0 }])
    const expired = record(metrics, now, { durationMs: 70 })
    now = 1_000_000
    metrics.reclassifyAborted(expired, 10_000)
    expect(metrics.query('15m').counts).toEqual({ completed: 0, failed: 0, aborted: 0 })
  })

  test('finite-bin quantiles remain within one ladder ratio of an independent exact sort', () => {
    const metrics = new WindowedMetrics(() => 10_000)
    let seed = 0x1234ABCD
    const durations: number[] = []
    for (let index = 0; index < 501; index++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      const durationMs = 100 + seed % 1_999_900
      durations.push(durationMs)
      record(metrics, 10_000, { durationMs })
    }
    durations.sort((left, right) => left - right)
    const latency = metrics.query('15m').latency
    for (const [percentile, quantile] of [[0.5, latency.p50], [0.95, latency.p95]] as const) {
      const exact = durations[Math.ceil(durations.length * percentile) - 1]!
      expect(quantile?.kind).toBe('approximate')
      expect(quantile!.valueMs).toBeGreaterThanOrEqual(exact)
      expect(quantile!.valueMs).toBeLessThanOrEqual(exact * 1.28)
    }
  })
})

test('seeded event-list oracle reconciles every window, target, fold and late abort', () => {
  let now = 0
  let seed = 0x1A2B3C4D
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
    return seed >>> 8
  }
  const metrics = new WindowedMetrics(() => now)
  const events: Array<{ at: number, sample: Sample }> = []
  const effects: Array<{ at: number, accountName: string | undefined, endpoint: string }> = []
  const targets = [undefined, 'work', 'm365', 'all'] as const
  const endpoints = ['/v1/messages', '/v1/responses', '/v1/chat/completions', '/health']

  for (let index = 0; index < 1_200; index++) {
    now += 1 + random() % 180_000
    const sample = record(metrics, now, {
      accountName: targets[random() % targets.length],
      endpoint: endpoints[random() % endpoints.length]!,
      effectiveModel: `model-${index}`,
      state: index % 11 === 0 ? 'failed' : index % 17 === 0 ? 'aborted' : 'completed',
      durationMs: 50 + random() % 20_000,
    })
    events.push({ at: now, sample })
    if (index % 10 === 0) {
      const prior = events[Math.max(0, index - 5)]!
      if (prior.sample.state === 'completed') {
        metrics.reclassifyAborted(prior.sample, prior.at)
        prior.sample.state = 'aborted'
      }
    }
    metrics.recordEffect(sample.accountName, sample.endpoint, 'responses.parameter_filter', 1)
    effects.push({ at: now, accountName: sample.accountName, endpoint: sample.endpoint })
    if (index % 100 !== 99)
      continue

    for (const { window, bucketMs, slots } of windows) {
      const firstBucket = Math.floor(now / bucketMs) * bucketMs - (slots - 1) * bucketMs
      for (const target of [...targets, 'missing']) {
        const selected = events.filter(event => event.at >= firstBucket && event.sample.endpoint !== '/health' && (target === undefined || event.sample.accountName === target))
        const expected = { completed: 0, failed: 0, aborted: 0 }
        for (const event of selected)
          expected[event.sample.state]++
        const view = metrics.query(window, target)
        expect(view.counts).toEqual(expected)
        expect(view.latency.count).toBe(expected.completed)
        expect(view.latency.histogram.reduce((sum, count) => sum + count, 0)).toBe(expected.completed)
        for (const rows of [view.byModel, view.byTarget, view.byEndpoint]) {
          expect(rows.reduce((sum, row) => sum + row.requests, 0)).toBe(selected.length)
          expect(rows.reduce((sum, row) => sum + row.failures, 0)).toBe(expected.failed)
        }
        const expectedEffects = effects.filter(effect => effect.at >= firstBucket && effect.endpoint !== '/health' && (target === undefined || effect.accountName === target)).length
        expect(view.effects['responses.parameter_filter'] ?? 0).toBe(expectedEffects)
      }
    }
  }
})

test('marks an expired range unavailable when a small clock rollback exposes it again', () => {
  let now = 0
  const metrics = new WindowedMetrics(() => now)
  record(metrics, now)
  now = 900_000
  record(metrics, now)
  now = 890_000

  const view = metrics.query('15m')
  expect(view.counts).toEqual({ completed: 0, failed: 0, aborted: 0 })
  expect(view.series.find(bucket => bucket.startMs === 0)?.coverage).toBe('not-collected')
})

test('keeps collection identity stable during query-only clock regression', () => {
  let now = 1_000_000
  const metrics = new WindowedMetrics(() => now)
  record(metrics, now)
  now = 0
  const first = metrics.query('15m')
  now = 100
  const second = metrics.query('15m')

  expect(first.counts).toEqual({ completed: 0, failed: 0, aborted: 0 })
  expect(first.coveredMs).toBe(0)
  expect(first.collectionStartedAt).toBe(second.collectionStartedAt)
  expect(Date.parse(first.collectionStartedAt)).toBe(1_000_000)
  record(metrics, now)
  expect(Date.parse(metrics.query('15m').collectionStartedAt)).toBe(100)
})
