export class AuthStore {
  githubToken?: string
  copilotToken?: string
  copilotApiBase?: string
  /** Upstream API in use; the M365 path needs no GitHub credentials. */
  upstream: 'github' | 'm365' = 'github'
  /** Explicit helper path for the M365 upstream. */
  mscAuthExe?: string
  /** Broker home account id or exact email selected for the M365 upstream. */
  mscAuthAccount?: string
  /** Broker account UPN when no account selector is configured. */
  mscAuthUpn?: string
  /** Identity returned by the broker, separate from the configured selector. */
  mscAuthUsername?: string
  mscAuthTenant?: string
  gheDomain?: string
  githubLogin?: string
  githubValidatedAt?: number
  copilotTokenExpiresAt?: number
  copilotTokenLastRefreshAt?: number
  copilotTokenLastRefreshSucceeded?: boolean
  accountType: 'individual' | 'business' | 'enterprise' = 'individual'
  manualApprove = false
  rateLimitSeconds?: number
  rateLimitWait = false
  showToken = false
  upstreamTimeoutSeconds?: number
}

export const authStore = new AuthStore()
