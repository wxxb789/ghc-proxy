import { AnthropicMessagesAdapter } from '~/adapters'
import { M365_FALLBACKS } from '~/clients/m365-upstream'
import { inferModelFamily } from '~/core/capi'
import { getModelFallbackConfig, resolveModel } from '~/lib/model-resolver'
import { authStore, modelCache } from '~/state'

/**
 * Creates a shared AnthropicMessagesAdapter with standard model resolution
 * and capability detection. Used by both messages handler and count-tokens handler.
 */
export function createAnthropicAdapter(): AnthropicMessagesAdapter {
  const models = modelCache.getModels()
  const knownModelIds = models
    ? new Set(models.data.map(model => model.id))
    : undefined
  // The GitHub defaults name models the M365 gateway rejects, so that upstream
  // resolves through its own catalog instead.
  const fallbackConfig = authStore.upstream === 'm365'
    ? M365_FALLBACKS
    : getModelFallbackConfig(knownModelIds)

  return new AnthropicMessagesAdapter({
    modelResolver: (model: string) => resolveModel(model, knownModelIds, fallbackConfig),
    getModelCapabilities: model => ({
      supportsThinkingBudget: inferModelFamily(model) === 'claude',
    }),
  })
}
