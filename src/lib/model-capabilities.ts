import type { Model } from '~/types'

import { state } from './state'

export const RESPONSES_ENDPOINT = '/responses' as const
export const MESSAGES_ENDPOINT = '/v1/messages' as const

export function findModelById(
  modelId: string,
): Model | undefined {
  return state.cache.models?.data.find(model => model.id === modelId)
}

export function modelSupportsEndpoint(
  model: Model | undefined,
  endpoint: string,
): boolean {
  return model?.supported_endpoints?.includes(endpoint) ?? false
}

export function modelSupportsToolCalls(
  model: Model | undefined,
): boolean {
  return model?.capabilities.supports.tool_calls ?? false
}

export function modelSupportsAdaptiveThinking(
  model: Model | undefined,
): boolean {
  return model?.capabilities.supports.adaptive_thinking ?? false
}

export function modelSupportsVision(
  model: Model | undefined,
): boolean {
  return model?.capabilities.supports.vision ?? false
}

/**
 * Models whose upstream `/v1/messages` endpoint rejects the `output_config`
 * field with "Extra inputs are not permitted".
 *
 * Verified via `scripts/probe-all-models-output-config.ts` (2026-03-14).
 * When new models appear, re-run the probe and update this list.
 */
const MODELS_REJECTING_OUTPUT_CONFIG = new Set([
  'claude-sonnet-4',
  'claude-sonnet-4.5',
  'claude-haiku-4.5',
])

export function modelSupportsOutputConfig(
  model: Model | undefined,
): boolean {
  if (!model)
    return true
  return !MODELS_REJECTING_OUTPUT_CONFIG.has(model.id)
}

export function getModelVisionLimits(
  model: Model | undefined,
): Model['capabilities']['limits']['vision'] | undefined {
  return model?.capabilities.limits.vision
}
