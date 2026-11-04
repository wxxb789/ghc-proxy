import type {
  DashboardBreakdown,
  DashboardLatencySummary,
  DashboardMetricBucket,
  DashboardMetrics,
  DashboardQuantile,
  DashboardStateCounts,
  DashboardTerminalState,
  DashboardWindowId,
} from '~/types/dashboard'

import { DASHBOARD_WINDOWS, LATENCY_BOUNDS_MS } from '~/types/dashboard'

const MODEL_LIMIT = 16
const MODEL_ROW_LIMIT = 8
const ENDPOINT_LIMIT = 64
const NO_TARGET = '(none)'
const HISTOGRAM_SIZE = LATENCY_BOUNDS_MS.length + 1

interface TerminalRequest {
  accountName?: string
  endpoint: string
  effectiveModel?: string
  requestedModel?: string
  state: DashboardTerminalState
  durationMs: number
}

interface BreakdownCounts {
  requests: number
  failures: number
}

interface DimensionCounts {
  named: Map<string, BreakdownCounts>
  none: BreakdownCounts
  other: BreakdownCounts
}

interface MetricCell {
  counts: DashboardStateCounts
  histogram: Float64Array
  latencyCount: number
  latencySumMs: number
  models: DimensionCounts
  endpoints: DimensionCounts
  effects: Map<string, number>
}

interface MetricSlot {
  bucketId: number
  cells: Map<string, MetricCell>
}

interface MetricTier {
  durationMs: number
  bucketMs: number
  slots: Array<MetricSlot | undefined>
  models: Map<string, number>
  lastOverflowBucketId?: number
  collectionStartedAtMs: number
  lastObservedAtMs: number
  oldestRetainedBucketId: number
}

export class WindowedMetrics {
  private readonly now: () => number
  private readonly tiers: Record<DashboardWindowId, MetricTier>
  private readonly tierList: readonly MetricTier[]

  constructor(now: () => number) {
    this.now = now
    const at = now()
    this.tiers = {
      '15m': createTier('15m', at),
      '1h': createTier('1h', at),
      '24h': createTier('24h', at),
    }
    this.tierList = Object.values(this.tiers)
  }

  record(request: TerminalRequest, completedAtMs: number): void {
    if (isExcludedEndpoint(request.endpoint))
      return

    const at = this.now()
    const model = request.effectiveModel ?? request.requestedModel
    const bin = request.state === 'completed' ? latencyBin(request.durationMs) : -1
    for (const tier of this.tierList) {
      observeWrite(tier, at)
      const bucketId = Math.floor(completedAtMs / tier.bucketMs)
      const cell = writableCell(tier, bucketId, at, request.accountName)
      if (!cell)
        continue

      cell.counts[request.state]++
      if (bin >= 0) {
        cell.histogram[bin]++
        cell.latencyCount++
        cell.latencySumMs += request.durationMs
      }
      const failures = request.state === 'failed' ? 1 : 0
      if (model === undefined) {
        cell.models.none.requests++
        cell.models.none.failures += failures
      }
      else if (admitModel(tier, model, bucketId)) {
        addBreakdown(cell.models.named, model, 1, failures)
      }
      else {
        cell.models.other.requests++
        cell.models.other.failures += failures
      }
      if (cell.endpoints.named.has(request.endpoint) || cell.endpoints.named.size < ENDPOINT_LIMIT) {
        addBreakdown(cell.endpoints.named, request.endpoint, 1, failures)
      }
      else {
        cell.endpoints.other.requests++
        cell.endpoints.other.failures += failures
      }
    }
  }

  reclassifyAborted(request: TerminalRequest, completedAtMs: number): void {
    if (isExcludedEndpoint(request.endpoint))
      return

    const at = this.now()
    const bin = latencyBin(request.durationMs)
    for (const tier of this.tierList) {
      const bucketId = Math.floor(completedAtMs / tier.bucketMs)
      if (tier.lastObservedAtMs - at > tier.durationMs || !isRetainedBucket(tier, bucketId, at))
        continue
      const slot = tier.slots[slotIndex(tier, bucketId)]
      if (slot?.bucketId !== bucketId)
        continue
      const cell = slot.cells.get(request.accountName ?? NO_TARGET)
      if (!cell)
        continue

      // The store reclassifies each retained successful request at most once.
      cell.counts.completed--
      cell.counts.aborted++
      cell.histogram[bin]--
      cell.latencyCount--
      cell.latencySumMs = cell.latencyCount === 0 ? 0 : cell.latencySumMs - request.durationMs
    }
  }

