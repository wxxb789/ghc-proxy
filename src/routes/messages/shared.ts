import { AnthropicMessagesAdapter } from '~/adapters'
import { inferModelFamily } from '~/core/capi'
import { getModelFallbackConfig, resolveModel } from '~/lib/model-resolver'
import { modelCache } from '~/state'

/**
 * Creates a shared AnthropicMessagesAdapter with standard model resolution
 * and capability detection. Used by both messages handler and count-tokens handler.
 */
export function createAnthropicAdapter(): AnthropicMessagesAdapter {
  const models = modelCache.getModels()
  const knownModelIds = models
    ? new Set(models.data.map(model => model.id))
    : undefined
  const fallbackConfig = getModelFallbackConfig()

  return new AnthropicMessagesAdapter({
    modelResolver: (model: string) => resolveModel(model, knownModelIds, fallbackConfig),
    getModelCapabilities: model => ({
      supportsThinkingBudget: inferModelFamily(model) === 'claude',
    }),
  })
}
