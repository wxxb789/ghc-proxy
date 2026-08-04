import type { UpstreamRecoveryRecord, UpstreamRequestQueue } from './upstream-queue'

export interface ClientAuth {
  githubToken?: string
  copilotToken?: string
  copilotApiBase?: string
}

export interface ClientConfig {
  accountType: 'individual' | 'business' | 'enterprise'
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
