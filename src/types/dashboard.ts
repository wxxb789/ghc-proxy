export const DASHBOARD_PAGES = [
  'overview',
  'traffic',
  'requests',
  'targets',
  'models',
  'behavior',
] as const

export type DashboardPage = typeof DASHBOARD_PAGES[number]

export const DASHBOARD_WINDOWS = {
  '15m': { durationMs: 900_000, bucketMs: 10_000, slots: 90 },
  '1h': { durationMs: 3_600_000, bucketMs: 60_000, slots: 60 },
  '24h': { durationMs: 86_400_000, bucketMs: 900_000, slots: 96 },
} as const

export type DashboardWindowId = keyof typeof DASHBOARD_WINDOWS

export const LATENCY_BOUNDS_MS = [
  50,
  63,
  80,
  100,
  125,
  160,
  200,
  250,
  315,
  400,
  500,
  630,
  800,
  1000,
  1250,
  1600,
  2000,
  2500,
  3150,
  4000,
  5000,
  6300,
  8000,
  10000,
  12500,
  16000,
  20000,
  25000,
  31500,
  40000,
  50000,
  63000,
  80000,
  100000,
  125000,
  160000,
  200000,
  250000,
  315000,
  400000,
  500000,
  630000,
  800000,
  1000000,
  1250000,
  1600000,
  2000000,
] as const

export type DashboardTerminalState = 'completed' | 'failed' | 'aborted'

export interface DashboardStateCounts {
  completed: number
  failed: number
  aborted: number
}

export interface DashboardQuantile {
  valueMs: number
  kind: 'exact' | 'approximate' | 'at-most' | 'at-least'
}

export interface DashboardLatencySummary {
  count: number
  sumMs: number
  p50: DashboardQuantile | null
  p95: DashboardQuantile | null
}

export interface DashboardBreakdown {
  kind: 'named' | 'other' | 'none'
  value?: string
  requests: number
  failures: number
}

export interface DashboardMetricBucket {
  startMs: number
  endMs: number
  coverage: 'not-collected' | 'partial-start' | 'open' | 'full'
  counts: DashboardStateCounts
  latency: DashboardLatencySummary
  effects: Record<string, number>
}

export interface DashboardMetrics {
  window: DashboardWindowId
  bucketMs: number
  collectionStartedAt: string
  startMs: number
  endMs: number
  coveredMs: number
  counts: DashboardStateCounts
  latency: DashboardLatencySummary & { histogram: number[] }
  latencyBoundsMs: readonly number[]
  series: DashboardMetricBucket[]
  byModel: DashboardBreakdown[]
  byTarget: DashboardBreakdown[]
  byEndpoint: DashboardBreakdown[]
  effects: Record<string, number>
}

export interface DashboardEnvelope {
  schemaVersion: 1
  generatedAt: string
  startedAt: string
}
