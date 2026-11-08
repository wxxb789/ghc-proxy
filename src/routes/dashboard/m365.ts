/**
 * Dashboard projection and mutations for the M365 route target.
 *
 * The projection reads the manager's committed routing snapshot and the
 * process-local availability registry, so it reports the target even when the
 * dashboard is opened on a GitHub hostname. Broker listing is an explicit
 * probe action rather than part of the read path, which keeps the two-second
 * Live refresh free of helper subprocesses.
 */
import type { RoutedAccountDescriptor } from '~/accounts/descriptor'
import type { AccountManagementSnapshot } from '~/accounts/manager'
import type { MscAccount } from '~/clients/msc-auth'
import type { TargetKind } from '~/lib/account-routing'
import type { TargetAvailability } from '~/state/account-runtime'

import process from 'node:process'

import { listMscAccounts, resolveMscAuthExe } from '~/clients/msc-auth'
import { RESERVED_M365_TARGET } from '~/lib/account-routing'
import { getCachedConfig } from '~/lib/config'
import { M365_BUILTIN_ENDPOINTS, M365_DEFAULT_ENDPOINT } from '~/lib/m365-endpoints'
import { getRoutingTargets, getTargetAvailability } from '~/state/account-runtime'

export interface M365Readiness {
  platformSupported: boolean
  helperAvailable: boolean
  accountCount?: number
  accounts?: MscAccount[]
  failedStep?: 'platform' | 'helper' | 'accounts'
  error?: string
}

export interface M365RoutingRow {
  target: string
  hostname: string
  kind: TargetKind
  isDefault: boolean
}

export interface M365DashboardState {
  registered: boolean
  endpoint: string
  endpoints: string[]
  hostname?: string
  account?: string
  username?: string
  tenant?: string
  tokenExpiresAt?: string
  modelCount: number
  models: string[]
  availability?: TargetAvailability
  routing: M365RoutingRow[]
  client?: { baseUrl: string, model: string }
  onboarding: { status: 'available' | 'unavailable', reason?: string }
}

export interface M365AccountSnapshotSource {
  getAccountSnapshot: () => AccountManagementSnapshot
}

export interface M365DashboardOptions {
  manager?: M365AccountSnapshotSource
  serverPort?: number
}

function routingRows(targets: readonly RoutedAccountDescriptor[]): M365RoutingRow[] {
  return targets.map(account => ({
    target: account.name,
    hostname: account.hostname,
    kind: account.runtime.auth.upstream === 'm365' ? 'm365' : 'github',
    isDefault: account.isDefault,
  }))
}

function baseUrlFor(hostname: string, port: number | undefined): string {
  return port === undefined ? `http://${hostname}` : `http://${hostname}:${port}`
}

function endpointSettings(endpoint = getCachedConfig().m365?.endpoint ?? M365_DEFAULT_ENDPOINT) {
  return {
    endpoint,
    endpoints: [...new Set([
      ...M365_BUILTIN_ENDPOINTS,
      ...getCachedConfig().m365?.endpoints ?? [],
      endpoint,
    ])],
  }
}

export function getM365DashboardState(
  options: M365DashboardOptions = {},
): M365DashboardState {
  const manager = options.manager
  const onboarding: M365DashboardState['onboarding'] = manager
    ? { status: 'available' }
    : {
        status: 'unavailable',
        reason: 'This process was started without account management.',
      }

  // The manager's snapshot is the committed table when one exists; otherwise
  // the process-wide routing table is.
  const targets = manager ? manager.getAccountSnapshot().accounts : getRoutingTargets()
  const routing = routingRows(targets)
  const target = targets.find(account => account.name === RESERVED_M365_TARGET)

  if (!target) {
    return {
      registered: false,
      ...endpointSettings(),
      modelCount: 0,
      models: [],
      routing,
      onboarding,
    }
  }

  const modelIds = target.runtime.models.getModelIds()
  return {
    registered: true,
    ...endpointSettings(target.runtime.auth.m365Endpoint),
    hostname: target.hostname,
    account: target.runtime.auth.mscAuthAccount ?? getCachedConfig().m365?.account,
    username: target.runtime.auth.mscAuthUsername ?? target.runtime.auth.mscAuthUpn,
    tenant: target.runtime.auth.mscAuthTenant,
    tokenExpiresAt: target.runtime.auth.copilotTokenExpiresAt
      ? new Date(target.runtime.auth.copilotTokenExpiresAt).toISOString()
      : undefined,
    modelCount: modelIds.length,
    models: modelIds,
    availability: getTargetAvailability(target.runtime),
    routing,
    client: {
      baseUrl: baseUrlFor(target.hostname, options.serverPort),
      model: modelIds[0] ?? 'claude-opus-5.5',
    },
    onboarding,
  }
}

export async function probeM365Readiness(exe?: string): Promise<M365Readiness> {
  if (process.platform !== 'win32') {
    return { platformSupported: false, helperAvailable: false, failedStep: 'platform' }
  }

  try {
    resolveMscAuthExe(exe)
  }
  catch (error) {
    return {
      platformSupported: true,
      helperAvailable: false,
      failedStep: 'helper',
      error: (error as Error).message.slice(0, 400),
    }
  }

  try {
    const accounts = await listMscAccounts({ exe })
    return {
      platformSupported: true,
      helperAvailable: true,
      accountCount: accounts.length,
      accounts,
    }
  }
  catch (error) {
    return {
      platformSupported: true,
      helperAvailable: true,
      failedStep: 'accounts',
      error: (error as Error).message.slice(0, 400),
    }
  }
}
