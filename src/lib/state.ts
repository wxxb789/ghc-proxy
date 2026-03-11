import type { ClientConfig } from '~/clients'
import type { ModelsResponse } from '~/types'

import consola from 'consola'

import { CopilotClient, getVSCodeVersion } from '~/clients'

export interface AuthState {
  githubToken?: string
  copilotToken?: string
  copilotApiBase?: string
}

export interface RuntimeConfig {
  accountType: 'individual' | 'business' | 'enterprise'
  manualApprove: boolean
  rateLimitSeconds?: number
  rateLimitWait: boolean
  showToken: boolean
  upstreamTimeoutSeconds?: number
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
    accountType: 'individual',
    manualApprove: false,
    rateLimitWait: false,
    showToken: false,
  },
  cache: {},
  rateLimit: {},
}

export function getClientConfig(): ClientConfig {
  return {
    accountType: state.config.accountType,
    vsCodeVersion: state.cache.vsCodeVersion,
    copilotApiBase: state.auth.copilotApiBase,
  }
}

export async function cacheModels(client?: CopilotClient): Promise<void> {
  const copilotClient
    = client ?? new CopilotClient(state.auth, getClientConfig())

  const models = await copilotClient.getModels()

  state.cache.models = models
}

export async function cacheVSCodeVersion() {
  const response = await getVSCodeVersion()
  state.cache.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
