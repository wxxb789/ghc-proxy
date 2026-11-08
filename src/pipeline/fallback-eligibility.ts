import type { Model } from '~/types'

import { modelCache } from '~/state'

/**
 * Whether an overload-fallback target can serve a request. A rejection's
 * `reason` becomes the decision of the `fallback` recovery event.
 */
export type FallbackEligibility
  = | { ok: true }
    | { ok: false, reason: string }

/**
 * What a request explicitly asks of the model serving it. Each pipeline
 * endpoint derives these from its own payload shape; matching them against
 * advertised target capabilities is shared.
 */
export interface FallbackRequirements {
  tools: boolean
  parallelToolCalls: boolean
  streaming: boolean
  vision: boolean
  reasoningEffort: boolean
  thinking: boolean
}

export function checkFallbackRequirements(
  requirements: FallbackRequirements,
  target: Model,
): FallbackEligibility {
  if (requirements.tools && !modelCache.supportsToolCalls(target))
    return { ok: false, reason: 'unsupported-tools' }
  if (
    requirements.parallelToolCalls
    && target.capabilities.supports.parallel_tool_calls !== true
  ) {
    return { ok: false, reason: 'unsupported-parallel-tools' }
  }
  if (requirements.streaming && target.capabilities.supports.streaming === false)
    return { ok: false, reason: 'unsupported-streaming' }
  if (requirements.vision && !modelCache.supportsVision(target))
    return { ok: false, reason: 'unsupported-vision' }
  if (requirements.reasoningEffort && !modelCache.supportsReasoningEffort(target))
    return { ok: false, reason: 'unsupported-reasoning' }
  if (
    requirements.thinking
    && !modelCache.supportsAdaptiveThinking(target)
    && !modelCache.supportsReasoningEffort(target)
  ) {
    return { ok: false, reason: 'unsupported-thinking' }
  }
  return { ok: true }
}

export function hasTools(tools: unknown): boolean {
  return Array.isArray(tools) && tools.length > 0
}

/** Any requested effort other than an explicit `none` needs effort support. */
export function requestsReasoningEffort(effort: unknown): boolean {
  return effort !== undefined && effort !== 'none'
}

export function containsVisionPart(value: unknown): boolean {
  if (Array.isArray(value))
    return value.some(containsVisionPart)
  const record = asRecord(value)
  if (!record)
    return false
  if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image')
    return true
  return containsVisionPart(record.content)
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
