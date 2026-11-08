import type { CopilotClient } from '~/clients'
import type { UpstreamRecoveryRecord } from '~/clients/upstream-queue'

import { cacheModels, createCopilotClient } from '~/clients/factory'
import { withUpstreamSignal } from '~/lib/upstream-signal'
import { modelCache } from '~/state'

/**
 * Core handler for listing models.
 *
 * `client` is an injection seam for tests; production callers omit it. This
 * route does not go through `runPipeline`, so it constructs its own client on
 * a cache miss and bounds that fetch by the caller signal and upstream
 * deadline.
 */
export async function handleModelsCore(
  client?: CopilotClient,
  recovery?: UpstreamRecoveryRecord,
  signal?: AbortSignal,
  onClientAbort?: () => void,
): Promise<object> {
  if (!modelCache.getModels()) {
    const copilotClient = client ?? createCopilotClient(recovery)
    if (signal) {
      await withUpstreamSignal(signal, onClientAbort, upstreamSignal =>
        cacheModels(copilotClient, { signal: upstreamSignal }))
    }
    else {
      await cacheModels(copilotClient)
    }
  }

  const cached = modelCache.getModels()
  const models = cached?.data.map(model => ({
    id: model.id,
    object: 'model',
    type: 'model',
    created: 0, // No date available from source
    created_at: new Date(0).toISOString(), // No date available from source
    owned_by: model.vendor,
    display_name: model.name,
  }))

  return {
    object: 'list',
    data: models,
    has_more: false,
  }
}
