import type { FallbackEligibility } from '~/pipeline/fallback-eligibility'
import type { Model, ResponsesPayload } from '~/types'

import {
  checkFallbackRequirements,
  containsVisionPart,
  hasTools,
  requestsReasoningEffort,
} from '~/pipeline/fallback-eligibility'
import { resolveResponsesStrategyName } from './capabilities'

export function checkResponsesFallbackTarget(
  payload: ResponsesPayload,
  target: Model,
): FallbackEligibility {
  const strategy = resolveResponsesStrategyName(target)
  if (!strategy)
    return { ok: false, reason: 'unsupported-endpoint' }

  const requirements = checkFallbackRequirements({
    tools: hasTools(payload.tools),
    parallelToolCalls: payload.parallel_tool_calls === true,
    streaming: payload.stream === true,
    vision: containsVisionPart(payload.input),
    reasoningEffort: requestsReasoningEffort(payload.reasoning?.effort),
    thinking: false,
  }, target)
  if (!requirements.ok)
    return requirements

  const formatType = payload.text?.format?.type
  // The Chat bridge serves JSON mode as CAPI `json_object`, which needs no
  // structured-output capability.
  const chatJsonMode = strategy === 'responses-chat-completions' && formatType === 'json_object'
  if (
    !chatJsonMode
    && formatType !== undefined
    && formatType !== 'text'
    && !target.capabilities.supports.structured_outputs
  ) {
    return { ok: false, reason: 'unsupported-structured-output' }
  }
  return { ok: true }
}
