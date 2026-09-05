import type {
  AccountDeviceAuthorization,
  AuthenticatedAccount,
} from './device-auth'
import type { AccountManagementTransactionPaths } from '~/lib/account-management-transaction'
import type {
  AccountRoutingConfig,
  CompiledAccountRouting,
} from '~/lib/account-routing'
import type { CredentialPaths } from '~/lib/credentials'
import type { DashboardAccountDescriptor } from '~/routes/dashboard/handler'
import type { AccountRuntime } from '~/state'
import type { AuthStore } from '~/state/auth'

import { randomUUID } from 'node:crypto'

import { normalizeGheDomain } from '~/clients/ghe-domain'
import {
  beginAccountManagementTransaction,
  commitAccountManagementTransaction,
  rollbackAccountManagementTransaction,
} from '~/lib/account-management-transaction'
import {
  compileAccountRouting,
  normalizeAccountName,
  normalizeDnsHostname,
} from '~/lib/account-routing'
import { readConfig, writeConfigField } from '~/lib/config'
import { writeNewGitHubCredential } from '~/lib/credentials'
import { PATHS } from '~/lib/paths'
import { getDashboardAccount } from '~/routes/dashboard/handler'
import { configureAccountRuntimes } from '~/state'
import {
  beginAccountDeviceAuthentication,
} from './device-auth'

export interface AddAccountInput {
  accountName: string
  gheDomain?: string
  hostname: string
}

export class AccountManagementError extends Error {
  readonly status: number

  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AccountManagementError'
    this.status = status
  }
}

interface PersistAccountInput extends AddAccountInput {
  githubToken: string
  routing: AccountRoutingConfig
}

export interface AccountManagerPersistence {
  addAccount: (
    input: PersistAccountInput,
    applyRuntime: () => void,
  ) => Promise<void>
  setDefault: (
    routing: AccountRoutingConfig,
    applyRuntime: () => void,
  ) => Promise<void>
}

export interface AccountManagerDependencies {
  beginAuthentication: typeof beginAccountDeviceAuthentication
  createSessionId: () => string
  persistence: AccountManagerPersistence
  projectAccount: (
    descriptor: DashboardAccountDescriptor,
  ) => ReturnType<typeof getDashboardAccount>
}

export interface AccountManagerState {
  authDefaults?: Partial<AuthStore>
  knownAccountNames?: Iterable<string>
  refreshCleanups?: ReadonlyMap<string, () => void>
  routing: CompiledAccountRouting
  runtimes: Iterable<AccountRuntime>
}

export interface AccountAuthenticationSession {
  accountName: string
  authorization: AccountDeviceAuthorization
  hostname: string
  id: string
  message?: string
  state: 'pending' | 'succeeded' | 'failed'
}

interface InternalAuthenticationSession extends AccountAuthenticationSession {
  abortController: AbortController
  settled: Promise<AccountAuthenticationSession>
}

export interface AccountManagerPaths
  extends AccountManagementTransactionPaths, CredentialPaths {}

export function createAccountManagerPersistence(
  paths: AccountManagerPaths = PATHS,
): AccountManagerPersistence {
  return {
    addAccount: async (input, applyRuntime) => {
      await runPersistedAccountMutation(paths, async () => {
        await writeNewGitHubCredential(
          input.githubToken,
          input.gheDomain,
          paths,
          input.accountName,
        )
        await writeConfigField('accountRouting', input.routing, {
          configPath: paths.CONFIG_PATH,
          failOnReadError: true,
        })
        applyRuntime()
      })
    },
    setDefault: async (routing, applyRuntime) => {
      await runPersistedAccountMutation(paths, async () => {
        await writeConfigField('accountRouting', routing, {
          configPath: paths.CONFIG_PATH,
          failOnReadError: true,
        })
        applyRuntime()
      })
    },
  }
}

