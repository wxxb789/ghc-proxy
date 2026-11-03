import type { UpstreamRecoveryRecord, UpstreamRequestQueue } from './upstream-queue'

/** Which upstream API the proxy talks to. */
export type UpstreamKind = 'github' | 'm365'

export interface ClientAuth {
  githubToken?: string
  copilotToken?: string
  copilotTokenExpiresAt?: number
  copilotApiBase?: string
}

export interface ClientConfig {
  accountType: 'individual' | 'business' | 'enterprise'
  /** Defaults to `github` when omitted. */
  upstream?: UpstreamKind
  /** Helper path for the `m365` upstream; discovery applies when omitted. */
  mscAuthExe?: string
  /** Broker account (home account id) to select; helper default applies when omitted. */
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
