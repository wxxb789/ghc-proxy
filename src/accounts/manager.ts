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
import { z } from 'zod'
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
import { getCachedConfig, writeConfigField } from '~/lib/config'
import { removeGitHubCredential, writeNewGitHubCredential } from '~/lib/credentials'
import { M365_DEFAULT_ENDPOINT, m365EndpointSchema } from '~/lib/m365-endpoints'
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

export interface M365TargetInput {
  account?: string | null
  hostname?: string
  endpoint?: string
  endpoints?: string[]
}

export interface PersistM365TargetInput {
  routing?: AccountRoutingConfig
  account?: string | null
  endpoint?: string
  endpoints?: string[]
}

export interface AccountManagerPersistence {
  addAccount: (
    input: PersistAccountInput,
    applyRuntime: () => void,
  ) => Promise<void>
  removeAccount: (
    accountName: string,
    routing: AccountRoutingConfig,
    applyRuntime: () => void,
  ) => Promise<void>
  persistRouting: (
    routing: AccountRoutingConfig,
    applyRuntime: () => void,
  ) => Promise<void>
  /** Writes routing and M365 settings in one journal, preserving omitted settings. */
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
    removeAccount: async (accountName, routing, applyRuntime) => {
      await runPersistedAccountMutation(paths, async () => {
        await removeGitHubCredential(accountName, paths)
        await writeConfigField('accountRouting', routing, {
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
        if (input.routing !== undefined) {
          await writeConfigField('accountRouting', input.routing, {
            configPath: paths.CONFIG_PATH,
            failOnReadError: true,
          })
        }
        await writeConfigField('m365', {
          ...(input.account !== undefined ? { account: input.account ?? undefined } : {}),
          ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
          ...(input.endpoints !== undefined ? { endpoints: input.endpoints } : {}),
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
const m365TargetInputSchema = z.object({
  account: z.string().nullable().optional(),
  hostname: z.string().optional(),
  endpoint: m365EndpointSchema.optional(),
  endpoints: z.array(m365EndpointSchema).transform(values => [...new Set(values)]).optional(),
}).strict()

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

  getMscAuthExe(): string | undefined {
    return this.authDefaults.mscAuthExe
  }

  private assertHostnameAvailable(hostname: string, owner: string): void {
    const currentOwner = this.routing.hostnames.get(hostname)
    if (currentOwner !== undefined && currentOwner !== owner) {
      throw new AccountManagementError(
        `Hostname ${JSON.stringify(hostname)} already reaches account ${JSON.stringify(currentOwner)}.`,
        409,
      )
    }
    if (currentOwner === undefined && this.reservedHostnames.has(hostname)) {
      throw new AccountManagementError(
        `Hostname ${JSON.stringify(hostname)} is reserved by an account authentication in progress.`,
        409,
      )
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
    this.assertRunning()
    const hostname = parseHostname(rawHostname)
    await this.runMutation(async () => {
      this.assertRunning()
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
      await this.commitTable(
        { routing: nextRouting, runtimes: this.runtimes },
        applyRuntime => this.dependencies.persistence.persistRouting(nextConfig, applyRuntime),
        { publish: 'in-journal', failureMessage: 'Could not enable named-account routing.' },
      )
      this.routingEnabled = true
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
    this.assertRunning()
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
      this.assertRunning()
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
      throw shuttingDownError()
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
    this.assertRunning()
    if (!this.routingEnabled) {
      throw new AccountManagementError(
        'Enable named-account routing before changing the default account.',
        409,
      )
    }
    const accountName = parseAccountName(rawAccountName)
    await this.runMutation(async () => {
      this.assertRunning()
      if (!this.runtimes.has(accountName)) {
        throw new AccountManagementError(
          `Account ${JSON.stringify(accountName)} does not exist.`,
          404,
        )
      }
      if (accountName === this.routing.defaultAccount) {
        return
      }

      const nextConfig = routingConfig({
        ...this.routing,
        defaultAccount: accountName,
      })
      const nextRouting = compileAccountRouting(nextConfig, this.githubAccountNames())
      await this.commitTable(
        { routing: nextRouting, runtimes: this.runtimes },
        applyRuntime => this.dependencies.persistence.persistRouting(nextConfig, applyRuntime),
        { publish: 'in-journal', failureMessage: 'Could not switch the default account.' },
      )
    })
  }

  /** Removes a routed account without changing ownership of in-flight requests. */
  async removeAccount(rawAccountName: string): Promise<void> {
    this.assertRunning()
    const accountName = parseAccountName(rawAccountName)
    if (accountName === RESERVED_M365_TARGET) {
      await this.removeM365Target()
      return
    }
    await this.runMutation(async () => {
      this.assertRunning()
      if (this.reservedAccountNames.has(accountName)) {
        throw new AccountManagementError(
          `Account ${JSON.stringify(accountName)} is being authenticated.`,
          409,
        )
      }
      if (!this.runtimes.has(accountName)) {
        throw new AccountManagementError(
          `Account ${JSON.stringify(accountName)} does not exist.`,
          404,
        )
      }
      if (this.runtimes.size === 1 || accountName === this.routing.defaultAccount) {
        throw new AccountManagementError(
          'Choose another default target before removing this account.',
          409,
        )
      }

      const current = routingConfig(this.routing)
      const nextConfig: AccountRoutingConfig = {
        ...current,
        hostnames: Object.fromEntries(
          Object.entries(current.hostnames).filter(([, target]) => target !== accountName),
        ),
      }
      const nextRuntimes = new Map(this.runtimes)
      nextRuntimes.delete(accountName)
      const nextRouting = compileAccountRouting(nextConfig, githubAccountNamesOf(nextRuntimes))
      await this.commitTable(
        { routing: nextRouting, runtimes: nextRuntimes },
        applyRuntime => this.dependencies.persistence.removeAccount(accountName, nextConfig, applyRuntime),
        { publish: 'in-journal', failureMessage: 'Could not remove the account.' },
      )

      this.knownAccountNames.delete(accountName)
      const cleanup = this.refreshCleanups.get(accountName)
      this.refreshCleanups.delete(accountName)
      cleanup?.()
    })
  }

  /**
   * Registers the M365 target as a route target. The routing block and the
   * broker identity are persisted together, and a failed persistence leaves
   * the previous table, runtimes, and configuration untouched.
   */
  async registerM365Target(
    input: M365TargetInput = {},
  ): Promise<void> {
    this.assertRunning()
    const parsedInput = parseM365TargetInput(input)
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

      const current = routingConfig(this.routing)
      const hostname = parsedInput.hostname ?? M365_DEFAULT_HOSTNAME
      this.assertHostnameAvailable(hostname, RESERVED_M365_TARGET)
      const saved = getCachedConfig().m365
      const account = parsedInput.account === undefined ? saved?.account : parsedInput.account ?? undefined
      const nextConfig: AccountRoutingConfig = {
        ...current,
        hostnames: { ...current.hostnames, [hostname]: RESERVED_M365_TARGET },
      }
      const nextRouting = compileAccountRouting(nextConfig, this.githubAccountNames())
      const runtime = createTargetRuntime(RESERVED_M365_TARGET, 'm365', {
        m365Endpoint: parsedInput.endpoint,
        mscAuthExe: this.authDefaults.mscAuthExe,
        mscAuthAccount: account,
        mscAuthUpn: saved?.upn,
        auth: this.authDefaults,
      })
      const nextRuntimes = new Map(this.runtimes)
      nextRuntimes.set(RESERVED_M365_TARGET, runtime)

      await this.commitTable(
        { routing: nextRouting, runtimes: nextRuntimes },
        applyRuntime => persist({
          routing: nextConfig,
          account: parsedInput.account,
          endpoint: parsedInput.endpoint,
          endpoints: parsedInput.endpoints,
        }, applyRuntime),
        {
          publish: 'after-commit',
          failureMessage: 'Could not register the M365 target.',
          warmUp: () => runWithAccountRuntime(runtime, () => initializeM365Target(runtime)),
        },
      )
    })
  }

  /** Removes the M365 target; in-flight requests finish on the old runtime. */
  async removeM365Target(): Promise<void> {
    this.assertRunning()
    await this.runMutation(async () => {
      this.assertRunning()
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

      const current = routingConfig(this.routing)
      const hostnames = Object.fromEntries(
        Object.entries(current.hostnames).filter(([, target]) => target !== RESERVED_M365_TARGET),
      )
      const nextConfig: AccountRoutingConfig = { ...current, hostnames }
      const nextRuntimes = new Map(this.runtimes)
      nextRuntimes.delete(RESERVED_M365_TARGET)
      const nextRouting = compileAccountRouting(nextConfig, githubAccountNamesOf(nextRuntimes))

      await this.commitTable(
        { routing: nextRouting, runtimes: nextRuntimes },
        applyRuntime => persist({ routing: nextConfig }, applyRuntime),
        { publish: 'after-commit', failureMessage: 'Could not remove the M365 target.' },
      )

      const cleanup = this.refreshCleanups.get(RESERVED_M365_TARGET)
      this.refreshCleanups.delete(RESERVED_M365_TARGET)
      cleanup?.()
    })
  }

  async configureM365Target(
    input: M365TargetInput,
  ): Promise<void> {
    this.assertRunning()
    const parsedInput = parseM365TargetInput(input)
    await this.runMutation(async () => {
      const currentRuntime = this.runtimes.get(RESERVED_M365_TARGET)
      const persist = this.dependencies.persistence.persistM365Target
      if (!persist) {
        throw new AccountManagementError(
          'This process cannot persist target changes.',
          409,
        )
      }
      if (!currentRuntime) {
        if (parsedInput.account !== undefined || parsedInput.hostname !== undefined
          || (parsedInput.endpoint === undefined && parsedInput.endpoints === undefined)) {
          throw new AccountManagementError('The M365 target is not registered.', 404)
        }
        await persistOrFail('Could not update the M365 target.', () => persist({
          endpoint: parsedInput.endpoint,
          endpoints: parsedInput.endpoints,
        }, () => {}))
        return
      }

      const current = routingConfig(this.routing)
      const account = parsedInput.account === undefined
        ? currentRuntime.auth.mscAuthAccount
        : parsedInput.account ?? undefined
      const endpoint = parsedInput.endpoint ?? currentRuntime.auth.m365Endpoint ?? M365_DEFAULT_ENDPOINT
      const hostname = parsedInput.hostname === undefined
        ? dedicatedHostnamesByAccount(this.routing).get(RESERVED_M365_TARGET)!
        : parsedInput.hostname
      this.assertHostnameAvailable(hostname, RESERVED_M365_TARGET)
      const hostnames = Object.fromEntries(
        Object.entries(current.hostnames).filter(([, target]) => target !== RESERVED_M365_TARGET),
      )
      const nextConfig: AccountRoutingConfig = {
        ...current,
        hostnames: { ...hostnames, [hostname]: RESERVED_M365_TARGET },
      }
      const accountChanged = (parsedInput.account !== undefined)
        && account !== currentRuntime.auth.mscAuthAccount
      const runtimeChanged = accountChanged || endpoint !== currentRuntime.auth.m365Endpoint
      const runtime = runtimeChanged
        ? createTargetRuntime(RESERVED_M365_TARGET, 'm365', {
            mscAuthExe: this.authDefaults.mscAuthExe,
            m365Endpoint: endpoint,
            mscAuthAccount: account,
            mscAuthUpn: getCachedConfig().m365?.upn,
            auth: this.authDefaults,
          })
        : currentRuntime
      const nextRuntimes = new Map(this.runtimes)
      nextRuntimes.set(RESERVED_M365_TARGET, runtime)
      const nextRouting = compileAccountRouting(nextConfig, githubAccountNamesOf(nextRuntimes))

      await this.commitTable(
        { routing: nextRouting, runtimes: nextRuntimes },
        applyRuntime => persist({
          routing: nextConfig,
          account: parsedInput.account,
          endpoint: parsedInput.endpoint,
          endpoints: parsedInput.endpoints,
        }, applyRuntime),
        {
          publish: 'after-commit',
          failureMessage: 'Could not update the M365 target.',
          warmUp: async () => {
            if (accountChanged)
              resetMscTokenCache()
            if (runtimeChanged) {
              await runWithAccountRuntime(runtime, () => initializeM365Target(runtime))
            }
          },
        },
      )
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
        throw shuttingDownError()
      }
      await this.runMutation(async () => {
        if (this.stopped) {
          authenticated.stopRefresh()
          throw shuttingDownError()
        }
        const nextRuntimes = new Map(this.runtimes)
        nextRuntimes.set(session.accountName, authenticated.runtime)
        const nextConfig = routingConfig(this.routing)
        nextConfig.hostnames[session.hostname] = session.accountName
        const nextRouting = compileAccountRouting(nextConfig, githubAccountNamesOf(nextRuntimes))
        try {
          await this.commitTable(
            { routing: nextRouting, runtimes: nextRuntimes },
            applyRuntime => this.dependencies.persistence.addAccount({
              accountName: session.accountName,
              hostname: session.hostname,
              gheDomain,
              githubToken: authenticated.githubToken,
              routing: nextConfig,
            }, applyRuntime),
            { publish: 'in-journal' },
          )
        }
        catch (error) {
          authenticated.stopRefresh()
          throw error
        }
        this.knownAccountNames.add(session.accountName)
        this.refreshCleanups.set(session.accountName, authenticated.stopRefresh)
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

  /**
   * The one commit path for routing-table mutations. It persists the next
   * table, publishes it to the process-wide routing state, and only then adopts
   * it as the manager's committed table, so the two stay in step. A failure
   * leaves both on the previous table.
   *
   * `in-journal` (GitHub mutations) installs the prevalidated table inside the
   * persistence journal, before the journal is removed; a commit failure
   * republishes the previous table. `after-commit` (M365 mutations) persists
   * with a no-op apply, then awaits the warm-up and publishes, so a reader
   * never sees an uncommitted or cold target.
   */
  private async commitTable(
    next: { routing: CompiledAccountRouting, runtimes: Map<string, AccountRuntime> },
    persist: (applyRuntime: () => void) => Promise<void>,
    options: TableCommitOptions,
  ): Promise<void> {
    const publishNext = () => configureAccountRuntimes(next.routing, next.runtimes.values())
    if (options.publish === 'in-journal') {
      let runtimeApplied = false
      await persistOrFail(options.failureMessage, async () => {
        try {
          await persist(() => {
            publishNext()
            runtimeApplied = true
          })
        }
        catch (error) {
          if (runtimeApplied) {
            this.republishCommittedTable()
          }
          throw error
        }
      })
    }
    else {
      await persistOrFail(options.failureMessage, () => persist(() => {}))
      await options.warmUp?.()
      publishNext()
    }
    this.routing = next.routing
    this.runtimes = next.runtimes
  }

  /** Restores the process-wide routing state the manager last committed. */
  private republishCommittedTable(): void {
    // Until legacy bootstrap commits, the process serves the legacy runtime
    // without a routing table, so that is the state to restore.
    if (this.routingEnabled) {
      configureAccountRuntimes(this.routing, this.runtimes.values())
    }
    else {
      disableAccountRouting()
    }
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw shuttingDownError()
    }
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

function shuttingDownError(): AccountManagementError {
  return new AccountManagementError('Account management is shutting down.', 503)
}

type TableCommitOptions
  = | { publish: 'in-journal', failureMessage?: string }
    | { publish: 'after-commit', failureMessage: string, warmUp?: () => Promise<void> }

/**
 * Runs a persistence step. With a failure message, an unexpected failure
 * surfaces as a 500 management error; without one it propagates unchanged.
 */
async function persistOrFail(
  failureMessage: string | undefined,
  persist: () => Promise<void>,
): Promise<void> {
  try {
    await persist()
  }
  catch (error) {
    if (failureMessage === undefined || error instanceof AccountManagementError) {
      throw error
    }
    throw new AccountManagementError(failureMessage, 500, { cause: error })
  }
}

async function runPersistedAccountMutation(
  paths: AccountManagerPaths,
  mutation: () => Promise<void>,
): Promise<void> {
  const previousConfig = { ...getCachedConfig() }
  await beginAccountManagementTransaction(paths)
  try {
    await mutation()
    await commitAccountManagementTransaction(paths)
  }
  catch (error) {
    try {
      await rollbackAccountManagementTransaction(paths)
      const config = getCachedConfig()
      for (const key of Object.keys(config)) {
        Reflect.deleteProperty(config, key)
      }
      Object.assign(config, previousConfig)
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

function parseM365TargetInput(input: M365TargetInput): M365TargetInput {
  const result = m365TargetInputSchema.safeParse(input)
  if (!result.success) {
    throw new AccountManagementError('Invalid M365 target settings.', 400, { cause: result.error })
  }
  return {
    ...result.data,
    ...(result.data.hostname !== undefined ? { hostname: parseHostname(result.data.hostname) } : {}),
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
