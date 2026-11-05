import type { Sample } from './samples.ts'
import { describe, expect, it } from 'vitest'
import { overview } from '../test/fixtures.ts'
import { buckets, failureRate, isRestart, peak, premiumUsed, pushSample, SAMPLE_CAPACITY, sampleFrom, sinceOpen, sparkRuns, sumDelta, throughput } from './samples.ts'

function series(points: Array<Partial<Sample> & { t: number }>): Sample[] {
  let list: Sample[] = []
  for (const point of points)
    list = pushSample(list, { ...sampleFrom(overview(), point.t), ...point })
  return list
}

describe('sample buffer', () => {
  it('flattens an overview', () => {
    const sample = sampleFrom(overview({ activity: { activeRequests: 2, completed: 10, failed: 1 }, queue: { pending: 3 } }), 5)
    expect(sample).toMatchObject({ t: 5, active: 2, completed: 10, failed: 1, qPending: 3, qConcurrency: 4, maxPending: 64, premiumRemaining: 812 })
  })

  it('caps the ring at 180 samples', () => {
    const list = series(Array.from({ length: SAMPLE_CAPACITY + 5 }, (_, index) => ({ t: index * 2000 })))
    expect(list).toHaveLength(SAMPLE_CAPACITY)
    expect(list[0]!.t).toBe(10_000)
  })

  it('marks a gap after more than 6 s and skips deltas across it', () => {
    const list = series([{ t: 0, completed: 0 }, { t: 2000, completed: 2 }, { t: 20_000, completed: 50 }, { t: 22_000, completed: 51 }])
    expect(list.map(sample => sample.gap)).toEqual([false, false, true, false])
    expect(sumDelta(list, 'completed')).toBe(3)
    expect(sparkRuns(list, 'completed', 22_000)).toHaveLength(2)
  })

  it('clamps negative deltas to zero', () => {
    const list = series([{ t: 0, failed: 5 }, { t: 2000, failed: 3 }, { t: 4000, failed: 4 }])
    expect(sumDelta(list, 'failed')).toBe(1)
  })

  it('detects a restart from a lower uptime or a new start time', () => {
    const base = { uptimeMs: 10_000, startedAt: 'a' }
    expect(isRestart(base, { uptimeMs: 500, startedAt: 'a' })).toBe(true)
    expect(isRestart(base, { uptimeMs: 12_000, startedAt: 'b' })).toBe(true)
    expect(isRestart(base, { uptimeMs: 12_000, startedAt: 'a' })).toBe(false)
  })
})

describe('derived figures', () => {
  it('computes throughput per minute only after 10 s of contiguous samples', () => {
    const short = series([{ t: 0, completed: 0 }, { t: 2000, completed: 1 }])
    expect(throughput(short, 2000)).toBeNull()
    const list = series(Array.from({ length: 31 }, (_, index) => ({ t: index * 2000, completed: index, aborted: 0 })))
    expect(throughput(list, 60_000)).toBeCloseTo(30)
  })

  it('computes the failure rate and premium usage over the buffer', () => {
    const list = series([{ t: 0, completed: 0, failed: 0, premiumRemaining: 100 }, { t: 2000, completed: 10, failed: 2, premiumRemaining: 97 }])
    expect(failureRate(list)).toBe(20)
    expect(premiumUsed(list)).toBe(3)
    expect(failureRate(series([{ t: 0 }, { t: 2000 }]))).toBeNull()
  })

  it('buckets deltas into 10 s slots ending now', () => {
    const list = series([{ t: 0, failed: 0 }, { t: 2000, failed: 1 }, { t: 8000, failed: 3 }])
    expect(buckets(list, 'failed', 12_000, 3)).toEqual([0, 1, 2])
  })

  it('reports peaks and growth since open', () => {
    const list = series([{ t: 0, active: 1, failed: 2 }, { t: 2000, active: 4, failed: 5 }])
    expect(peak(list, 'active')).toBe(4)
    expect(sinceOpen(list[0]!, list.at(-1), 'failed')).toBe(3)
    expect(sinceOpen(null, list.at(-1), 'failed')).toBeNull()
  })
})
