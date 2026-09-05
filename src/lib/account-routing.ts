import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'

import { z } from 'zod'

const DNS_LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const ACCOUNT_NAME_RE = /^[a-z0-9][\w.-]{0,63}$/i

export interface AccountRoutingConfig {
  baseHostname: string
  defaultAccount: string
  hostnames: Record<string, string>
}

export interface CompiledAccountRouting {
  baseHostname: string
  defaultAccount: string
  hostnames: Map<string, string>
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

export function compileAccountRouting(
  config: AccountRoutingConfig,
  accountNames: Iterable<string>,
): CompiledAccountRouting {
  const normalized = normalizeAccountRoutingConfig(config)
  const knownAccounts = new Set(accountNames)

  if (!knownAccounts.has(normalized.defaultAccount)) {
    throw new Error(
      `accountRouting selects missing default account ${JSON.stringify(normalized.defaultAccount)}.`,
    )
  }

  for (const [hostname, accountName] of Object.entries(normalized.hostnames)) {
    if (!knownAccounts.has(accountName)) {
      throw new Error(
        `accountRouting hostname ${JSON.stringify(hostname)} selects missing account ${JSON.stringify(accountName)}.`,
      )
    }
  }

  return {
    baseHostname: normalized.baseHostname,
    defaultAccount: normalized.defaultAccount,
    hostnames: new Map(Object.entries(normalized.hostnames)),
  }
}

export function resolveAccountName(
  routing: CompiledAccountRouting,
  requestHostname: string,
): string | undefined {
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
