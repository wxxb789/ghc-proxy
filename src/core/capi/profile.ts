import type { CapiChatCompletionsPayload } from './types'
import type { ConversationRequest } from '~/core/conversation'
import type { ReasoningEffort } from '~/types'

export interface CapiProfile {
  id: 'base' | 'claude'
  family: 'other' | 'claude' | 'gpt' | 'grok'
  enableCacheControl: boolean
  includeUsageOnStream: boolean
  applyThinking: (
    request: ConversationRequest,
  ) => Pick<CapiChatCompletionsPayload, 'reasoning_effort' | 'thinking_budget'>
}

function inferReasoningEffort(budgetTokens: number): ReasoningEffort {
  if (budgetTokens <= 8000) {
    return 'low'
  }
  if (budgetTokens <= 24000) {
    return 'medium'
  }
  return 'high'
}

/**
 * The effort to send upstream: the level the caller named, else one inferred
 * from the thinking budget.
 *
 * `output_config.effort` used to be dropped entirely on this path — it is not
 * part of the OpenAI chat schema, so the normalizer never read it — which
 * silently downgraded a caller asking for `max` to whatever the budget
 * heuristic produced (`high` at most). Copilot does accept `reasoning_effort`
 * here: probed 2026-07-26, every reasoning Claude model on `/chat/completions`
 * accepts the levels it advertises, `max` included.
 */
function resolveRequestEffort(
  request: ConversationRequest,
  budgetTokens: number,
): ReasoningEffort {
  return request.outputEffort ?? inferReasoningEffort(budgetTokens)
}

export function inferModelFamily(model: string): CapiProfile['family'] {
  if (model.startsWith('claude')) {
    return 'claude'
  }
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) {
    return 'gpt'
  }
  if (model.startsWith('grok')) {
    return 'grok'
  }
  return 'other'
}

const baseProfile: CapiProfile = {
  id: 'base',
  family: 'other',
  enableCacheControl: true,
  includeUsageOnStream: true,
  applyThinking(request) {
    const thinking = request.thinking
    if (thinking?.type === 'disabled') {
      return {}
    }
    if (!thinking) {
      // An explicit effort still applies: the caller can name an effort level
      // without also configuring a thinking budget.
      return request.outputEffort ? { reasoning_effort: request.outputEffort } : {}
    }

    const budgetTokens = thinking.type === 'adaptive'
      ? 24000
      : thinking.budgetTokens

    return {
      reasoning_effort: resolveRequestEffort(request, budgetTokens),
    }
  },
}

const claudeProfile: CapiProfile = {
  id: 'claude',
  family: 'claude',
  enableCacheControl: true,
  includeUsageOnStream: true,
  applyThinking(request) {
    const thinking = request.thinking
    if (thinking?.type === 'disabled') {
      return {}
    }
    if (!thinking) {
      return request.outputEffort ? { reasoning_effort: request.outputEffort } : {}
    }

    const budgetTokens = thinking.type === 'adaptive'
      ? 24000
      : thinking.budgetTokens

    return {
      reasoning_effort: resolveRequestEffort(request, budgetTokens),
      thinking_budget: budgetTokens,
    }
  },
}

export function selectCapiProfile(model: string): CapiProfile {
  return inferModelFamily(model) === 'claude'
    ? claudeProfile
    : baseProfile
}
