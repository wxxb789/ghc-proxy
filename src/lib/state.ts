import type { ModelsResponse } from "~/services/copilot/get-models"

export interface AuthState {
  githubToken?: string
  copilotToken?: string
}

export interface RuntimeConfig {
  accountType: string
  manualApprove: boolean
  rateLimitSeconds?: number
  rateLimitWait: boolean
  showToken: boolean
}

export interface CacheState {
  models?: ModelsResponse
  vsCodeVersion?: string
}

export interface RateLimitState {
  lastRequestTimestamp?: number
}

export interface AppState {
  auth: AuthState
  config: RuntimeConfig
  cache: CacheState
  rateLimit: RateLimitState
}

export const state: AppState = {
  auth: {},
  config: {
    accountType: "individual",
    manualApprove: false,
    rateLimitWait: false,
    showToken: false,
  },
  cache: {},
  rateLimit: {},
}
