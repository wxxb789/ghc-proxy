import type { DashboardQuotaCache } from './quota'
import type { DashboardRouteOptions } from './types'
import type { AccountManagementSnapshot } from '~/accounts/manager'
import type { AccountRuntime } from '~/state/account-runtime'
import type { DashboardTarget, DashboardTargetQuota, DashboardTargets } from '~/types/dashboard'

import { getUpstreamRequestQueueSnapshot } from '~/clients/factory'
import { authStore, getCurrentAccountName, modelCache, runWithAccountRuntime } from '~/state'
import { getCurrentAccountRuntime, getRoutingState, getRoutingTargets, getTargetAvailability } from '~/state/account-runtime'
import { dashboardQuotaCache } from './quota'

const runtimeIds = new WeakMap<AccountRuntime, string>()
let nextRuntimeId = 1

export function getDashboardTargets(options: DashboardRouteOptions, request: Request): DashboardTargets {
  const snapshot = readTargetSnapshot(options, request)
  const manager = options.accountManager
  const canManage = Boolean(manager && snapshot.routing.routingEnabled)
  const url = new URL(request.url)
  const port = options.serverPort || url.port
  return {
    hostTarget: getCurrentAccountName(),
    routing: snapshot.routing,
    capabilities: {
      canAddAccount: canManage,
      canBootstrap: Boolean(manager && !snapshot.routing.routingEnabled),
      canManageM365: Boolean(manager),
      canRefreshMetadata: canManage,
      ...(!canManage
        ? { refreshUnavailableReason: manager ? 'Enable named-account routing to refresh metadata.' : 'This process was started without account management.' }
        : {}),
    },
    targets: snapshot.accounts.map(account => runWithAccountRuntime(account.runtime, () => {
      const baseUrl = `${url.protocol}//${account.hostname}${port ? `:${port}` : ''}`
      return {
        runtimeId: runtimeId(account.runtime),
        name: account.name,
        hostname: account.hostname,
        isDefault: account.isDefault,
        kind: authStore.upstream,
        identity: authStore.upstream === 'm365' ? authStore.mscAuthUsername ?? authStore.mscAuthUpn : authStore.githubLogin,
        tenant: authStore.upstream === 'm365' ? authStore.mscAuthTenant || 'Microsoft 365' : authStore.gheDomain ?? 'github.com',
        health: getTargetHealth(),
        queue: getUpstreamRequestQueueSnapshot(),
        actions: {
          canSetDefault: canManage && !account.isDefault,
          canRemove: canManage && !account.isDefault && snapshot.accounts.length > 1,
        },
        client: {
          openAIBaseUrl: `${baseUrl}/v1`,
          anthropicBaseUrl: baseUrl,
          model: modelCache.getModels()?.data[0]?.id,
        },
      }
    })),
  }
}

export async function getDashboardTargetQuota(
  targetName: string,
  options: DashboardRouteOptions,
  request: Request,
  quotaCache: DashboardQuotaCache = dashboardQuotaCache,
): Promise<DashboardTargetQuota | undefined> {
  const target = readTargetSnapshot(options, request).accounts.find(account => account.name === targetName)
  if (!target)
    return undefined
  return runWithAccountRuntime(target.runtime, async () => ({
    target: target.name,
    runtimeId: runtimeId(target.runtime),
    quota: authStore.upstream === 'm365'
      ? { status: 'not_applicable' }
      : authStore.githubToken ? await quotaCache.get() : { status: 'unavailable' },
  }))
}

function getTargetHealth(): DashboardTarget['health'] {
  const modelsLoaded = modelCache.getModels() !== undefined
  const isM365 = authStore.upstream === 'm365'
  const githubConfigured = Boolean(authStore.githubToken)
  const copilotConfigured = Boolean(authStore.copilotToken)
  const copilotExpired = authStore.copilotTokenExpiresAt !== undefined
    && authStore.copilotTokenExpiresAt <= Date.now()
  const copilotHealthy = copilotConfigured
    && modelsLoaded
    && !copilotExpired
    && authStore.copilotTokenLastRefreshSucceeded !== false
    && (!isM365 || getTargetAvailability(getCurrentAccountRuntime())?.status !== 'unavailable')

  return {
    status: copilotHealthy ? 'ok' : 'degraded',
    github: {
      status: isM365
        ? 'not_applicable'
        : githubConfigured
          ? authStore.githubValidatedAt ? 'ok' : 'unknown'
          : 'missing',
      login: authStore.githubLogin,
      lastValidatedAt: toIso(authStore.githubValidatedAt),
      accountType: authStore.accountType,
    },
    copilot: {
      status: copilotConfigured
        ? copilotHealthy ? 'ok' : 'degraded'
        : 'missing',
      modelsLoaded,
      expiresAt: toIso(authStore.copilotTokenExpiresAt),
      lastRefreshAt: toIso(authStore.copilotTokenLastRefreshAt),
      lastRefreshSucceeded: authStore.copilotTokenLastRefreshSucceeded,
    },
  }
}

function readTargetSnapshot(options: DashboardRouteOptions, request: Request): AccountManagementSnapshot {
  if (options.accountManager)
    return options.accountManager.getAccountSnapshot()
  const state = getRoutingState()
  const baseHostname = state.baseHostname ?? new URL(request.url).hostname
  const committed = getRoutingTargets()
  const current = getCurrentAccountRuntime()
  return {
    routing: { ...state, baseHostname },
    accounts: committed.length > 0 ? committed : [{ name: current.name, hostname: baseHostname, runtime: current, isDefault: true }],
  }
}

function runtimeId(runtime: AccountRuntime): string {
  let id = runtimeIds.get(runtime)
  if (id === undefined) {
    id = `target-${nextRuntimeId++}`
    runtimeIds.set(runtime, id)
  }
  return id
}

function toIso(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined)
    return undefined
  const value = new Date(timestamp)
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
}
