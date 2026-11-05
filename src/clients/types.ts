import type { UpstreamRecoveryRecord, UpstreamRequestQueue } from './upstream-queue'

/** Which upstream API the proxy talks to. */
export type UpstreamKind = 'github' | 'm365'

export interface ClientAuth {
  githubToken?: string
  copilotToken?: string
  copilotTokenExpiresAt?: number
  copilotTokenLastRefreshAt?: number
  copilotTokenLastRefreshSucceeded?: boolean
  mscAuthUsername?: string
  mscAuthTenant?: string
  copilotApiBase?: string
}

export interface ClientConfig {
  accountType: 'individual' | 'business' | 'enterprise'
  /** Defaults to `github` when omitted. */
  upstream?: UpstreamKind
  /** Selected gateway endpoint for the `m365` upstream. */
  m365Endpoint?: string
  /** Helper path for the `m365` upstream; discovery applies when omitted. */
  mscAuthExe?: string
  /** Broker home account id or exact email; otherwise select an unambiguous broker account. */
  mscAuthAccount?: string
  /** Broker account UPN to select when no home account id is set. */
  mscAuthUpn?: string
  vsCodeVersion?: string
  copilotApiBase?: string
  githubBaseUrl?: string
  githubApiBaseUrl?: string
}

export interface ClientDeps {
  fetch?: typeof fetch
  requestQueue?: UpstreamRequestQueue
  recovery?: UpstreamRecoveryRecord
  offerLocalModelCooldown?: boolean | ((effectiveModel: string) => boolean)
  fallbackAttempt?: boolean
}
