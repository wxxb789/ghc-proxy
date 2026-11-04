import type { AccountRuntime } from '~/state/account-runtime'
import type { CopilotUsageResponse, QuotaDetail } from '~/types'
import type { DashboardQuota, DashboardQuotaDetail } from '~/types/dashboard'

import { handleUsageCore } from '~/routes/usage/handler'
import { getCurrentAccountRuntime } from '~/state/account-runtime'

const DEFAULT_QUOTA_TTL_MS = 60_000
const DEFAULT_QUOTA_TIMEOUT_MS = 5_000

export class DashboardQuotaCache {
  private cached = new WeakMap<AccountRuntime, { expiresAt: number, value: DashboardQuota }>()
  private inFlight = new WeakMap<AccountRuntime, Promise<DashboardQuota>>()
  private readonly load: (signal?: AbortSignal) => Promise<CopilotUsageResponse>
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly timeoutMs: number

  constructor(
    load: (signal?: AbortSignal) => Promise<CopilotUsageResponse> = handleUsageCore,
    now: () => number = Date.now,
    ttlMs = DEFAULT_QUOTA_TTL_MS,
    timeoutMs = DEFAULT_QUOTA_TIMEOUT_MS,
  ) {
    this.load = load
    this.now = now
    this.ttlMs = ttlMs
    this.timeoutMs = timeoutMs
  }

  get(): Promise<DashboardQuota> {
    return this.loadQuota(false)
  }

  refresh(): Promise<DashboardQuota> {
    return this.loadQuota(true)
  }

  private loadQuota(force: boolean): Promise<DashboardQuota> {
    const account = getCurrentAccountRuntime()
    const cache = this.cached
    const inFlightLoads = this.inFlight
    const now = this.now()
    const cached = cache.get(account)
    if (!force && cached && now < cached.expiresAt)
      return Promise.resolve(cached.value)
    const inFlight = inFlightLoads.get(account)
    if (inFlight)
      return inFlight

    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new DOMException('Dashboard quota request timed out.', 'TimeoutError')
        controller.abort(error)
        reject(error)
      }, this.timeoutMs)
    })

    const load = Promise.race([this.load(controller.signal), timeoutPromise])
      .then((usage) => {
        const fetchedAt = this.now()
        const value = projectQuota(usage, fetchedAt)
        cache.set(account, { expiresAt: fetchedAt + this.ttlMs, value })
        return value
      })
      .catch(() => {
        const lastValue = cache.get(account)
        const value: DashboardQuota = lastValue
          ? { ...lastValue.value, status: 'stale' }
          : { status: 'unavailable' }
        cache.set(account, {
          expiresAt: this.now() + this.ttlMs,
          value,
        })
        return value
      })
      .finally(() => {
        if (timeout !== undefined)
          clearTimeout(timeout)
        inFlightLoads.delete(account)
      })
    inFlightLoads.set(account, load)
    return load
  }

  reset(): void {
    this.cached = new WeakMap()
    this.inFlight = new WeakMap()
  }
}

export const dashboardQuotaCache = new DashboardQuotaCache()

function projectQuota(usage: CopilotUsageResponse, fetchedAt: number): DashboardQuota {
  return {
    status: 'ok',
    fetchedAt: new Date(fetchedAt).toISOString(),
    plan: usage.copilot_plan,
    resetDate: usage.quota_reset_date,
    chat: projectQuotaDetail(usage.quota_snapshots.chat),
    completions: projectQuotaDetail(usage.quota_snapshots.completions),
    premiumInteractions: projectQuotaDetail(usage.quota_snapshots.premium_interactions),
  }
}

function projectQuotaDetail(quota: QuotaDetail): DashboardQuotaDetail {
  return {
    entitlement: quota.entitlement,
    remaining: quota.remaining,
    percentRemaining: quota.percent_remaining,
    unlimited: quota.unlimited,
    overagePermitted: quota.overage_permitted,
  }
}
