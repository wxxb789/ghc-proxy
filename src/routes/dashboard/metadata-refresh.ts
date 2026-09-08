import type { DashboardQuota, DashboardQuotaCache } from './handler'
import type { RoutedAccountDescriptor } from '~/accounts/descriptor'

import { cacheModels } from '~/clients/factory'
import { refreshGitHubIdentity } from '~/lib/token'
import { authStore, modelCache, runWithAccountRuntime } from '~/state'

const DEFAULT_METADATA_TIMEOUT_MS = 5_000

export type DashboardMetadataStatus = 'ok' | 'stale' | 'unavailable'

export interface DashboardAccountMetadataRefresh {
  github: { status: DashboardMetadataStatus }
  models: { status: DashboardMetadataStatus }
  name: string
  quota: { status: DashboardQuota['status'] }
}

export interface DashboardMetadataRefresh {
  accounts: DashboardAccountMetadataRefresh[]
  status: 'ok' | 'partial' | 'unavailable'
}

export interface DashboardMetadataRefreshDependencies {
  refreshGitHubIdentity: (signal?: AbortSignal) => Promise<void>
  refreshModels: (signal?: AbortSignal) => Promise<void>
}

export interface DashboardMetadataRefreshService {
  refresh: (
    accounts: RoutedAccountDescriptor[],
    quotaCache: DashboardQuotaCache,
  ) => Promise<DashboardMetadataRefresh>
}

const defaultDependencies: DashboardMetadataRefreshDependencies = {
  refreshGitHubIdentity,
  refreshModels: signal => cacheModels(undefined, { signal }),
}

export class DashboardMetadataRefresher implements DashboardMetadataRefreshService {
  private readonly dependencies: DashboardMetadataRefreshDependencies
  private readonly timeoutMs: number
  private inFlight?: {
    fingerprint: string
    promise: Promise<DashboardMetadataRefresh>
  }

  private pending?: {
    accounts: RoutedAccountDescriptor[]
    fingerprint: string
    quotaCache: DashboardQuotaCache
    reject: (reason?: unknown) => void
    resolve: (value: DashboardMetadataRefresh) => void
    promise: Promise<DashboardMetadataRefresh>
  }

  constructor(
    dependencyOverrides: Partial<DashboardMetadataRefreshDependencies> = {},
    timeoutMs = DEFAULT_METADATA_TIMEOUT_MS,
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencyOverrides }
    this.timeoutMs = timeoutMs
  }

  refresh(
    accounts: RoutedAccountDescriptor[],
    quotaCache: DashboardQuotaCache,
  ): Promise<DashboardMetadataRefresh> {
    const fingerprint = accountFingerprint(accounts)
    if (this.inFlight?.fingerprint === fingerprint)
      return this.inFlight.promise
    if (this.pending) {
      this.pending.accounts = accounts
      this.pending.fingerprint = fingerprint
      this.pending.quotaCache = quotaCache
      return this.pending.promise
    }
    if (this.inFlight) {
      const pending = Promise.withResolvers<DashboardMetadataRefresh>()
      this.pending = { accounts, fingerprint, quotaCache, ...pending }
      return pending.promise
    }

    return this.startRefresh(accounts, quotaCache, fingerprint)
  }

  private startRefresh(
    accounts: RoutedAccountDescriptor[],
    quotaCache: DashboardQuotaCache,
    fingerprint: string,
  ): Promise<DashboardMetadataRefresh> {
    const refresh = Promise.all(
      accounts.map(account => this.refreshAccount(account, quotaCache)),
    ).then((refreshedAccounts): DashboardMetadataRefresh => {
      const statuses = refreshedAccounts.flatMap(account => [
        account.github.status,
        account.models.status,
        account.quota.status,
      ])
      return {
        accounts: refreshedAccounts,
        status: statuses.every(status => status === 'ok')
          ? 'ok'
          : statuses.some(status => status === 'ok' || status === 'stale')
            ? 'partial'
            : 'unavailable',
      }
    })
    this.inFlight = { fingerprint, promise: refresh }
    void refresh.then(
      () => this.startPendingRefresh(refresh),
      () => this.startPendingRefresh(refresh),
    )
    return refresh
  }

  private startPendingRefresh(completed: Promise<DashboardMetadataRefresh>): void {
    if (this.inFlight?.promise !== completed)
      return
    this.inFlight = undefined
    const pending = this.pending
    this.pending = undefined
    if (!pending)
      return
    this.startRefresh(pending.accounts, pending.quotaCache, pending.fingerprint)
      .then(pending.resolve, pending.reject)
  }

  private async refreshAccount(
    account: RoutedAccountDescriptor,
    quotaCache: DashboardQuotaCache,
  ): Promise<DashboardAccountMetadataRefresh> {
    return runWithAccountRuntime(account.runtime, async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => {
        controller.abort(new DOMException('Dashboard metadata refresh timed out.', 'TimeoutError'))
      }, this.timeoutMs)
      const [github, quota, models] = await Promise.allSettled([
        this.dependencies.refreshGitHubIdentity(controller.signal),
        quotaCache.refresh(),
        this.dependencies.refreshModels(controller.signal),
      ]).finally(() => {
        clearTimeout(timeout)
      })
      return {
        name: account.name,
        github: { status: refreshStatus(github, authStore.githubValidatedAt !== undefined) },
        models: { status: refreshStatus(models, modelCache.getModels() !== undefined) },
        quota: {
          status: quota.status === 'fulfilled'
            ? quota.value.status
            : 'unavailable',
        },
      }
    })
  }
}

export const dashboardMetadataRefresher = new DashboardMetadataRefresher()

function refreshStatus(
  result: PromiseSettledResult<unknown>,
  hasPreviousValue: boolean,
): DashboardMetadataStatus {
  if (result.status === 'fulfilled')
    return 'ok'
  return hasPreviousValue ? 'stale' : 'unavailable'
}

function accountFingerprint(accounts: RoutedAccountDescriptor[]): string {
  return accounts
    .map(account => `${account.name}\u0000${account.hostname}`)
    .sort()
    .join('\u0001')
}
