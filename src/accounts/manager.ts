import type {
  AccountDeviceAuthorization,
  AuthenticatedAccount,
} from './device-auth'
import type {
  AccountRoutingConfig,
  CompiledAccountRouting,
} from '~/lib/account-routing'
import type { DashboardAccountDescriptor } from '~/routes/dashboard/handler'
import type { AccountRuntime } from '~/state'
import type { AuthStore } from '~/state/auth'

import { randomUUID } from 'node:crypto'

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
import { writeGitHubCredential } from '~/lib/credentials'
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

const defaultPersistence: AccountManagerPersistence = {
  addAccount: async (input, applyRuntime) => {
    await runPersistedAccountMutation(async () => {
      await writeGitHubCredential(
        input.githubToken,
        input.gheDomain,
        undefined,
        input.accountName,
      )
      await writeConfigField('accountRouting', input.routing)
      applyRuntime()
    })
  },
  setDefault: async (routing, applyRuntime) => {
    await runPersistedAccountMutation(async () => {
      await writeConfigField('accountRouting', routing)
      applyRuntime()
    })
  },
}

const defaultDependencies: AccountManagerDependencies = {
  beginAuthentication: beginAccountDeviceAuthentication,
  createSessionId: randomUUID,
  persistence: defaultPersistence,
  projectAccount: getDashboardAccount,
}

export class AccountManager {
  private readonly authDefaults: Partial<AuthStore>
  private readonly dependencies: AccountManagerDependencies
  private readonly refreshCleanups = new Map<string, () => void>()
  private readonly reservedAccountNames = new Set<string>()
  private readonly reservedHostnames = new Set<string>()
  private readonly sessions = new Map<string, InternalAuthenticationSession>()
  private mutationTail: Promise<void> = Promise.resolve()
  private routing: CompiledAccountRouting
  private runtimes: Map<string, AccountRuntime>

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

  async beginAddAccount(input: AddAccountInput): Promise<AccountAuthenticationSession> {
    const accountName = normalizeAccountName(input.accountName)
    const hostname = normalizeDnsHostname(input.hostname)
    if (hostname === this.routing.baseHostname) {
      throw new Error('A dedicated account hostname must differ from the base hostname.')
    }
    if (this.runtimes.has(accountName) || this.reservedAccountNames.has(accountName)) {
      throw new Error(`Account ${JSON.stringify(accountName)} already exists or is being authenticated.`)
    }
    if (this.routing.hostnames.has(hostname) || this.reservedHostnames.has(hostname)) {
      throw new Error(`Hostname ${JSON.stringify(hostname)} is already configured or reserved.`)
    }

    this.reservedAccountNames.add(accountName)
    this.reservedHostnames.add(hostname)
    const abortController = new AbortController()
    let flow: Awaited<ReturnType<typeof beginAccountDeviceAuthentication>>
    try {
      flow = await this.dependencies.beginAuthentication({
        accountName,
        authDefaults: this.authDefaults,
        gheDomain: input.gheDomain,
        signal: abortController.signal,
      })
    }
    catch (error) {
      this.releaseReservation(accountName, hostname)
      throw error
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
      input.gheDomain,
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
      throw new Error(`Unknown account authentication session ${JSON.stringify(id)}.`)
    }
    return session.settled
  }

  async setDefaultAccount(rawAccountName: string): Promise<void> {
    const accountName = normalizeAccountName(rawAccountName)
    await this.runMutation(async () => {
      if (!this.runtimes.has(accountName)) {
        throw new Error(`Account ${JSON.stringify(accountName)} does not exist.`)
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
        throw error
      }
    })
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      if (session.state === 'pending') {
        session.abortController.abort(new DOMException('Server stopped', 'AbortError'))
      }
    }
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
      await this.runMutation(async () => {
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
  mutation: () => Promise<void>,
): Promise<void> {
  await beginAccountManagementTransaction()
  try {
    await mutation()
    await commitAccountManagementTransaction()
  }
  catch (error) {
    try {
      await rollbackAccountManagementTransaction()
      await readConfig()
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
