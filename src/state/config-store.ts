import type { ReasoningEffort } from '~/lib/config'

import {
  DEFAULT_COMPACT_USE_SMALL_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_RESPONSES_API_AUTO_COMPACT_INPUT,
  DEFAULT_RESPONSES_API_AUTO_CONTEXT_MANAGEMENT,
  DEFAULT_RESPONSES_API_PARAMETER_FILTERS_REPLACE_DEFAULT,
  DEFAULT_RESPONSES_OFFICIAL_EMULATOR,
  DEFAULT_RESPONSES_OFFICIAL_EMULATOR_TTL_SECONDS,
  DEFAULT_USE_FUNCTION_APPLY_PATCH,
  getCachedConfig,
} from '~/lib/config'

export class ConfigStore {
  isEmulatorEnabled(): boolean {
    return getCachedConfig().responsesOfficialEmulator ?? DEFAULT_RESPONSES_OFFICIAL_EMULATOR
  }

  getEmulatorTtlSeconds(): number {
    return getCachedConfig().responsesOfficialEmulatorTtlSeconds ?? DEFAULT_RESPONSES_OFFICIAL_EMULATOR_TTL_SECONDS
  }

  isCompactSmallModelEnabled(): boolean {
    return getCachedConfig().compactUseSmallModel ?? DEFAULT_COMPACT_USE_SMALL_MODEL
  }

  getSmallModel(): string | undefined {
    return getCachedConfig().smallModel?.trim() || undefined
  }

  isFunctionApplyPatchEnabled(): boolean {
    return getCachedConfig().useFunctionApplyPatch ?? DEFAULT_USE_FUNCTION_APPLY_PATCH
  }

  isAutoCompactResponsesInputEnabled(): boolean {
    return getCachedConfig().responsesApiAutoCompactInput ?? DEFAULT_RESPONSES_API_AUTO_COMPACT_INPUT
  }

  isContextManagementEnabled(): boolean {
    return getCachedConfig().responsesApiAutoContextManagement ?? DEFAULT_RESPONSES_API_AUTO_CONTEXT_MANAGEMENT
  }

  isContextManagementModel(model: string): boolean {
    if (!this.isContextManagementEnabled()) {
      return false
    }
    return getCachedConfig().responsesApiContextManagementModels?.includes(model) ?? false
  }

  getReasoningEffort(model: string): ReasoningEffort {
    return getCachedConfig().modelReasoningEfforts?.[model] ?? DEFAULT_REASONING_EFFORT
  }

  getResponsesParameterFilters(): Array<{ models: Array<string>, params: Array<string> }> {
    return getCachedConfig().responsesApiParameterFilters ?? []
  }

  shouldReplaceDefaultParameterFilters(): boolean {
    return getCachedConfig().responsesApiParameterFiltersReplaceDefault
      ?? DEFAULT_RESPONSES_API_PARAMETER_FILTERS_REPLACE_DEFAULT
  }

  getModelRewrites(): Array<{ from: string, to: string }> {
    return getCachedConfig().modelRewrites ?? []
  }

  getModelFallback() {
    return getCachedConfig().modelFallback
  }
}

export const configStore = new ConfigStore()
