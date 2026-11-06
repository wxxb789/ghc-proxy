import process from 'node:process'

import { getCachedConfig } from './config'

export interface ModelFallbackConfig {
  claudeOpus: string
  claudeSonnet: string
  claudeHaiku: string
}

export const DEFAULT_FALLBACKS: ModelFallbackConfig = {
  claudeOpus: 'claude-opus-5.5',
  claudeSonnet: 'claude-sonnet-5.5',
  claudeHaiku: 'claude-haiku-5.5',
}

// Previous built-in defaults, used only when the cached model list advertises
// them and omits the current default.
const LEGACY_FALLBACKS: ModelFallbackConfig = {
  claudeOpus: 'claude-opus-5',
  claudeSonnet: 'claude-sonnet-5',
  claudeHaiku: 'claude-haiku-4.5',
}

const FALLBACK_ENV_VARS: Record<keyof ModelFallbackConfig, string> = {
  claudeOpus: 'MODEL_FALLBACK_CLAUDE_OPUS',
  claudeSonnet: 'MODEL_FALLBACK_CLAUDE_SONNET',
  claudeHaiku: 'MODEL_FALLBACK_CLAUDE_HAIKU',
}

export function getModelFallbackConfig(
  knownModelIds?: ReadonlySet<string>,
): ModelFallbackConfig {
  const cachedConfig = getCachedConfig()
  const resolveFamily = (family: keyof ModelFallbackConfig): string => {
    const configured = process.env[FALLBACK_ENV_VARS[family]]
      || cachedConfig.modelFallback?.[family]
    if (configured)
      return configured
    const current = DEFAULT_FALLBACKS[family]
    const legacy = LEGACY_FALLBACKS[family]
    return knownModelIds && !knownModelIds.has(current) && knownModelIds.has(legacy)
      ? legacy
      : current
  }

  return {
    claudeOpus: resolveFamily('claudeOpus'),
    claudeSonnet: resolveFamily('claudeSonnet'),
    claudeHaiku: resolveFamily('claudeHaiku'),
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
  if (modelId.startsWith('claude-opus-'))
    return config.claudeOpus
  if (modelId.startsWith('claude-sonnet-'))
    return config.claudeSonnet
  if (modelId.startsWith('claude-haiku-'))
    return config.claudeHaiku
  return modelId
}
