import type { UpstreamRecoveryRecord, UpstreamRequestQueueOptions, UpstreamRequestQueueSnapshot } from './upstream-queue'
import type { ClientConfig } from '~/clients'

import consola from 'consola'
import { CopilotClient, getVSCodeVersion } from '~/clients'
import { getOrCreateRequestCorrelation } from '~/lib/request-logger'
import { getCurrentAccountRuntime, getRequestAccountName } from '~/state'
import { buildGitHubUrls } from './ghe-domain'
import { createDefaultUpstreamRequestQueue } from './upstream-queue'

const upstreamRequestQueues = new Set<ReturnType<typeof createDefaultUpstreamRequestQueue>>()
let upstreamRequestQueueOptions: Partial<UpstreamRequestQueueOptions> = {}
const accountQueues = new WeakMap<object, ReturnType<typeof createDefaultUpstreamRequestQueue>>()
let vsCodeVersionPromise: Promise<string> | undefined

function getUpstreamRequestQueue() {
  const runtime = getCurrentAccountRuntime()
  const existing = accountQueues.get(runtime)
  if (existing) {
    return existing
  }

  const queue = createDefaultUpstreamRequestQueue(upstreamRequestQueueOptions)
  accountQueues.set(runtime, queue)
  upstreamRequestQueues.add(queue)
  return queue
}

export function configureUpstreamRequestQueue(
  options: Partial<UpstreamRequestQueueOptions>,
): void {
  upstreamRequestQueueOptions = { ...upstreamRequestQueueOptions, ...options }
  for (const queue of upstreamRequestQueues) {
    queue.updateOptions(options)
  }
}

export function getUpstreamRequestQueueSnapshot(): UpstreamRequestQueueSnapshot {
  return getUpstreamRequestQueue().snapshot()
}

export function getClientConfig(): ClientConfig {
  const runtime = getCurrentAccountRuntime()
  const { baseUrl, apiBaseUrl } = buildGitHubUrls(runtime.auth.gheDomain)
  return {
    accountType: runtime.auth.accountType,
    vsCodeVersion: runtime.models.getVSCodeVersion(),
    copilotApiBase: runtime.auth.copilotApiBase,
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
  const runtime = getCurrentAccountRuntime()
  return new CopilotClient(runtime.auth, getClientConfig(), {
    requestQueue: getUpstreamRequestQueue(),
    recovery,
    ...options,
  })
}

export function createRequestRecoveryRecord(request: Request): UpstreamRecoveryRecord {
  const { requestId, callerRequestId } = getOrCreateRequestCorrelation(request)
  return {
    requestId,
    accountName: getRequestAccountName(request),
    ...(callerRequestId ? { callerRequestId } : {}),
    callerSignal: request.signal,
    retryCount: 0,
  }
}

export async function cacheModels(client?: CopilotClient): Promise<void> {
  const { models } = getCurrentAccountRuntime()
  const copilotClient = client ?? createCopilotClient()
  const response = await copilotClient.getModels()
  models.cacheModels(response)
}

export async function cacheVSCodeVersion() {
  const { models } = getCurrentAccountRuntime()
  const response = await (vsCodeVersionPromise ??= getVSCodeVersion().catch((error) => {
    vsCodeVersionPromise = undefined
    throw error
  }))
  models.setVSCodeVersion(response)
  consola.debug(`Using VSCode version: ${response}`)
}
