import type { FallbackEligibility } from '~/pipeline/fallback-eligibility'
import type { ChatCompletionsPayload, Model } from '~/types'

import {
  asRecord,
  checkFallbackRequirements,
  containsVisionPart,
  hasTools,
  requestsReasoningEffort,
} from '~/pipeline/fallback-eligibility'

export function checkChatCompletionsFallbackTarget(
  payload: ChatCompletionsPayload,
  target: Model,
): FallbackEligibility {
  const requirements = checkFallbackRequirements({
    tools: hasTools(payload.tools),
    // Not part of the typed payload; the loose ingest schema passes it through.
    parallelToolCalls: asRecord(payload)?.parallel_tool_calls === true,
    streaming: payload.stream === true,
    vision: containsVisionPart(payload.messages),
    reasoningEffort: requestsReasoningEffort(payload.reasoning_effort),
    thinking: typeof payload.thinking_budget === 'number' && payload.thinking_budget > 0,
  }, target)
  if (!requirements.ok)
    return requirements

  const formatType = asRecord(payload.response_format)?.type
  if (
    formatType !== undefined
    && formatType !== 'text'
    && !target.capabilities.supports.structured_outputs
  ) {
    return { ok: false, reason: 'unsupported-structured-output' }
  }
  return { ok: true }
}
