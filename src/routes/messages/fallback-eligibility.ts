import type { FallbackEligibility } from '~/pipeline/fallback-eligibility'
import type { AnthropicMessagesPayload } from '~/translator'
import type { Model } from '~/types'

import {
  checkFallbackRequirements,
  containsVisionPart,
  hasTools,
  requestsReasoningEffort,
} from '~/pipeline/fallback-eligibility'
import { hasOutputConfigFormat } from '~/transform/sanitize'
import { resolveMessagesStrategyName } from './strategy-registry'

export function checkMessagesFallbackTarget(
  payload: AnthropicMessagesPayload,
  target: Model,
): FallbackEligibility {
  const tools = hasTools(payload.tools)
  const thinkingType = payload.thinking?.type
  const requirements = checkFallbackRequirements({
    tools,
    // Anthropic tool use is parallel by default, so tools alone require it.
    parallelToolCalls: tools,
    streaming: payload.stream === true,
    vision: containsVisionPart(payload.messages),
    reasoningEffort: requestsReasoningEffort(payload.output_config?.effort),
    thinking: thinkingType === 'enabled' || thinkingType === 'adaptive',
  }, target)
  if (!requirements.ok)
    return requirements

  // Ask the registry which strategy the target lands on for this exact
  // payload: Chat Completions Fallback rejects structured output.
  if (
    hasOutputConfigFormat(payload)
    && resolveMessagesStrategyName(target, payload) === 'chat-completions'
  ) {
    return { ok: false, reason: 'unsupported-structured-output' }
  }
  return { ok: true }
}