  recordEffect(accountName: string | undefined, endpoint: string, effectId: string, count: number): void {
    if (isExcludedEndpoint(endpoint) || count <= 0)
      return

    const at = this.now()
    for (const tier of this.tierList) {
      observeWrite(tier, at)
      const cell = writableCell(tier, Math.floor(at / tier.bucketMs), at, accountName)
      if (cell)
        cell.effects.set(effectId, (cell.effects.get(effectId) ?? 0) + count)
    }
  }

  query(windowId: DashboardWindowId, target?: string): DashboardMetrics {
    const at = this.now()
    const tier = this.tiers[windowId]
    const currentBucketId = Math.floor(at / tier.bucketMs)
    const firstBucketId = currentBucketId - tier.slots.length + 1
    // Reads never rotate slots, reclaim names, or commit a clock reset.
    const clockReset = tier.lastObservedAtMs - at > tier.durationMs
    const collectionStartedAtMs = tier.collectionStartedAtMs
    const counts = emptyStateCounts()
    const histogram = new Float64Array(HISTOGRAM_SIZE)
    const bucketHistogram = new Float64Array(HISTOGRAM_SIZE)
    const models = emptyDimensionCounts()
    const targets = emptyDimensionCounts()
    const endpoints = emptyDimensionCounts()
    const effects = new Map<string, number>()
    const series: DashboardMetricBucket[] = []
    let latencyCount = 0
    let latencySumMs = 0

    for (let bucketId = firstBucketId; bucketId <= currentBucketId; bucketId++) {
      const startMs = bucketId * tier.bucketMs
      const endMs = startMs + tier.bucketMs
      const coverage = clockReset || bucketId < tier.oldestRetainedBucketId
        ? 'not-collected'
        : bucketCoverage(startMs, endMs, collectionStartedAtMs, bucketId === currentBucketId)
      const bucketCounts = emptyStateCounts()
      const bucketEffects = new Map<string, number>()
      bucketHistogram.fill(0)
      let bucketLatencyCount = 0
      let bucketLatencySumMs = 0
      const slot = tier.slots[slotIndex(tier, bucketId)]
      if (!clockReset && coverage !== 'not-collected'
        && bucketId >= tier.oldestRetainedBucketId && slot?.bucketId === bucketId) {
        for (const [accountName, cell] of slot.cells) {
          if (target !== undefined && (target === NO_TARGET || accountName !== target))
            continue
          mergeStateCounts(bucketCounts, cell.counts)
          bucketLatencyCount += cell.latencyCount
          bucketLatencySumMs += cell.latencySumMs
          for (let bin = 0; bin < HISTOGRAM_SIZE; bin++)
            bucketHistogram[bin] += cell.histogram[bin]
          mergeDimensionCounts(models, cell.models)
          mergeDimensionCounts(endpoints, cell.endpoints)
          const requests = cell.counts.completed + cell.counts.failed + cell.counts.aborted
          if (requests > 0) {
            if (accountName === NO_TARGET) {
              targets.none.requests += requests
              targets.none.failures += cell.counts.failed
            }
            else {
              addBreakdown(targets.named, accountName, requests, cell.counts.failed)
            }
          }
          mergeEffects(bucketEffects, cell.effects)
        }
      }

      mergeStateCounts(counts, bucketCounts)
      latencyCount += bucketLatencyCount
      latencySumMs += bucketLatencySumMs
      for (let bin = 0; bin < HISTOGRAM_SIZE; bin++)
        histogram[bin] += bucketHistogram[bin]
      mergeEffects(effects, bucketEffects)
      series.push({
        startMs,
        endMs,
        coverage,
        counts: bucketCounts,
        latency: summarizeLatency(bucketHistogram, bucketLatencyCount, bucketLatencySumMs),
        effects: Object.fromEntries(bucketEffects),
      })
    }

    const startMs = firstBucketId * tier.bucketMs
    return {
      window: windowId,
      bucketMs: tier.bucketMs,
      collectionStartedAt: new Date(collectionStartedAtMs).toISOString(),
      startMs,
      endMs: (currentBucketId + 1) * tier.bucketMs,
      coveredMs: clockReset ? 0 : Math.max(0, at - Math.max(startMs, collectionStartedAtMs)),
      counts,
      latency: {
        ...summarizeLatency(histogram, latencyCount, latencySumMs),
        histogram: Array.from(histogram),
      },
      latencyBoundsMs: [...LATENCY_BOUNDS_MS],
      series,
      byModel: breakdownRows(models, MODEL_ROW_LIMIT),
      byTarget: breakdownRows(targets),
      byEndpoint: breakdownRows(endpoints),
      effects: Object.fromEntries(effects),
    }
  }

