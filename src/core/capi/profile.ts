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
  enableCacheControl: false,
  includeUsageOnStream: false,
  applyThinking(request) {
    const thinking = request.thinking
    if (!thinking || thinking.type === 'disabled') {
      return {}
    }

    const budgetTokens = thinking.type === 'adaptive'
      ? 24000
      : thinking.budgetTokens

    return {
      reasoning_effort: inferReasoningEffort(budgetTokens),
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
    if (!thinking || thinking.type === 'disabled') {
      return {}
    }

    const budgetTokens = thinking.type === 'adaptive'
      ? 24000
      : thinking.budgetTokens

    return {
      reasoning_effort: inferReasoningEffort(budgetTokens),
      thinking_budget: budgetTokens,
    }
  },
}

export function selectCapiProfile(model: string): CapiProfile {
  return inferModelFamily(model) === 'claude'
    ? claudeProfile
    : baseProfile
}
