import type { UpstreamRecoveryRecord, UpstreamRequestQueueOptions, UpstreamRequestQueueSnapshot } from './upstream-queue'
import type { ClientConfig } from '~/clients'
import type { AccountRuntime } from '~/state'
import type { ModelCache } from '~/state/model-cache'

import consola from 'consola'
import { CopilotClient, getVSCodeVersion } from '~/clients'
import { getOrCreateRequestCorrelation } from '~/lib/request-logger'
import { getCurrentAccountRuntime, getRequestAccountName } from '~/state'
import { getConfiguredAccountRuntimes } from '~/state/account-runtime'
import { buildGitHubUrls } from './ghe-domain'
import { createDefaultUpstreamRequestQueue } from './upstream-queue'

interface AccountQueue {
  queue: ReturnType<typeof createDefaultUpstreamRequestQueue>
  options: Partial<UpstreamRequestQueueOptions>
}

let upstreamRequestQueueOptions: Partial<UpstreamRequestQueueOptions> = {}
const accountQueues = new WeakMap<AccountRuntime, AccountQueue>()
const coldModelLoads = new WeakMap<ModelCache, Promise<void>>()
let vsCodeVersionPromise: Promise<string> | undefined

function applyUpstreamRequestQueueOptions(entry: AccountQueue): void {
  entry.queue.updateOptions(upstreamRequestQueueOptions)
  entry.options = upstreamRequestQueueOptions
}

function getUpstreamRequestQueue() {
  const runtime = getCurrentAccountRuntime()
  const existing = accountQueues.get(runtime)
  if (existing) {
    // A runtime warmed up outside the committed table may have missed a broadcast.
    if (existing.options !== upstreamRequestQueueOptions)
      applyUpstreamRequestQueueOptions(existing)
    return existing.queue
  }

  const queue = createDefaultUpstreamRequestQueue(upstreamRequestQueueOptions)
  accountQueues.set(runtime, { queue, options: upstreamRequestQueueOptions })
  return queue
}

export function configureUpstreamRequestQueue(
  options: Partial<UpstreamRequestQueueOptions>,
): void {
  upstreamRequestQueueOptions = { ...upstreamRequestQueueOptions, ...options }
  for (const runtime of getConfiguredAccountRuntimes()) {
    const existing = accountQueues.get(runtime)
    if (existing)
      applyUpstreamRequestQueueOptions(existing)
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
    upstream: runtime.auth.upstream,
    m365Endpoint: runtime.auth.m365Endpoint,
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
    runtime,
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

async function waitForColdModelLoad(load: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await load.catch(() => {})
    return
  }

  signal.throwIfAborted()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const onAbort = () => reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  void load.then(resolve, () => resolve())
  try {
    await promise
    signal.throwIfAborted()
  }
  finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export async function cacheModels(
  client?: CopilotClient,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const { models } = getCurrentAccountRuntime()
  if (models.getModels()?.data.length) {
    const response = await (client ?? createCopilotClient()).getModels(options)
    models.cacheModels(response)
    return
  }

  let pending = coldModelLoads.get(models)
  while (pending) {
    await waitForColdModelLoad(pending, options.signal)
    if (models.getModels()?.data.length)
      return
    pending = coldModelLoads.get(models)
  }

  options.signal?.throwIfAborted()
  const load = (client ?? createCopilotClient()).getModels(options).then((response) => {
    models.cacheModels(response)
  }).finally(() => coldModelLoads.delete(models))
  coldModelLoads.set(models, load)
  await load
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
