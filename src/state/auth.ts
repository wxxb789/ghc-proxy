export class AuthStore {
  githubToken?: string
  copilotToken?: string
  copilotApiBase?: string
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
