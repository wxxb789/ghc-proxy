import type { RoutedAccountDescriptor } from './descriptor'
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
import type { AccountRuntime } from '~/state'

import type { AuthStore } from '~/state/auth'

import { randomUUID } from 'node:crypto'
import { normalizeGheDomain } from '~/clients/ghe-domain'
import { resetMscTokenCache } from '~/clients/msc-auth'
import {
  beginAccountManagementTransaction,
  commitAccountManagementTransaction,
  rollbackAccountManagementTransaction,
} from '~/lib/account-management-transaction'
import {
  compileAccountRouting,
  M365_DEFAULT_HOSTNAME,
  normalizeAccountName,
  normalizeDnsHostname,
  RESERVED_M365_TARGET,
} from '~/lib/account-routing'
import { getCachedConfig, readConfig, writeConfigField } from '~/lib/config'
import { writeNewGitHubCredential } from '~/lib/credentials'
import { PATHS } from '~/lib/paths'
import { configureAccountRuntimes, disableAccountRouting, runWithAccountRuntime } from '~/state'
import {
  beginAccountDeviceAuthentication,
} from './device-auth'
import { createTargetRuntime, initializeM365Target } from './target-runtime'

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

export interface PersistM365TargetInput {
  routing: AccountRoutingConfig
  account?: string
}

export interface AccountManagerPersistence {
  addAccount: (
    input: PersistAccountInput,
    applyRuntime: () => void,
  ) => Promise<void>
  persistRouting: (
    routing: AccountRoutingConfig,
    applyRuntime: () => void,
  ) => Promise<void>
  /** Writes the routing block and the M365 credential identity in one journal. */
  persistM365Target?: (
    input: PersistM365TargetInput,
    applyRuntime: () => void,
  ) => Promise<void>
}

export interface AccountRoutingSummary {
  baseHostname: string
  defaultAccount: string
  routingEnabled: boolean
}

export interface AccountManagerDependencies {
  beginAuthentication: typeof beginAccountDeviceAuthentication
  createSessionId: () => string
  persistence: AccountManagerPersistence
}

