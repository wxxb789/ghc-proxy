/**
 * Dashboard projection and mutations for the M365 route target.
 *
 * The projection reads the manager's committed routing snapshot and the
 * process-local availability registry, so it reports the target even when the
 * dashboard is opened on a GitHub hostname. Broker listing is an explicit
 * probe action rather than part of the read path, which keeps the two-second
 * Live refresh free of helper subprocesses.
 */
import type { AccountManagementSnapshot } from '~/accounts/manager'

import process from 'node:process'

import { listMscAccounts, resolveMscAuthExe } from '~/clients/msc-auth'
import { M365_DEFAULT_HOSTNAME, RESERVED_M365_TARGET } from '~/lib/account-routing'
import { getCachedConfig } from '~/lib/config'
import { getTargetAvailability } from '~/state/account-runtime'

export interface M365Readiness {
  platformSupported: boolean
  helperAvailable: boolean
  accountCount?: number
  accounts?: Array<{ upn: string, homeAccountId: string, environment: string }>
  failedStep?: 'platform' | 'helper' | 'accounts'
  error?: string
}

export interface M365RoutingRow {
  target: string
  hostname: string
  kind: 'github' | 'm365'
  isDefault: boolean
}

export interface M365DashboardState {
  registered: boolean
  hostname?: string
  account?: string
  tokenExpiresAt?: string
  modelCount: number
  models: string[]
  availability?: { status: 'ready' | 'unavailable', cause?: string, updatedAt: number }
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

function routingRows(snapshot: AccountManagementSnapshot): M365RoutingRow[] {
  return snapshot.accounts.map(account => ({
    target: account.name,
    hostname: account.hostname,
    kind: account.runtime.auth.upstream === 'm365' ? 'm365' : 'github',
    isDefault: account.isDefault,
  }))
}

function baseUrlFor(hostname: string, port: number | undefined): string {
  return port === undefined ? `http://${hostname}` : `http://${hostname}:${port}`
}

export function getM365DashboardState(
  options: M365DashboardOptions = {},
): M365DashboardState {
  const manager = options.manager
  if (!manager) {
    return {
      registered: false,
      modelCount: 0,
      models: [],
      routing: [],
      onboarding: {
        status: 'unavailable',
        reason: 'This process was started without account management.',
      },
    }
  }

  const snapshot = manager.getAccountSnapshot()
  const routing = routingRows(snapshot)
  const target = snapshot.accounts.find(account => account.name === RESERVED_M365_TARGET)
  const modelIds = target?.runtime.models.getModelIds() ?? []
  const availability = getTargetAvailability(RESERVED_M365_TARGET)

  if (!target) {
    return {
      registered: false,
      modelCount: 0,
      models: [],
      availability,
      routing,
      onboarding: { status: 'available' },
    }
  }

  return {
    registered: true,
    hostname: target.hostname,
    account: target.runtime.auth.mscAuthAccount ?? getCachedConfig().m365?.account,
    tokenExpiresAt: target.runtime.auth.copilotTokenExpiresAt
      ? new Date(target.runtime.auth.copilotTokenExpiresAt).toISOString()
      : undefined,
    modelCount: modelIds.length,
    models: modelIds,
    availability,
    routing,
    client: {
      baseUrl: baseUrlFor(target.hostname ?? M365_DEFAULT_HOSTNAME, options.serverPort),
      model: modelIds[0] ?? 'claude-opus-5.5',
    },
    onboarding: { status: 'available' },
  }
}

export async function probeM365Readiness(): Promise<M365Readiness> {
  if (process.platform !== 'win32') {
    return { platformSupported: false, helperAvailable: false, failedStep: 'platform' }
  }

  try {
    resolveMscAuthExe()
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
    const accounts = await listMscAccounts()
    return {
      platformSupported: true,
      helperAvailable: true,
      accountCount: accounts.length,
      accounts: accounts.map(account => ({
        upn: account.upn,
        homeAccountId: account.homeAccountId,
        environment: account.environment,
      })),
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