  reset(): void {
    const at = this.now()
    for (const tier of this.tierList)
      resetTier(tier, at)
  }
}

function createTier(windowId: DashboardWindowId, at: number): MetricTier {
  const { durationMs, bucketMs, slots } = DASHBOARD_WINDOWS[windowId]
  return {
    durationMs,
    bucketMs,
    slots: Array.from<MetricSlot | undefined>({ length: slots }),
    models: new Map(),
    collectionStartedAtMs: at,
    lastObservedAtMs: at,
    oldestRetainedBucketId: Math.floor(at / bucketMs) - slots + 1,
  }
}

function resetTier(tier: MetricTier, at: number): void {
  tier.slots.fill(undefined)
  tier.models.clear()
  tier.lastOverflowBucketId = undefined
  tier.collectionStartedAtMs = at
  tier.lastObservedAtMs = at
  tier.oldestRetainedBucketId = Math.floor(at / tier.bucketMs) - tier.slots.length + 1
}

function observeWrite(tier: MetricTier, at: number): void {
  if (tier.lastObservedAtMs - at > tier.durationMs) {
    resetTier(tier, at)
    return
  }
  tier.lastObservedAtMs = at
  tier.collectionStartedAtMs = Math.min(tier.collectionStartedAtMs, at)
  // Once expired on a write, a small clock step cannot revive a stamped slot.
  tier.oldestRetainedBucketId = Math.max(
    tier.oldestRetainedBucketId,
    Math.floor(at / tier.bucketMs) - tier.slots.length + 1,
  )
}

function isRetainedBucket(tier: MetricTier, bucketId: number, at: number): boolean {
  const currentBucketId = Math.floor(at / tier.bucketMs)
  return bucketId >= Math.max(tier.oldestRetainedBucketId, currentBucketId - tier.slots.length + 1)
    && bucketId <= currentBucketId
}

function slotIndex(tier: MetricTier, bucketId: number): number {
  return ((bucketId % tier.slots.length) + tier.slots.length) % tier.slots.length
}

function writableCell(tier: MetricTier, bucketId: number, at: number, accountName?: string): MetricCell | undefined {
  if (!isRetainedBucket(tier, bucketId, at))
    return undefined

  const index = slotIndex(tier, bucketId)
  let slot = tier.slots[index]
  if (!slot) {
    slot = { bucketId, cells: new Map() }
    tier.slots[index] = slot
  }
  else if (slot.bucketId !== bucketId) {
    slot.bucketId = bucketId
    slot.cells.clear()
  }
  const key = accountName ?? NO_TARGET
  let cell = slot.cells.get(key)
  if (!cell) {
    cell = {
      counts: emptyStateCounts(),
      histogram: new Float64Array(HISTOGRAM_SIZE),
      latencyCount: 0,
      latencySumMs: 0,
      models: emptyDimensionCounts(),
      endpoints: emptyDimensionCounts(),
      effects: new Map(),
    }
    slot.cells.set(key, cell)
  }
  return cell
}

function admitModel(tier: MetricTier, model: string, bucketId: number): boolean {
  for (const [name, lastBucketId] of tier.models) {
    if (lastBucketId < tier.oldestRetainedBucketId)
      tier.models.delete(name)
  }
  const lastBucketId = tier.models.get(model)
  if (lastBucketId !== undefined) {
    tier.models.set(model, Math.max(lastBucketId, bucketId))
    return true
  }

  // Retained overflow may already contain this name. Do not start a partial
  // named history until all overflow has expired; no overflow-name set is kept.
  const hasOverflow = tier.lastOverflowBucketId !== undefined
    && tier.lastOverflowBucketId >= tier.oldestRetainedBucketId
  if (!hasOverflow && tier.models.size < MODEL_LIMIT) {
    tier.models.set(model, bucketId)
    return true
  }
  tier.lastOverflowBucketId = Math.max(tier.lastOverflowBucketId ?? bucketId, bucketId)
  return false
}

