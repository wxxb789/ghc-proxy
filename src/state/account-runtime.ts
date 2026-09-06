import type { CompiledAccountRouting } from '~/lib/account-routing'

import { AsyncLocalStorage } from 'node:async_hooks'

import { resolveAccountName } from '~/lib/account-routing'

import { AuthStore, authStore as legacyAuthStore } from './auth'
import { modelCache as legacyModelCache, ModelCache } from './model-cache'
import { rateLimiter as legacyRateLimiter, RateLimiter } from './rate-limiter'
import {
  createResponsesEmulatorState,
  responsesEmulatorState as legacyResponsesEmulatorState,
} from './responses-emulator-state'

export interface AccountRuntime {
  readonly name: string
  auth: AuthStore
  models: ModelCache
  rateLimiter: RateLimiter
  responsesEmulator: ReturnType<typeof createResponsesEmulatorState>
}

const legacyRuntime: AccountRuntime = {
  name: 'default',
  auth: legacyAuthStore,
  models: legacyModelCache,
  rateLimiter: legacyRateLimiter,
  responsesEmulator: legacyResponsesEmulatorState,
}

const accountContext = new AsyncLocalStorage<AccountRuntime>()
const requestAccounts = new WeakMap<Request, string>()

let accountRuntimes = new Map([[legacyRuntime.name, legacyRuntime]])
let defaultRuntime = legacyRuntime
let routing: CompiledAccountRouting | undefined

function contextualProxy<T extends object>(
  legacyTarget: T,
  select: (runtime: AccountRuntime) => T,
): T {
  return new Proxy(legacyTarget, {
    get(_target, property) {
      const selected = select(getCurrentAccountRuntime())
      const value = Reflect.get(selected, property, selected) as unknown
      return typeof value === 'function' ? value.bind(selected) : value
    },
    set(_target, property, value) {
      const selected = select(getCurrentAccountRuntime())
      return Reflect.set(selected, property, value, selected)
    },
  })
}

export const authStore = contextualProxy(legacyAuthStore, runtime => runtime.auth)
export const modelCache = contextualProxy(legacyModelCache, runtime => runtime.models)
export const rateLimiter = contextualProxy(legacyRateLimiter, runtime => runtime.rateLimiter)
export const responsesEmulatorState = contextualProxy(
  legacyResponsesEmulatorState,
  runtime => runtime.responsesEmulator,
)

export function createAccountRuntime(
  name: string,
  authValues: Partial<AuthStore> = {},
): AccountRuntime {
  const auth = Object.assign(new AuthStore(), authValues)
  return {
    name,
    auth,
    models: new ModelCache(),
    rateLimiter: new RateLimiter(),
    responsesEmulator: createResponsesEmulatorState(),
  }
}

export function aliasLegacyAccountRuntime(name: string): AccountRuntime {
  return {
    name,
    auth: legacyRuntime.auth,
    models: legacyRuntime.models,
    rateLimiter: legacyRuntime.rateLimiter,
    responsesEmulator: legacyRuntime.responsesEmulator,
  }
}

export function configureAccountRuntimes(
  nextRouting: CompiledAccountRouting,
  runtimes: Iterable<AccountRuntime>,
): void {
  const nextRuntimes = new Map(
    Array.from(runtimes, runtime => [runtime.name, runtime] as const),
  )
  if (nextRuntimes.size === 0) {
    throw new Error('At least one account runtime is required.')
  }
  const nextDefault = nextRuntimes.get(nextRouting.defaultAccount)
  if (!nextDefault) {
    throw new Error(
      `No runtime exists for default account ${JSON.stringify(nextRouting.defaultAccount)}.`,
    )
  }

  for (const accountName of nextRouting.hostnames.values()) {
    if (!nextRuntimes.has(accountName)) {
      throw new Error(`No runtime exists for account ${JSON.stringify(accountName)}.`)
    }
  }

  accountRuntimes = nextRuntimes
  defaultRuntime = nextDefault
  routing = nextRouting
}

export function resetAccountRuntimes(): void {
  for (const runtime of accountRuntimes.values()) {
    if (runtime !== legacyRuntime) {
      runtime.responsesEmulator.clear()
      runtime.rateLimiter.reset()
    }
  }
  disableAccountRouting()
  accountContext.disable()
}

export function disableAccountRouting(): void {
  accountRuntimes = new Map([[legacyRuntime.name, legacyRuntime]])
  defaultRuntime = legacyRuntime
  routing = undefined
}

export function getCurrentAccountRuntime(): AccountRuntime {
  return accountContext.getStore() ?? defaultRuntime
}

export function getCurrentAccountName(): string {
  return getCurrentAccountRuntime().name
}

export function getCurrentRoutedAccountName(): string | undefined {
  return routing ? getCurrentAccountName() : undefined
}

export function runWithAccountRuntime<T>(
  runtime: AccountRuntime,
  callback: () => T,
): T {
  return accountContext.run(runtime, callback)
}

export function resolveRequestAccountRuntime(request: Request): AccountRuntime | undefined {
  if (!routing)
    return defaultRuntime

  const accountName = resolveAccountName(routing, new URL(request.url).hostname)
  if (!accountName)
    return undefined
  const runtime = accountRuntimes.get(accountName)
  if (!runtime)
    return undefined

  requestAccounts.set(request, runtime.name)
  return runtime
}

export function getRequestAccountName(request: Request): string | undefined {
  return requestAccounts.get(request)
}
