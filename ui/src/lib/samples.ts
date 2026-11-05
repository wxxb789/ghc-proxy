import type { OverviewResponse } from '@contract'

/** One successful overview poll, flattened. `gap` marks a break from the previous sample. */
export interface Sample {
  t: number
  gap: boolean
  active: number
  qActive: number
  qPending: number
  qConcurrency: number
  maxPending: number
  started: number
  completed: number
  failed: number
  aborted: number
  /** Finite and not unlimited only. */
  premiumRemaining?: number
  uptimeMs: number
  startedAt: string
}

export type SampleKey = Exclude<keyof Sample, 'gap' | 'startedAt' | 'premiumRemaining' | 't'>
type Read = (sample: Sample) => number

/** 180 samples = 6 min at the 2 s Live interval. */
export const SAMPLE_CAPACITY = 180
export const SAMPLE_WINDOW_MS = 360_000
/** Consecutive samples further apart than this are not contiguous (Live off, tab hidden, failed polls). */
export const GAP_MS = 6000

export function sampleFrom(overview: OverviewResponse, t: number): Omit<Sample, 'gap'> {
  const { activity } = overview
  const queue = activity.upstreamQueue
  const premium = overview.quota.premiumInteractions
  return {
    t,
    active: activity.activeRequests,
    qActive: queue.active,
    qPending: queue.pending,
    qConcurrency: queue.concurrency,
    maxPending: queue.maxPending,
    started: activity.started,
    completed: activity.completed,
    failed: activity.failed,
    aborted: activity.aborted,
    premiumRemaining: premium && !premium.unlimited && Number.isFinite(premium.remaining) ? premium.remaining : undefined,
    uptimeMs: overview.uptimeMs,
    startedAt: overview.startedAt,
  }
}

/** Appends a sample (flagging a gap when needed) and keeps the newest `SAMPLE_CAPACITY`. */
export function pushSample(list: readonly Sample[], sample: Omit<Sample, 'gap'>): Sample[] {
  const previous = list.at(-1)
  const next = [...list, { ...sample, gap: !!previous && sample.t - previous.t > GAP_MS }]
  return next.length > SAMPLE_CAPACITY ? next.slice(-SAMPLE_CAPACITY) : next
}

/** A lower uptime or a changed start time means the proxy restarted. */
export function isRestart(previous: Pick<Sample, 'uptimeMs' | 'startedAt'>, next: Pick<Sample, 'uptimeMs' | 'startedAt'>): boolean {
  return next.uptimeMs < previous.uptimeMs || next.startedAt !== previous.startedAt
}

const reader = (key: SampleKey | Read): Read => typeof key === 'function' ? key : sample => sample[key]

/** Calls `visit(previous, current)` for every contiguous pair whose earlier sample is at or after `since`. */
function eachPair(list: readonly Sample[], since: number, visit: (previous: Sample, current: Sample) => void): void {
  for (let index = 1; index < list.length; index++) {
    const previous = list[index - 1]!
    const current = list[index]!
    if (!current.gap && previous.t >= since)
      visit(previous, current)
  }
}

/** Sum of consecutive differences, clamped to ≥ 0 and skipped across gaps. */
export function sumDelta(list: readonly Sample[], key: SampleKey | Read, since = -Infinity): number {
  const read = reader(key)
  let sum = 0
  eachPair(list, since, (previous, current) => {
    sum += Math.max(0, read(current) - read(previous))
  })
  return sum
}

/** `count` buckets of `size` ms ending at `now`; each holds the deltas of the samples that fall in it. */
export function buckets(list: readonly Sample[], key: SampleKey | Read, now: number, count = 36, size = 10_000): number[] {
  const read = reader(key)
  const result = Array.from<number>({ length: count }).fill(0)
  eachPair(list, -Infinity, (previous, current) => {
    const index = count - 1 - Math.floor((now - current.t) / size)
    if (index >= 0 && index < count)
      result[index]! += Math.max(0, read(current) - read(previous))
  })
  return result
}

/** Finished requests per minute over the last 60 s; `null` until 10 s of contiguous samples exist. */
export function throughput(list: readonly Sample[], now: number): number | null {
  let finished = 0
  let elapsed = 0
  eachPair(list, now - 60_000, (previous, current) => {
    finished += Math.max(0, current.completed + current.aborted - previous.completed - previous.aborted)
    elapsed += current.t - previous.t
  })
  return elapsed < 10_000 ? null : finished / (elapsed / 60_000)
}

/** Δfailed ÷ Δcompleted over the whole buffer, in percent; `null` when nothing completed. */
export function failureRate(list: readonly Sample[]): number | null {
  const completed = sumDelta(list, 'completed')
  return completed === 0 ? null : (sumDelta(list, 'failed') / completed) * 100
}

/** Premium requests consumed across the buffer; `null` unless positive. */
export function premiumUsed(list: readonly Sample[]): number | null {
  const known = list.filter(sample => sample.premiumRemaining !== undefined)
  if (known.length < 2)
    return null
  const used = known[0]!.premiumRemaining! - known.at(-1)!.premiumRemaining!
  return used > 0 ? used : null
}

export function peak(list: readonly Sample[], key: SampleKey): number | null {
  return list.length ? Math.max(...list.map(sample => sample[key])) : null
}

/** Growth since page open (or the last restart), clamped to ≥ 0. */
export function sinceOpen(first: Sample | null, latest: Sample | undefined, key: SampleKey): number | null {
  return first && latest ? Math.max(0, latest[key] - first[key]) : null
}

/** Whole minutes spanned by the buffer. */
export function windowMinutes(list: readonly Sample[]): number {
  return list.length < 2 ? 0 : Math.round((list.at(-1)!.t - list[0]!.t) / 60_000)
}

/** Contiguous runs of `[x, value]` points; x maps the last `windowMs` before `now` onto 0–180. */
export function sparkRuns(list: readonly Sample[], key: SampleKey | Read, now: number, windowMs = SAMPLE_WINDOW_MS): Array<Array<[number, number]>> {
  const read = reader(key)
  const start = now - windowMs
  const runs: Array<Array<[number, number]>> = []
  let run: Array<[number, number]> | undefined
  for (const sample of list) {
    if (sample.t < start)
      continue
    if (!run || sample.gap)
      runs.push(run = [])
    run.push([((sample.t - start) / windowMs) * 180, read(sample)])
  }
  return runs
}