function isExcludedEndpoint(endpoint: string): boolean {
  return endpoint === '/' || endpoint === '/health'
}

function emptyStateCounts(): DashboardStateCounts {
  return { completed: 0, failed: 0, aborted: 0 }
}

function mergeStateCounts(into: DashboardStateCounts, from: DashboardStateCounts): void {
  into.completed += from.completed
  into.failed += from.failed
  into.aborted += from.aborted
}

function emptyDimensionCounts(): DimensionCounts {
  return {
    named: new Map(),
    none: { requests: 0, failures: 0 },
    other: { requests: 0, failures: 0 },
  }
}

function addBreakdown(into: Map<string, BreakdownCounts>, name: string, requests: number, failures: number): void {
  const counts = into.get(name)
  if (counts) {
    counts.requests += requests
    counts.failures += failures
  }
  else {
    into.set(name, { requests, failures })
  }
}

function mergeDimensionCounts(into: DimensionCounts, from: DimensionCounts): void {
  for (const [name, counts] of from.named)
    addBreakdown(into.named, name, counts.requests, counts.failures)
  into.none.requests += from.none.requests
  into.none.failures += from.none.failures
  into.other.requests += from.other.requests
  into.other.failures += from.other.failures
}

function breakdownRows(counts: DimensionCounts, limit = Number.POSITIVE_INFINITY): DashboardBreakdown[] {
  const named = [...counts.named].sort(([leftName, left], [rightName, right]) =>
    right.requests - left.requests || (leftName < rightName ? -1 : leftName > rightName ? 1 : 0))
  const rows: DashboardBreakdown[] = []
  let otherRequests = counts.other.requests
  let otherFailures = counts.other.failures
  for (let index = 0; index < named.length; index++) {
    const [value, counts] = named[index]
    if (index < limit) {
      rows.push({ kind: 'named', value, requests: counts.requests, failures: counts.failures })
    }
    else {
      otherRequests += counts.requests
      otherFailures += counts.failures
    }
  }
  if (counts.none.requests > 0)
    rows.push({ kind: 'none', requests: counts.none.requests, failures: counts.none.failures })
  if (otherRequests > 0)
    rows.push({ kind: 'other', requests: otherRequests, failures: otherFailures })
  return rows
}

function mergeEffects(into: Map<string, number>, from: Map<string, number>): void {
  for (const [effectId, count] of from)
    into.set(effectId, (into.get(effectId) ?? 0) + count)
}

function latencyBin(durationMs: number): number {
  for (let index = 0; index < LATENCY_BOUNDS_MS.length; index++) {
    if (durationMs <= LATENCY_BOUNDS_MS[index])
      return index
  }
  return LATENCY_BOUNDS_MS.length
}

function summarizeLatency(histogram: Float64Array, count: number, sumMs: number): DashboardLatencySummary {
  return {
    count,
    sumMs,
    p50: quantile(histogram, count, sumMs, 0.5),
    p95: quantile(histogram, count, sumMs, 0.95),
  }
}

function quantile(histogram: Float64Array, count: number, sumMs: number, fraction: number): DashboardQuantile | null {
  if (count === 0)
    return null
  if (count === 1)
    return { valueMs: sumMs, kind: 'exact' }

  const rank = Math.ceil(count * fraction)
  let cumulative = 0
  for (let index = 0; index < HISTOGRAM_SIZE; index++) {
    cumulative += histogram[index]
    if (cumulative < rank)
      continue
    if (index === LATENCY_BOUNDS_MS.length)
      return { valueMs: LATENCY_BOUNDS_MS.at(-1)!, kind: 'at-least' }
    return { valueMs: LATENCY_BOUNDS_MS[index], kind: index === 0 ? 'at-most' : 'approximate' }
  }
  return null
}

function bucketCoverage(startMs: number, endMs: number, collectedAtMs: number, current: boolean): DashboardMetricBucket['coverage'] {
  if (endMs <= collectedAtMs)
    return 'not-collected'
  if (startMs < collectedAtMs)
    return 'partial-start'
  if (current)
    return 'open'
  return 'full'
}
