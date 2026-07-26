import type { Model, ModelsResponse } from '~/types'

export const RESPONSES_ENDPOINT = '/responses' as const
export const MESSAGES_ENDPOINT = '/v1/messages' as const

/**
 * Models whose upstream `/v1/messages` endpoint rejects the `output_config`
 * field with "Extra inputs are not permitted".
 *
 * Verified via `scripts/probes/messages/output-config.ts` (2026-03-14); the
 * probe enumerates the live `/models` surface, so this list only ever covers
 * models that existed on the probe date. `claude-sonnet-4` was dropped
 * 2026-07-26 after leaving that surface.
 * When new models appear, re-run the probe and update this list.
 */
const MODELS_REJECTING_OUTPUT_CONFIG = new Set([
  'claude-sonnet-4.5',
  'claude-haiku-4.5',
])

export class ModelCache {
  private models?: ModelsResponse
  private vsCodeVersion?: string

  cacheModels(models: ModelsResponse): void {
    this.models = models
  }

  clearModels(): void {
    this.models = undefined
  }

  getModels(): ModelsResponse | undefined {
    return this.models
  }

  setVSCodeVersion(version: string): void {
    this.vsCodeVersion = version
  }

  clearVSCodeVersion(): void {
    this.vsCodeVersion = undefined
  }

  getVSCodeVersion(): string | undefined {
    return this.vsCodeVersion
  }

  findById(modelId: string): Model | undefined {
    return this.models?.data.find(model => model.id === modelId)
  }

  getModelIds(): Array<string> {
    return this.models?.data.map(model => model.id) ?? []
  }

  supportsEndpoint(model: Model | undefined, endpoint: string): boolean {
    return model?.supported_endpoints?.includes(endpoint) ?? false
  }

  supportsToolCalls(model: Model | undefined): boolean {
    return model?.capabilities.supports.tool_calls ?? false
  }

  supportsAdaptiveThinking(model: Model | undefined): boolean {
    return model?.capabilities.supports.adaptive_thinking ?? false
  }

  supportsVision(model: Model | undefined): boolean {
    return model?.capabilities.supports.vision ?? false
  }

  supportsReasoningEffort(model: Model | undefined): boolean {
    return (model?.capabilities.supports.reasoning_effort?.length ?? 0) > 0
  }

  supportsOutputConfig(model: Model | undefined): boolean {
    if (!model)
      return true
    return !MODELS_REJECTING_OUTPUT_CONFIG.has(model.id)
  }

  supportsStructuredOutputs(model: Model | undefined): boolean {
    return model?.capabilities.supports.structured_outputs ?? false
  }
}

export const modelCache = new ModelCache()
