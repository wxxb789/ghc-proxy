import type { UpstreamRecoveryRecord, UpstreamRequestQueue } from './upstream-queue'
import type { AccountRuntime } from '~/state/account-runtime'

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
  m365Endpoint?: string
  vsCodeVersion?: string
  copilotApiBase?: string
  githubBaseUrl?: string
  githubApiBaseUrl?: string
}

export interface ClientDeps {
  fetch?: typeof fetch
  /**
   * The route target whose `auth` the client uses. The `m365` upstream acquires
   * its credential through it and records the target's availability on it.
   */
  runtime?: AccountRuntime
  requestQueue?: UpstreamRequestQueue
  recovery?: UpstreamRecoveryRecord
  offerLocalModelCooldown?: boolean | ((effectiveModel: string) => boolean)
  fallbackAttempt?: boolean
}