export interface AccountManagerState {
  authDefaults?: Partial<AuthStore>
  knownAccountNames?: Iterable<string>
  refreshCleanups?: ReadonlyMap<string, () => void>
  routing: CompiledAccountRouting
  routingEnabled?: boolean
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

export interface AccountManagementSnapshot {
  accounts: RoutedAccountDescriptor[]
  routing: AccountRoutingSummary
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
    persistRouting: async (routing, applyRuntime) => {
      await runPersistedAccountMutation(paths, async () => {
        await writeConfigField('accountRouting', routing, {
          configPath: paths.CONFIG_PATH,
          failOnReadError: true,
        })
        applyRuntime()
      })
    },
    persistM365Target: async (input, applyRuntime) => {
      await runPersistedAccountMutation(paths, async () => {
        await writeConfigField('accountRouting', input.routing, {
          configPath: paths.CONFIG_PATH,
          failOnReadError: true,
        })
        await writeConfigField('m365', {
          ...getCachedConfig().m365,
          account: input.account,
        }, {
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
}

const MAX_AUTHENTICATION_SESSIONS = 32

export class AccountManager {
  private readonly authenticationControllers = new Set<AbortController>()
  private readonly authenticationStarts = new Set<Promise<AccountAuthenticationSession>>()
  private readonly authDefaults: Partial<AuthStore>
  private readonly dependencies: AccountManagerDependencies
  private readonly knownAccountNames: Set<string>
  private readonly refreshCleanups = new Map<string, () => void>()
  private readonly reservedAccountNames = new Set<string>()
  private readonly reservedHostnames = new Set<string>()
  private readonly sessions = new Map<string, InternalAuthenticationSession>()
  private mutationTail: Promise<void> = Promise.resolve()
  private routing: CompiledAccountRouting
  private routingEnabled: boolean
  private runtimes: Map<string, AccountRuntime>
  private stopped = false

  constructor(
    state: AccountManagerState,
    dependencyOverrides: Partial<AccountManagerDependencies> = {},
  ) {
    this.authDefaults = { ...state.authDefaults, showToken: false }
    this.dependencies = { ...defaultDependencies, ...dependencyOverrides }
    this.routing = cloneCompiledRouting(state.routing)
    this.routingEnabled = state.routingEnabled ?? true
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

  getAccountSnapshot(): AccountManagementSnapshot {
    const hostnames = dedicatedHostnamesByAccount(this.routing)
    const descriptors = Array.from(this.runtimes.values(), runtime => ({
      name: runtime.name,
      hostname: hostnames.get(runtime.name)!,
      isDefault: runtime.name === this.routing.defaultAccount,
      runtime,
    })).sort((left, right) => left.name.localeCompare(right.name))
    return {
      accounts: descriptors,
      routing: this.getRoutingSummary(),
    }
  }

  getRoutingSummary(): AccountRoutingSummary {
    return {
      baseHostname: this.routing.baseHostname,
      defaultAccount: this.routing.defaultAccount,
      routingEnabled: this.routingEnabled,
    }
  }

  async bootstrapAccountRouting(rawHostname: string): Promise<void> {
    if (this.stopped) {
      throw new AccountManagementError('Account management is shutting down.', 503)
    }
    const hostname = parseHostname(rawHostname)
    await this.runMutation(async () => {
      if (this.stopped) {
        throw new AccountManagementError('Account management is shutting down.', 503)
      }
      if (this.routingEnabled) {
        throw new AccountManagementError('Named-account routing is already enabled.', 409)
      }
      if (hostname === this.routing.baseHostname) {
        throw new AccountManagementError(
          'A dedicated account hostname must differ from the base hostname.',
          400,
        )
      }

      const nextConfig: AccountRoutingConfig = {
        baseHostname: this.routing.baseHostname,
        defaultAccount: this.routing.defaultAccount,
        hostnames: { [hostname]: this.routing.defaultAccount },
      }
      const nextRouting = compileAccountRouting(nextConfig, this.githubAccountNames())
      let runtimeApplied = false
      try {
        await this.dependencies.persistence.persistRouting(nextConfig, () => {
          configureAccountRuntimes(nextRouting, this.runtimes.values())
          runtimeApplied = true
        })
        this.routing = nextRouting
        this.routingEnabled = true
      }
      catch (error) {
        if (runtimeApplied) {
          disableAccountRouting()
        }
        if (error instanceof AccountManagementError) {
          throw error
        }
        throw new AccountManagementError(
          'Could not enable named-account routing.',
          500,
          { cause: error },
        )
      }
    })
  }

  beginAddAccount(input: AddAccountInput): Promise<AccountAuthenticationSession> {
    const start = this.startAccountAuthentication(input)
    this.authenticationStarts.add(start)
    void start.then(
      () => { this.authenticationStarts.delete(start) },
      () => { this.authenticationStarts.delete(start) },
    )
    return start
  }

  private async startAccountAuthentication(
    input: AddAccountInput,
  ): Promise<AccountAuthenticationSession> {
    if (this.stopped) {
      throw new AccountManagementError('Account management is shutting down.', 503)
    }
    if (!this.routingEnabled) {
      throw new AccountManagementError(
        'Enable named-account routing before adding another account.',
        409,
      )
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
    this.makeRoomForAuthenticationSession()

    this.reservedAccountNames.add(accountName)
    this.reservedHostnames.add(hostname)
    const abortController = new AbortController()
    this.authenticationControllers.add(abortController)
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
      this.authenticationControllers.delete(abortController)
      this.releaseReservation(accountName, hostname)
      if (this.stopped) {
        throw new AccountManagementError('Account management is shutting down.', 503)
      }
      throw new AccountManagementError(
        'Could not start account authentication.',
        502,
        { cause: error },
      )
    }
    if (this.stopped) {
      abortController.abort(new DOMException('Server stopped', 'AbortError'))
      await flow.completion.then(
        authenticated => authenticated.stopRefresh(),
        () => {},
      ).catch(() => {})
      this.authenticationControllers.delete(abortController)
      this.releaseReservation(accountName, hostname)
      throw new AccountManagementError('Account management is shutting down.', 503)
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
    if (!this.routingEnabled) {
      throw new AccountManagementError(
        'Enable named-account routing before changing the default account.',
        409,
      )
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
      const nextRouting = compileAccountRouting(nextConfig, this.githubAccountNames())
      let runtimeApplied = false
      try {
        await this.dependencies.persistence.persistRouting(nextConfig, () => {
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

  /**
   * Registers the M365 target as a route target. The routing block and the
   * broker identity are persisted together, and a failed persistence leaves
   * the previous table, runtimes, and configuration untouched.
   */
  async registerM365Target(
    input: { account?: string | null, hostname?: string } = {},
  ): Promise<void> {
    if (this.stopped) {
      throw new AccountManagementError('Account management is shutting down.', 503)
    }
    await this.runMutation(async () => {
      if (this.runtimes.has(RESERVED_M365_TARGET)) {
        throw new AccountManagementError('The M365 target is already registered.', 409)
      }
      const persist = this.dependencies.persistence.persistM365Target
      if (!persist) {
        throw new AccountManagementError(
          'This process cannot persist target changes.',
          409,
        )
      }

      const previousRouting = this.routing
      const current = routingConfig(this.routing)
      const hostname = normalizeDnsHostname(input.hostname ?? M365_DEFAULT_HOSTNAME)
      const account = input.account ?? getCachedConfig().m365?.account
      const nextConfig: AccountRoutingConfig = {
        ...current,
        hostnames: { ...current.hostnames, [hostname]: RESERVED_M365_TARGET },
      }
      const nextRouting = compileAccountRouting(nextConfig, this.githubAccountNames())
      const runtime = createTargetRuntime(RESERVED_M365_TARGET, 'm365', {
        mscAuthAccount: account,
        mscAuthUpn: getCachedConfig().m365?.upn,
        auth: this.authDefaults,
      })
      const nextRuntimes = new Map(this.runtimes)
      nextRuntimes.set(RESERVED_M365_TARGET, runtime)

      let runtimeApplied = false
      try {
        await persist({ routing: nextConfig, account }, () => {
          configureAccountRuntimes(nextRouting, nextRuntimes.values())
          runtimeApplied = true
        })
        this.routing = nextRouting
        this.runtimes = nextRuntimes
      }
      catch (error) {
        if (runtimeApplied) {
          configureAccountRuntimes(previousRouting, this.runtimes.values())
        }
        if (error instanceof AccountManagementError) {
          throw error
        }
        throw new AccountManagementError(
          'Could not register the M365 target.',
          500,
          { cause: error },
        )
      }

      await runWithAccountRuntime(runtime, () => initializeM365Target(runtime))
    })
  }

  /** Removes the M365 target; in-flight requests finish on the old runtime. */
  async removeM365Target(): Promise<void> {
    if (this.stopped) {
      throw new AccountManagementError('Account management is shutting down.', 503)
    }
    await this.runMutation(async () => {
      if (!this.runtimes.has(RESERVED_M365_TARGET)) {
        throw new AccountManagementError('The M365 target is not registered.', 404)
      }
      if (this.runtimes.size === 1) {
        throw new AccountManagementError(
          'The M365 target is the only target and cannot be removed.',
          409,
        )
      }
      if (this.routing.defaultAccount === RESERVED_M365_TARGET) {
        throw new AccountManagementError(
          'Choose another default target before removing the M365 target.',
          409,
        )
      }
      const persist = this.dependencies.persistence.persistM365Target
      if (!persist) {
        throw new AccountManagementError(
          'This process cannot persist target changes.',
          409,
        )
      }

      const previousRouting = this.routing
      const current = routingConfig(this.routing)
      const hostnames = Object.fromEntries(
        Object.entries(current.hostnames).filter(([, target]) => target !== RESERVED_M365_TARGET),
      )
      const nextConfig: AccountRoutingConfig = { ...current, hostnames }
      const nextRuntimes = new Map(this.runtimes)
      nextRuntimes.delete(RESERVED_M365_TARGET)
      const nextRouting = compileAccountRouting(nextConfig, githubAccountNamesOf(nextRuntimes))

      let runtimeApplied = false
      try {
        await persist({ routing: nextConfig }, () => {
          configureAccountRuntimes(nextRouting, nextRuntimes.values())
          runtimeApplied = true
        })
        this.routing = nextRouting
        this.runtimes = nextRuntimes
      }
      catch (error) {
        if (runtimeApplied) {
          configureAccountRuntimes(previousRouting, this.runtimes.values())
        }
        if (error instanceof AccountManagementError) {
          throw error
        }
        throw new AccountManagementError(
          'Could not remove the M365 target.',
          500,
          { cause: error },
        )
      }

      const cleanup = this.refreshCleanups.get(RESERVED_M365_TARGET)
      this.refreshCleanups.delete(RESERVED_M365_TARGET)
      cleanup?.()
    })
  }

  async configureM365Target(
    input: { account?: string | null, hostname?: string },
  ): Promise<void> {
    if (this.stopped) {
      throw new AccountManagementError('Account management is shutting down.', 503)
    }
    await this.runMutation(async () => {
      const currentRuntime = this.runtimes.get(RESERVED_M365_TARGET)
      if (!currentRuntime) {
        throw new AccountManagementError('The M365 target is not registered.', 404)
      }
      const persist = this.dependencies.persistence.persistM365Target
      if (!persist) {
        throw new AccountManagementError(
          'This process cannot persist target changes.',
          409,
        )
      }

      const previousRouting = this.routing
      const current = routingConfig(this.routing)
      const account = input.account === undefined
        ? currentRuntime.auth.mscAuthAccount
        : input.account ?? undefined
      const hostname = input.hostname === undefined
        ? dedicatedHostnamesByAccount(this.routing).get(RESERVED_M365_TARGET)!
        : normalizeDnsHostname(input.hostname)
      const hostnames = Object.fromEntries(
        Object.entries(current.hostnames).filter(([, target]) => target !== RESERVED_M365_TARGET),
      )
      const nextConfig: AccountRoutingConfig = {
        ...current,
        hostnames: { ...hostnames, [hostname]: RESERVED_M365_TARGET },
      }
      const accountChanged = (input.account !== undefined)
        && (account ?? undefined) !== currentRuntime.auth.mscAuthAccount
      const runtime = accountChanged
        ? createTargetRuntime(RESERVED_M365_TARGET, 'm365', {
            mscAuthAccount: account,
            mscAuthUpn: getCachedConfig().m365?.upn,
            auth: this.authDefaults,
          })
        : currentRuntime
      const nextRuntimes = new Map(this.runtimes)
      nextRuntimes.set(RESERVED_M365_TARGET, runtime)
      const nextRouting = compileAccountRouting(nextConfig, githubAccountNamesOf(nextRuntimes))

      let runtimeApplied = false
      try {
        await persist({ routing: nextConfig, account }, () => {
          configureAccountRuntimes(nextRouting, nextRuntimes.values())
          runtimeApplied = true
        })
        this.routing = nextRouting
        this.runtimes = nextRuntimes
      }
      catch (error) {
        if (runtimeApplied) {
          configureAccountRuntimes(previousRouting, this.runtimes.values())
        }
        if (error instanceof AccountManagementError) {
          throw error
        }
        throw new AccountManagementError(
          'Could not update the M365 target.',
          500,
          { cause: error },
        )
      }

      if (!accountChanged)
        return

      resetMscTokenCache()
      await runWithAccountRuntime(runtime, () => initializeM365Target(runtime))
    })
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return
    }
    this.stopped = true
    for (const controller of this.authenticationControllers) {
      controller.abort(new DOMException('Server stopped', 'AbortError'))
    }
    await Promise.allSettled(this.authenticationStarts)
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
        const nextRouting = compileAccountRouting(nextConfig, githubAccountNamesOf(nextRuntimes))
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
      this.authenticationControllers.delete(session.abortController)
      this.releaseReservation(session.accountName, session.hostname)
    }
    return publicSession(session)
  }

  private releaseReservation(accountName: string, hostname: string): void {
    this.reservedAccountNames.delete(accountName)
    this.reservedHostnames.delete(hostname)
  }

  private makeRoomForAuthenticationSession(): void {
    let sessionCount = this.reservedAccountNames.size
    for (const session of this.sessions.values()) {
      if (session.state !== 'pending') {
        sessionCount++
      }
    }
    if (sessionCount < MAX_AUTHENTICATION_SESSIONS) {
      return
    }
    for (const [id, session] of this.sessions) {
      if (session.state === 'pending') {
        continue
      }
      this.sessions.delete(id)
      sessionCount--
      if (sessionCount < MAX_AUTHENTICATION_SESSIONS) {
        return
      }
    }
    throw new AccountManagementError(
      'Too many account authentication sessions are in progress.',
      429,
    )
  }

  private runMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(mutation, mutation)
    this.mutationTail = result.then(() => {}, () => {})
    return result
  }

  private githubAccountNames(): string[] {
    return githubAccountNamesOf(this.runtimes)
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
    kinds: new Map(routing.kinds),
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

function githubAccountNamesOf(runtimes: Map<string, AccountRuntime>): string[] {
  return Array.from(runtimes.keys()).filter(name => name !== RESERVED_M365_TARGET)
}