const defaultDependencies: AccountManagerDependencies = {
  beginAuthentication: beginAccountDeviceAuthentication,
  createSessionId: randomUUID,
  persistence: createAccountManagerPersistence(),
  projectAccount: getDashboardAccount,
}

export class AccountManager {
  private readonly authDefaults: Partial<AuthStore>
  private readonly dependencies: AccountManagerDependencies
  private readonly knownAccountNames: Set<string>
  private readonly refreshCleanups = new Map<string, () => void>()
  private readonly reservedAccountNames = new Set<string>()
  private readonly reservedHostnames = new Set<string>()
  private readonly sessions = new Map<string, InternalAuthenticationSession>()
  private mutationTail: Promise<void> = Promise.resolve()
  private routing: CompiledAccountRouting
  private runtimes: Map<string, AccountRuntime>
  private stopped = false

  constructor(
    state: AccountManagerState,
    dependencyOverrides: Partial<AccountManagerDependencies> = {},
  ) {
    this.authDefaults = { ...state.authDefaults, showToken: false }
    this.dependencies = { ...defaultDependencies, ...dependencyOverrides }
    this.routing = cloneCompiledRouting(state.routing)
    this.runtimes = new Map(
      Array.from(state.runtimes, runtime => [runtime.name, runtime] as const),
    )
    this.knownAccountNames = new Set(
      state.knownAccountNames ?? this.runtimes.keys(),
    )
    for (const [name, cleanup] of state.refreshCleanups ?? []) {
      this.refreshCleanups.set(name, cleanup)
    }
    this.assertManagedRoutingInvariant()
  }

  async listAccounts() {
    const hostnames = dedicatedHostnamesByAccount(this.routing)
    const descriptors = Array.from(this.runtimes.values(), runtime => ({
      name: runtime.name,
      hostname: hostnames.get(runtime.name)!,
      isDefault: runtime.name === this.routing.defaultAccount,
      runtime,
    })).sort((left, right) => left.name.localeCompare(right.name))
    return Promise.all(descriptors.map(this.dependencies.projectAccount))
  }

  getRoutingSummary(): { baseHostname: string, defaultAccount: string } {
    return {
      baseHostname: this.routing.baseHostname,
      defaultAccount: this.routing.defaultAccount,
    }
  }

  async beginAddAccount(input: AddAccountInput): Promise<AccountAuthenticationSession> {
    if (this.stopped) {
      throw new AccountManagementError('Account management is shutting down.', 503)
    }
    const accountName = parseAccountName(input.accountName)
    const hostname = parseHostname(input.hostname)
    const gheDomain = parseGheDomain(input.gheDomain)
    if (hostname === this.routing.baseHostname) {
      throw new AccountManagementError(
        'A dedicated account hostname must differ from the base hostname.',
        400,
      )
    }
    if (this.knownAccountNames.has(accountName) || this.reservedAccountNames.has(accountName)) {
      throw new AccountManagementError(
        `Account ${JSON.stringify(accountName)} already exists or is being authenticated.`,
        409,
      )
    }
    if (this.routing.hostnames.has(hostname) || this.reservedHostnames.has(hostname)) {
      throw new AccountManagementError(
        `Hostname ${JSON.stringify(hostname)} is already configured or reserved.`,
        409,
      )
    }

    this.reservedAccountNames.add(accountName)
    this.reservedHostnames.add(hostname)
    const abortController = new AbortController()
    let flow: Awaited<ReturnType<typeof beginAccountDeviceAuthentication>>
    try {
      flow = await this.dependencies.beginAuthentication({
        accountName,
        authDefaults: this.authDefaults,
        gheDomain,
        signal: abortController.signal,
      })
    }
    catch (error) {
      this.releaseReservation(accountName, hostname)
      throw new AccountManagementError(
        'Could not start account authentication.',
        502,
        { cause: error },
      )
    }

    const session: InternalAuthenticationSession = {
      id: this.dependencies.createSessionId(),
      state: 'pending',
      accountName,
      hostname,
      authorization: flow.authorization,
      abortController,
      settled: Promise.resolve(undefined as never),
    }
    session.settled = this.completeAuthenticationSession(
      session,
      flow.completion,
      gheDomain,
    )
    this.sessions.set(session.id, session)
    return publicSession(session)
  }

