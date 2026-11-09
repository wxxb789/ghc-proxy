import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'

import { z } from 'zod'

const DNS_LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const ACCOUNT_NAME_RE = /^[a-z0-9][\w.-]{0,63}$/i
const LOOPBACK_DEFAULT_HOSTNAME = '127.0.0.1'

export const RESERVED_M365_TARGET = 'm365'

export const M365_DEFAULT_HOSTNAME = 'm365.localhost'

export type TargetKind = 'github' | 'm365'

export interface AccountRoutingConfig {
  baseHostname: string
  defaultAccount: string
  hostnames: Record<string, string>
}

export interface CompiledAccountRouting {
  baseHostname: string
  defaultAccount: string
  hostnames: Map<string, string>
  kinds: Map<string, TargetKind>
}

const rawAccountRoutingSchema = z.object({
  baseHostname: z.string().min(1),
  defaultAccount: z.string().min(1),
  hostnames: z.record(z.string(), z.string().min(1)).default({}),
}).strict()

export const accountRoutingSchema = rawAccountRoutingSchema.transform((value, ctx) => {
  try {
    return normalizeAccountRoutingConfig(value)
  }
  catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : String(error),
    })
    return z.NEVER
  }
})

export function normalizeDnsHostname(value: string): string {
  const trimmed = value.trim()
  const withoutTrailingDot = trimmed.endsWith('.')
    ? trimmed.slice(0, -1)
    : trimmed
  const hostname = domainToASCII(withoutTrailingDot).toLowerCase()

  if (
    !hostname
    || hostname.length > 253
    || isIP(hostname) !== 0
    || hostname.split('.').some(label => !DNS_LABEL_RE.test(label))
  ) {
    throw new Error(`Expected a DNS hostname, received ${JSON.stringify(value)}.`)
  }

  return hostname
}

export function normalizeAccountName(value: string): string {
  const accountName = value.trim()
  if (!ACCOUNT_NAME_RE.test(accountName)) {
    throw new Error(
      `Expected an account name containing only letters, numbers, dot, underscore, or hyphen, received ${JSON.stringify(value)}.`,
    )
  }
  return accountName
}

export function normalizeAccountRoutingConfig(
  config: AccountRoutingConfig,
): AccountRoutingConfig {
  const baseHostname = normalizeDnsHostname(config.baseHostname)
  const defaultAccount = normalizeAccountName(config.defaultAccount)
  const hostnames: Record<string, string> = {}

  for (const [rawHostname, rawAccount] of Object.entries(config.hostnames)) {
    const hostname = normalizeDnsHostname(rawHostname)
    if (hostname === baseHostname) {
      throw new Error(
        `accountRouting.hostnames must not repeat the base hostname ${JSON.stringify(baseHostname)}.`,
      )
    }
    if (Object.hasOwn(hostnames, hostname)) {
      throw new Error(
        `accountRouting.hostnames contains multiple entries for the same DNS hostname ${JSON.stringify(hostname)}.`,
      )
    }
    hostnames[hostname] = normalizeAccountName(rawAccount)
  }

  return { baseHostname, defaultAccount, hostnames }
}

/**
 * A routing change one process computed from its committed table: `previous`
 * is that table, absent when the change first enables routing.
 */
export interface AccountRoutingUpdate {
  previous?: AccountRoutingConfig
  next: AccountRoutingConfig
}

/**
 * Applies only what `update` changed to the routing stored now. Several
 * processes can share one profile, and each holds the table it loaded at
 * startup; writing that whole table would undo changes saved by the others.
 * Hostnames that `update` added, reassigned, or removed are applied, and every
 * stored hostname of a target it removed is dropped; the base hostname and
 * default account follow `update` only where it changed them. A hostname this
 * change touches that another process bound to a third target throws instead
 * of being overwritten. The caller validates the result.
 */
