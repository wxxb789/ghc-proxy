import type { UpstreamRecoveryRecord, UpstreamRequestQueueOptions, UpstreamRequestQueueSnapshot } from './upstream-queue'
import type { ClientConfig } from '~/clients'

import consola from 'consola'
import { CopilotClient, getVSCodeVersion } from '~/clients'
import { authStore, modelCache } from '~/state'
import { buildGitHubUrls } from './ghe-domain'
import { createDefaultUpstreamRequestQueue } from './upstream-queue'

const upstreamRequestQueue = createDefaultUpstreamRequestQueue()

export function configureUpstreamRequestQueue(
  options: Partial<UpstreamRequestQueueOptions>,
): void {
  upstreamRequestQueue.updateOptions(options)
}

export function getUpstreamRequestQueueSnapshot(): UpstreamRequestQueueSnapshot {
  return upstreamRequestQueue.snapshot()
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

export function createCopilotClient(
  recovery?: UpstreamRecoveryRecord,
  options: {
    offerLocalModelCooldown?: (effectiveModel: string) => boolean
    fallbackAttempt?: boolean
  } = {},
): CopilotClient {
  return new CopilotClient(authStore, getClientConfig(), {
    requestQueue: upstreamRequestQueue,
    recovery,
    ...options,
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
