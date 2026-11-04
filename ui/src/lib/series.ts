import type { DashboardBreakdown, DashboardMetricBucket, DashboardMetrics } from '@contract'
import { formatDateTime, formatDuration, formatInteger, formatQuantile } from './format'

export interface TimePoint {
  key: string
  startMs: number
  endMs: number
  coverage: string
  completed: number | null
  failed: number | null
  aborted: number | null
  total: number | null
  p50: number | null
  p95: number | null
  p50Label: string
  p95Label: string
  observed: number | null
}

export interface HistogramPoint {
  key: string
  label: string
  lowerMs: number
  upperMs: number
  count: number
}

export interface BreakdownPoint extends DashboardBreakdown {
  key: string
  label: string
}

export function windowKpis(metrics: DashboardMetrics) {
  const { completed, failed, aborted } = metrics.counts
  const requests = completed + failed + aborted
  return {
    requests,
    rate: metrics.coveredMs > 0 ? requests / (metrics.coveredMs / 1_000) : null,
    errorRate: completed + failed > 0 ? failed / (completed + failed) : null,
    p95: metrics.latency.p95,
  }
}

const COVERAGE = { 'not-collected': 'Not collected', 'partial-start': 'Partial start', 'open': 'In progress', 'full': 'Collected' } as const

export function buildTimeSeries(metrics: DashboardMetrics): TimePoint[] {
  return metrics.series.map((bucket) => {
    const collected = bucket.coverage !== 'not-collected'
    return {
      key: String(bucket.startMs),
      startMs: bucket.startMs,
      endMs: bucket.endMs,
      coverage: COVERAGE[bucket.coverage],
      completed: collected ? bucket.counts.completed : null,
      failed: collected ? bucket.counts.failed : null,
      aborted: collected ? bucket.counts.aborted : null,
      total: collected ? bucket.counts.completed + bucket.counts.failed + bucket.counts.aborted : null,
      p50: collected ? bucket.latency.p50?.valueMs ?? null : null,
      p95: collected ? bucket.latency.p95?.valueMs ?? null : null,
      p50Label: !collected ? 'Not collected' : bucket.latency.p50 === null ? 'No samples' : formatQuantile(bucket.latency.p50),
      p95Label: !collected ? 'Not collected' : bucket.latency.p95 === null ? 'No samples' : formatQuantile(bucket.latency.p95),
      observed: collected ? bucket.latency.count : null,
    }
  })
}

export function buildHistogram(metrics: DashboardMetrics, maxBars = 12): HistogramPoint[] {
  const { histogram } = metrics.latency
  const groupSize = Math.max(1, Math.ceil(histogram.length / maxBars))
  const rows: HistogramPoint[] = []
  for (let start = 0; start < histogram.length; start += groupSize) {
    const end = Math.min(start + groupSize, histogram.length)
    const lowerMs = start === 0 ? 0 : metrics.latencyBoundsMs[start - 1]!
    const upperMs = end > metrics.latencyBoundsMs.length ? Infinity : metrics.latencyBoundsMs[end - 1]!
    let count = 0
    for (let index = start; index < end; index++)
      count += histogram[index]!
    const label = upperMs === Infinity
      ? `Over ${formatDuration(lowerMs)}`
      : start === 0 ? `Up to ${formatDuration(upperMs)}` : `Over ${formatDuration(lowerMs)} to ${formatDuration(upperMs)}`
    rows.push({ key: `${lowerMs}:${upperMs}`, lowerMs, upperMs, label, count })
  }
  return rows
}

export function buildBreakdown(source: readonly DashboardBreakdown[], limit = 8): BreakdownPoint[] {
  const named = source.filter(row => row.kind !== 'other').map(row => ({
    ...row,
    key: JSON.stringify([row.kind, row.value ?? null]),
    label: row.kind === 'none' ? 'Not specified' : row.value ?? '',
  })).sort((left, right) => right.requests - left.requests || left.key.localeCompare(right.key))
  const rows: BreakdownPoint[] = named.slice(0, limit)
  const remainder = [...source.filter(row => row.kind === 'other'), ...named.slice(limit)]
  if (remainder.length > 0) {
    rows.push({
      kind: 'other',
      key: JSON.stringify(['other', null]),
      label: 'Other (folded)',
      requests: remainder.reduce((sum, row) => sum + row.requests, 0),
      failures: remainder.reduce((sum, row) => sum + row.failures, 0),
    })
  }
  return rows
}

export function metricSummary(metrics: DashboardMetrics, kind: 'requests' | 'latency'): string {
  let latest: DashboardMetricBucket | undefined
  let peakRequests = 0
  let peakLatency: DashboardMetricBucket | undefined
  for (const bucket of metrics.series) {
    if (bucket.coverage === 'not-collected')
      continue
    latest = bucket
    if (kind === 'requests') {
      peakRequests = Math.max(peakRequests, bucket.counts.completed + bucket.counts.failed + bucket.counts.aborted)
    }
    else {
      const p95 = bucket.latency.p95
      if (p95 !== null && p95.valueMs > (peakLatency?.latency.p95?.valueMs ?? -Infinity))
        peakLatency = bucket
    }
  }
  const collection = `Collection began ${formatDateTime(metrics.collectionStartedAt)}.`
  if (kind === 'requests') {
    const total = metrics.counts.completed + metrics.counts.failed + metrics.counts.aborted
    const latestTotal = latest ? latest.counts.completed + latest.counts.failed + latest.counts.aborted : null
    return `${metrics.window} window: ${metrics.coveredMs > 0 ? `${formatInteger(total)} terminal requests` : 'no collected time; terminal counts unavailable'}. Latest ${latest ? formatInteger(latestTotal) : 'not collected'} requests; peak ${latest ? formatInteger(peakRequests) : 'not collected'} requests per interval. ${collection}`
  }
  const latestP95 = latest ? latest.latency.p95 === null ? 'No samples' : formatQuantile(latest.latency.p95) : 'not collected'
  return `${metrics.window} window: p95 ${formatQuantile(metrics.latency.p95)} from ${formatInteger(metrics.latency.count)} observed completed-request samples. Latest p95 ${latestP95}; peak p95 ${peakLatency ? formatQuantile(peakLatency.latency.p95) : 'No samples'}. ${collection}`
}