  getAuthenticationSession(id: string): AccountAuthenticationSession | undefined {
    const session = this.sessions.get(id)
    return session ? publicSession(session) : undefined
  }

  async waitForAuthentication(id: string): Promise<AccountAuthenticationSession> {
    const session = this.sessions.get(id)
    if (!session) {
      throw new AccountManagementError('Account authentication session was not found.', 404)
    }
    return session.settled
  }

  async setDefaultAccount(rawAccountName: string): Promise<void> {
    if (this.stopped) {
      throw new AccountManagementError('Account management is shutting down.', 503)
    }
    const accountName = parseAccountName(rawAccountName)
    await this.runMutation(async () => {
      if (this.stopped) {
        throw new AccountManagementError('Account management is shutting down.', 503)
      }
      if (!this.runtimes.has(accountName)) {
        throw new AccountManagementError(
          `Account ${JSON.stringify(accountName)} does not exist.`,
          404,
        )
      }
      if (accountName === this.routing.defaultAccount) {
        return
      }

      const previousRouting = this.routing
      const nextConfig = routingConfig({
        ...this.routing,
        defaultAccount: accountName,
      })
      const nextRouting = compileAccountRouting(nextConfig, this.runtimes.keys())
      let runtimeApplied = false
      try {
        await this.dependencies.persistence.setDefault(nextConfig, () => {
          configureAccountRuntimes(nextRouting, this.runtimes.values())
          runtimeApplied = true
        })
        this.routing = nextRouting
      }
      catch (error) {
        if (runtimeApplied) {
          configureAccountRuntimes(previousRouting, this.runtimes.values())
        }
        if (error instanceof AccountManagementError) {
          throw error
        }
        throw new AccountManagementError(
          'Could not switch the default account.',
          500,
          { cause: error },
        )
      }
    })
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return
    }
    this.stopped = true
    for (const session of this.sessions.values()) {
      if (session.state === 'pending') {
        session.abortController.abort(new DOMException('Server stopped', 'AbortError'))
      }
    }
    await Promise.allSettled(
      Array.from(this.sessions.values(), session => session.settled),
    )
    await this.mutationTail
    for (const cleanup of this.refreshCleanups.values()) {
      cleanup()
    }
    this.refreshCleanups.clear()
  }

  private async completeAuthenticationSession(
    session: InternalAuthenticationSession,
    completion: Promise<AuthenticatedAccount>,
    gheDomain: string | undefined,
  ): Promise<AccountAuthenticationSession> {
    try {
      const authenticated = await completion
      if (this.stopped) {
        authenticated.stopRefresh()
        throw new AccountManagementError('Account management is shutting down.', 503)
      }
      await this.runMutation(async () => {
        if (this.stopped) {
          authenticated.stopRefresh()
          throw new AccountManagementError('Account management is shutting down.', 503)
        }
        const nextRuntimes = new Map(this.runtimes)
        nextRuntimes.set(session.accountName, authenticated.runtime)
        const nextConfig = routingConfig(this.routing)
        nextConfig.hostnames[session.hostname] = session.accountName
        const nextRouting = compileAccountRouting(nextConfig, nextRuntimes.keys())
        const previousRouting = this.routing
        let runtimeApplied = false
        try {
          await this.dependencies.persistence.addAccount({
            accountName: session.accountName,
            hostname: session.hostname,
            gheDomain,
            githubToken: authenticated.githubToken,
            routing: nextConfig,
          }, () => {
            configureAccountRuntimes(nextRouting, nextRuntimes.values())
            runtimeApplied = true
          })
          this.runtimes = nextRuntimes
          this.routing = nextRouting
          this.knownAccountNames.add(session.accountName)
          this.refreshCleanups.set(session.accountName, authenticated.stopRefresh)
        }
        catch (error) {
          if (runtimeApplied) {
            configureAccountRuntimes(previousRouting, this.runtimes.values())
          }
          authenticated.stopRefresh()
          throw error
        }
      })
      session.state = 'succeeded'
    }
    catch {
      session.state = 'failed'
      session.message = 'Account authentication failed.'
    }
    finally {
      this.releaseReservation(session.accountName, session.hostname)
    }
    return publicSession(session)
  }

  private releaseReservation(accountName: string, hostname: string): void {
    this.reservedAccountNames.delete(accountName)
    this.reservedHostnames.delete(hostname)
  }

  private runMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(mutation, mutation)
    this.mutationTail = result.then(() => {}, () => {})
    return result
  }

  private assertManagedRoutingInvariant(): void {
    const hostnames = dedicatedHostnamesByAccount(this.routing)
    for (const accountName of this.runtimes.keys()) {
      if (!hostnames.has(accountName)) {
        throw new Error(
          `Dashboard account management requires exactly one dedicated hostname for account ${JSON.stringify(accountName)}.`,
        )
      }
    }
  }
}

