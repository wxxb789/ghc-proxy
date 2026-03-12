import { AnthropicMessagesAdapter } from '~/adapters'
import { getModelFallbackConfig, resolveModel } from '~/lib/model-resolver'
import { state } from '~/lib/state'

/**
 * Creates a shared AnthropicMessagesAdapter with standard model resolution
 * and capability detection. Used by both messages handler and count-tokens handler.
 */
export function createAnthropicAdapter(): AnthropicMessagesAdapter {
  const knownModelIds = state.cache.models
    ? new Set(state.cache.models.data.map(model => model.id))
    : undefined
  const fallbackConfig = getModelFallbackConfig()

  return new AnthropicMessagesAdapter({
    modelResolver: (model: string) => resolveModel(model, knownModelIds, fallbackConfig),
    getModelCapabilities: model => ({
      supportsThinkingBudget: model.startsWith('claude'),
    }),
  })
}