export function rebaseAccountRoutingUpdate(
  stored: AccountRoutingConfig | undefined,
  update: AccountRoutingUpdate,
): AccountRoutingConfig {
  const { next } = update
  if (!stored) {
    return next
  }
  const previous = update.previous ?? { ...next, hostnames: {} }
  const nextTargets = new Set(Object.values(next.hostnames))
  const removedTargets = new Set(
    Object.values(previous.hostnames).filter(target => !nextTargets.has(target)),
  )

  const hostnames: Record<string, string> = {}
  for (const [hostname, target] of Object.entries(stored.hostnames)) {
    if (!removedTargets.has(target)) {
      hostnames[hostname] = target
    }
  }
  const touched = new Set([...Object.keys(previous.hostnames), ...Object.keys(next.hostnames)])
  for (const hostname of touched) {
    const before = previous.hostnames[hostname]
    const after = next.hostnames[hostname]
    if (before === after) {
      continue
    }
    const current = stored.hostnames[hostname]
    if (current !== before && current !== after) {
      throw new Error(
        `accountRouting hostname ${JSON.stringify(hostname)} was changed by another process.`,
      )
    }
    if (after === undefined) {
      Reflect.deleteProperty(hostnames, hostname)
    }
    else {
      hostnames[hostname] = after
    }
  }

  return {
    baseHostname: next.baseHostname !== previous.baseHostname
      ? next.baseHostname
      : stored.baseHostname,
    defaultAccount: next.defaultAccount !== previous.defaultAccount
      ? next.defaultAccount
      : stored.defaultAccount,
    hostnames,
  }
}

export function compileAccountRouting(
  config: AccountRoutingConfig,
  accountNames: Iterable<string>,
): CompiledAccountRouting {
  const normalized = normalizeAccountRoutingConfig(config)
  const knownAccounts = new Set(accountNames)

  if (knownAccounts.has(RESERVED_M365_TARGET)) {
    throw new Error(
      `The target name ${JSON.stringify(RESERVED_M365_TARGET)} is reserved for the Microsoft 365 gateway and may not be used by a GitHub account.`,
    )
  }

  const knownTargets = new Set([...knownAccounts, RESERVED_M365_TARGET])

  if (!knownTargets.has(normalized.defaultAccount)) {
    throw new Error(
      `accountRouting selects missing default account ${JSON.stringify(normalized.defaultAccount)}.`,
    )
  }

  for (const [hostname, accountName] of Object.entries(normalized.hostnames)) {
    if (!knownTargets.has(accountName)) {
      throw new Error(
        `accountRouting hostname ${JSON.stringify(hostname)} selects missing account ${JSON.stringify(accountName)}.`,
      )
    }
  }

  const dedicatedHostnameCounts = new Map<string, number>()
  for (const accountName of Object.values(normalized.hostnames)) {
    dedicatedHostnameCounts.set(
      accountName,
      (dedicatedHostnameCounts.get(accountName) ?? 0) + 1,
    )
  }
  const routedAccounts = new Set([
    normalized.defaultAccount,
    ...Object.values(normalized.hostnames),
  ])
  for (const accountName of routedAccounts) {
    if (dedicatedHostnameCounts.get(accountName) !== 1) {
      throw new Error(
        `accountRouting requires exactly one dedicated hostname for account ${JSON.stringify(accountName)}.`,
      )
    }
  }

  const kinds = new Map<string, TargetKind>()
  for (const target of routedAccounts) {
    kinds.set(
      target,
      target === RESERVED_M365_TARGET ? 'm365' : 'github',
    )
  }

  return {
    baseHostname: normalized.baseHostname,
    defaultAccount: normalized.defaultAccount,
    hostnames: new Map(Object.entries(normalized.hostnames)),
    kinds,
  }
}

export function resolveAccountName(
  routing: CompiledAccountRouting,
  requestHostname: string,
): string | undefined {
  if (requestHostname === LOOPBACK_DEFAULT_HOSTNAME)
    return routing.defaultAccount

  let hostname: string
  try {
    hostname = normalizeDnsHostname(requestHostname)
  }
  catch {
    return undefined
  }

  return hostname === routing.baseHostname
    ? routing.defaultAccount
    : routing.hostnames.get(hostname)
}
