import type { Model } from '~/types'
import { configStore, modelCache, RESPONSES_ENDPOINT } from '~/state'

export function resolveResponsesStrategyName(model: Model | undefined): 'responses-passthrough' | 'responses-chat-completions' | undefined {
  if (modelCache.supportsEndpoint(model, RESPONSES_ENDPOINT))
    return 'responses-passthrough'
  if (configStore.isResponsesChatCompletionsFallbackEnabled()
    && modelCache.supportsEndpoint(model, '/chat/completions')) {
    return 'responses-chat-completions'
  }
  return undefined
}
