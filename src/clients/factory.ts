import type { UpstreamRequestQueueOptions } from './upstream-queue'
import type { ClientConfig } from '~/clients'

import consola from 'consola'
import { CopilotClient, getVSCodeVersion } from '~/clients'
import { buildGitHubUrls } from '~/lib/ghe-domain'
import { authStore, modelCache } from '~/state'
import { createDefaultUpstreamRequestQueue } from './upstream-queue'

export interface RuntimeConfig {
  accountType: 'individual' | 'business' | 'enterprise'
  manualApprove: boolean
  rateLimitSeconds?: number
  rateLimitWait: boolean
  showToken: boolean
  upstreamTimeoutSeconds?: number
  upstreamQueueConcurrency?: number
  upstreamQueueMaxRetries?: number
  upstreamQueueBaseDelaySeconds?: number
  upstreamQueueMaxDelaySeconds?: number
}

const upstreamRequestQueue = createDefaultUpstreamRequestQueue()

export function configureUpstreamRequestQueue(
  options: Partial<UpstreamRequestQueueOptions>,
): void {
  upstreamRequestQueue.updateOptions(options)
}

export function getClientConfig(): ClientConfig {
  const { baseUrl, apiBaseUrl } = buildGitHubUrls(authStore.gheDomain)
  return {
    accountType: authStore.accountType,
    vsCodeVersion: modelCache.getVSCodeVersion(),
    copilotApiBase: authStore.copilotApiBase,
    githubBaseUrl: baseUrl,
    githubApiBaseUrl: apiBaseUrl,
  }
}

export function createCopilotClient(): CopilotClient {
  return new CopilotClient(authStore, getClientConfig(), {
    requestQueue: upstreamRequestQueue,
  })
}

export async function cacheModels(client?: CopilotClient): Promise<void> {
  const copilotClient = client ?? createCopilotClient()
  const models = await copilotClient.getModels()
  modelCache.cacheModels(models)
}

export async function cacheVSCodeVersion() {
  const response = await getVSCodeVersion()
  modelCache.setVSCodeVersion(response)
  consola.debug(`Using VSCode version: ${response}`)
}
