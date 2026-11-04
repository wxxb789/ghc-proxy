import { describe, expect, it } from 'vitest'
import { metricsFixture } from '../test/fixtures'
import { buildBreakdown, buildHistogram, buildTimeSeries, metricSummary, windowKpis } from './series'

describe('monitor data shaping', () => {
  it('uses covered time, exclusive failures and the merged window quantile', () => {
    const metrics = metricsFixture({ coveredMs: 2_000, counts: { completed: 6, failed: 2, aborted: 4 } })
    expect(windowKpis(metrics)).toEqual({ requests: 12, rate: 6, errorRate: 0.25, p95: metrics.latency.p95 })
    expect(windowKpis(metricsFixture({ coveredMs: 0, counts: { completed: 0, failed: 0, aborted: 0 } })).rate).toBeNull()
    expect(windowKpis(metricsFixture({ counts: { completed: 0, failed: 0, aborted: 3 } })).errorRate).toBeNull()
  })

  it('keeps not-collected, partial-start, open, zero traffic and absent latency distinct', () => {
    const sample = metricsFixture().series[0]!
    const rows = buildTimeSeries(metricsFixture({ series: [
      { ...sample, startMs: 0, endMs: 10, coverage: 'not-collected' },
      { ...sample, startMs: 10, endMs: 20, coverage: 'partial-start' },
      { ...sample, startMs: 20, endMs: 30, coverage: 'full', counts: { completed: 0, failed: 0, aborted: 0 }, latency: { count: 0, sumMs: 0, p50: null, p95: null } },
      { ...sample, startMs: 30, endMs: 40, coverage: 'open' },
    ] }))
    expect(rows.map(row => [row.key, row.total, row.p50, row.p95, row.observed, row.coverage])).toEqual([
      ['0', null, null, null, null, 'Not collected'],
      ['10', 8, 500, 500, 6, 'Partial start'],
      ['20', 0, null, null, 0, 'Collected'],
      ['30', 8, 500, 500, 6, 'In progress'],
    ])
  })

  it('rebins every histogram cell including overflow exactly once with stable interval keys', () => {
    const rows = buildHistogram(metricsFixture({ latencyBoundsMs: [50, 100, 200, 400], latency: { count: 15, sumMs: 0, p50: null, p95: null, histogram: [1, 2, 3, 4, 5] } }), 2)
    expect(rows.map(row => [row.key, row.count])).toEqual([['0:200', 6], ['200:Infinity', 9]])
    expect(rows.reduce((total, row) => total + row.count, 0)).toBe(15)
  })

  it('folds to top eight without conflating a model named other with the tagged remainder', () => {
    const source = Array.from({ length: 10 }, (_, index) => ({ kind: 'named' as const, value: index === 0 ? 'other' : `model-${index}`, requests: 20 - index, failures: index }))
    const rows = buildBreakdown([...source, { kind: 'other', requests: 2, failures: 1 }])
    expect(rows).toHaveLength(9)
    expect(rows[0]).toMatchObject({ label: 'other', kind: 'named', requests: 20 })
    expect(rows.at(-1)).toMatchObject({ label: 'Other (folded)', kind: 'other', requests: 25, failures: 18 })
    expect(new Set(rows.map(row => row.key)).size).toBe(9)
    expect(rows.reduce((total, row) => total + row.requests, 0)).toBe(157)
    expect(rows.reduce((total, row) => total + row.failures, 0)).toBe(46)
  })

  it('generates window, latest, peak and collection facts from actual series', () => {
    const summary = metricSummary(metricsFixture(), 'requests')
    expect(summary).toContain('1h window')
    expect(summary).toContain('Latest 8 requests')
    expect(summary).toContain('peak 8 requests')
    expect(summary).toContain('Collection began')
    const latency = metricSummary(metricsFixture(), 'latency')
    expect(latency).toContain('6 observed completed-request samples')
    expect(latency).toContain('Latest p95 ≈ 500 ms')
    expect(latency).toContain('peak p95 ≈ 500 ms')
  })

  it('labels an entirely uncollected window as unknown instead of reporting a zero-traffic total', () => {
    const base = metricsFixture()
    const metrics = metricsFixture({ coveredMs: 0, counts: { completed: 0, failed: 0, aborted: 0 }, series: [{ ...base.series[0]!, coverage: 'not-collected' }] })
    expect(metricSummary(metrics, 'requests')).toContain('no collected time; terminal counts unavailable')
    expect(metricSummary(metrics, 'requests')).toContain('Latest not collected')
  })
})