async function runPersistedAccountMutation(
  paths: AccountManagerPaths,
  mutation: () => Promise<void>,
): Promise<void> {
  await beginAccountManagementTransaction(paths)
  try {
    await mutation()
    await commitAccountManagementTransaction(paths)
  }
  catch (error) {
    try {
      await rollbackAccountManagementTransaction(paths)
      if (paths.CONFIG_PATH === PATHS.CONFIG_PATH) {
        await readConfig()
      }
    }
    catch (rollbackError) {
      throw new Error(
        'Account management update failed and could not be rolled back. Restart ghc-proxy to recover the transaction journal before retrying.',
        { cause: rollbackError },
      )
    }
    throw error
  }
}

function dedicatedHostnamesByAccount(
  routing: CompiledAccountRouting,
): Map<string, string> {
  const hostnames = new Map<string, string>()
  for (const [hostname, accountName] of routing.hostnames) {
    if (hostnames.has(accountName)) {
      throw new Error(
        `Dashboard account management requires exactly one dedicated hostname for account ${JSON.stringify(accountName)}.`,
      )
    }
    hostnames.set(accountName, hostname)
  }
  return hostnames
}

function routingConfig(routing: CompiledAccountRouting): AccountRoutingConfig {
  return {
    baseHostname: routing.baseHostname,
    defaultAccount: routing.defaultAccount,
    hostnames: Object.fromEntries(routing.hostnames),
  }
}

function cloneCompiledRouting(routing: CompiledAccountRouting): CompiledAccountRouting {
  return {
    baseHostname: routing.baseHostname,
    defaultAccount: routing.defaultAccount,
    hostnames: new Map(routing.hostnames),
  }
}

function publicSession(
  session: InternalAuthenticationSession,
): AccountAuthenticationSession {
  return {
    id: session.id,
    state: session.state,
    accountName: session.accountName,
    hostname: session.hostname,
    authorization: session.authorization,
    ...(session.message ? { message: session.message } : {}),
  }
}

function parseAccountName(value: string): string {
  try {
    return normalizeAccountName(value)
  }
  catch (error) {
    throw new AccountManagementError('Invalid account name.', 400, { cause: error })
  }
}

function parseHostname(value: string): string {
  try {
    return normalizeDnsHostname(value)
  }
  catch (error) {
    throw new AccountManagementError('Invalid account hostname.', 400, { cause: error })
  }
}

function parseGheDomain(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined
  }
  try {
    return normalizeGheDomain(value)
  }
  catch (error) {
    throw new AccountManagementError('Invalid GHE tenant.', 400, { cause: error })
  }
}
