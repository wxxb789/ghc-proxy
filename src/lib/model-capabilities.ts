import type { Model } from '~/types'

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

export function getModelVisionLimits(
  model: Model | undefined,
): Model['capabilities']['limits']['vision'] | undefined {
  return model?.capabilities.limits.vision
}
