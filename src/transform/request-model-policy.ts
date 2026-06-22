import type { AnthropicMessagesPayload } from '~/translator'
import type { Model } from '~/types'

import { configStore, modelCache } from '~/state'

const COMPACT_SYSTEM_PROMPT_START
  = 'You are a helpful AI assistant tasked with summarizing conversations'

export interface ModelRoutingResult {
  originalModel: string
  routedModel: string
  reason?: 'compact'
}

export function applyMessagesModelPolicy(
  payload: AnthropicMessagesPayload,
  options?: { betaUpgraded?: boolean },
): ModelRoutingResult {
  const originalModel = payload.model

  // Beta header requested extended context — skip compact routing. The user
  // explicitly requested extended context.
  if (options?.betaUpgraded) {
    return { originalModel, routedModel: originalModel }
  }

  // Small-model routing (compact) requires a configured smallModel and enabled flag.
  const smallModel = configStore.getSmallModel()
  if (!smallModel || !configStore.isCompactSmallModelEnabled() || !isCompactRequest(payload)) {
    return { originalModel, routedModel: originalModel }
  }

  const originalSelection = modelCache.findById(originalModel)
  const smallSelection = modelCache.findById(smallModel)

  if (canRouteToSmallModel(payload, originalSelection, smallSelection)) {
    payload.model = smallModel
    return {
      originalModel,
      routedModel: smallModel,
      reason: 'compact',
    }
  }

  return { originalModel, routedModel: originalModel }
}

export function isCompactRequest(payload: AnthropicMessagesPayload): boolean {
  if (typeof payload.system === 'string') {
    return payload.system.startsWith(COMPACT_SYSTEM_PROMPT_START)
  }
  if (!Array.isArray(payload.system)) {
    return false
  }
  return payload.system.some(
    block => typeof block.text === 'string'
      && block.text.startsWith(COMPACT_SYSTEM_PROMPT_START),
  )
}

function canRouteToSmallModel(
  payload: AnthropicMessagesPayload,
  originalModel: Model | undefined,
  smallModel: Model | undefined,
): boolean {
  if (!originalModel || !smallModel) {
    return false
  }

  const originalEndpoints = new Set(originalModel.supported_endpoints ?? [])
  const smallEndpoints = new Set(smallModel.supported_endpoints ?? [])
  for (const endpoint of originalEndpoints) {
    if (!smallEndpoints.has(endpoint)) {
      return false
    }
  }

  if (payload.tools?.length && !(smallModel.capabilities.supports.tool_calls ?? false)) {
    return false
  }

  if (payload.thinking && !(smallModel.capabilities.supports.adaptive_thinking ?? false)) {
    return false
  }

  if (hasVisionInput(payload) && !(smallModel.capabilities.supports.vision ?? false)) {
    return false
  }

  return true
}

function hasVisionInput(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.some(message => containsVisionContent(message.content))
}

function containsVisionContent(content: AnthropicMessagesPayload['messages'][number]['content']): boolean {
  if (!Array.isArray(content)) {
    return false
  }

  return content.some(block => block.type === 'image')
}
