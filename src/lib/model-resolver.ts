import { getCachedConfig } from "./config"

export interface ModelFallbackConfig {
  claudeOpus: string
  claudeSonnet: string
  claudeHaiku: string
}

export const DEFAULT_FALLBACKS: ModelFallbackConfig = {
  claudeOpus: "claude-opus-4.6",
  claudeSonnet: "claude-sonnet-4.5",
  claudeHaiku: "claude-haiku-4.5",
}

export function getModelFallbackConfig(): ModelFallbackConfig {
  const cachedConfig = getCachedConfig()
  return {
    claudeOpus:
      process.env.MODEL_FALLBACK_CLAUDE_OPUS
      || cachedConfig.modelFallback?.claudeOpus
      || DEFAULT_FALLBACKS.claudeOpus,
    claudeSonnet:
      process.env.MODEL_FALLBACK_CLAUDE_SONNET
      || cachedConfig.modelFallback?.claudeSonnet
      || DEFAULT_FALLBACKS.claudeSonnet,
    claudeHaiku:
      process.env.MODEL_FALLBACK_CLAUDE_HAIKU
      || cachedConfig.modelFallback?.claudeHaiku
      || DEFAULT_FALLBACKS.claudeHaiku,
  }
}

export function resolveModel(
  modelId: string,
  knownModelIds: Set<string> | undefined,
  config: ModelFallbackConfig,
): string {
  if (knownModelIds?.has(modelId)) {
    return modelId
  }
  if (modelId.startsWith("claude-opus-")) return config.claudeOpus
  if (modelId.startsWith("claude-sonnet-")) return config.claudeSonnet
  if (modelId.startsWith("claude-haiku-")) return config.claudeHaiku
  return modelId
}
