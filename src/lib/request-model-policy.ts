import type { AnthropicMessagesPayload } from '~/translator'
import type { Model } from '~/types'

import { getSmallModel, shouldCompactUseSmallModel, shouldWarmupUseSmallModel } from './config'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsToolCalls,
  modelSupportsVision,
} from './model-capabilities'
import { state } from './state'

const COMPACT_SYSTEM_PROMPT_START
  = 'You are a helpful AI assistant tasked with summarizing conversations'
const WARMUP_BETA_MARKERS = ['warmup', 'probe', 'preflight']

export interface ModelRoutingResult {
  originalModel: string
  routedModel: string
  reason?: 'compact' | 'warmup'
}

export function applyMessagesModelPolicy(
  payload: AnthropicMessagesPayload,
  anthropicBetaHeader: string | undefined,
): ModelRoutingResult {
  const originalModel = payload.model
  const smallModel = getSmallModel()
  if (!smallModel) {
    return { originalModel, routedModel: originalModel }
  }

  const originalSelection = findModel(originalModel)
  const smallSelection = findModel(smallModel)

  if (
    shouldCompactUseSmallModel()
    && isCompactRequest(payload)
    && canRouteToSmallModel(payload, originalSelection, smallSelection)
  ) {
    payload.model = smallModel
    return {
      originalModel,
      routedModel: smallModel,
      reason: 'compact',
    }
  }

  if (
    shouldWarmupUseSmallModel()
    && isWarmupRequest(payload, anthropicBetaHeader)
    && canRouteToSmallModel(payload, originalSelection, smallSelection)
  ) {
    payload.model = smallModel
    return {
      originalModel,
      routedModel: smallModel,
      reason: 'warmup',
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

export function isWarmupRequest(
  payload: AnthropicMessagesPayload,
  anthropicBetaHeader: string | undefined,
): boolean {
  if (!anthropicBetaHeader || isCompactRequest(payload)) {
    return false
  }

  const normalizedBeta = anthropicBetaHeader.toLowerCase()
  if (!WARMUP_BETA_MARKERS.some(marker => normalizedBeta.includes(marker))) {
    return false
  }

  if (payload.system !== undefined || payload.thinking !== undefined) {
    return false
  }

  if (payload.tools && payload.tools.length > 0) {
    return false
  }

  if (payload.max_tokens > 64) {
    return false
  }

  return hasSingleShortUserTextMessage(payload)
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

  if (payload.tools?.length && !modelSupportsToolCalls(smallModel)) {
    return false
  }

  if (payload.thinking && !modelSupportsAdaptiveThinking(smallModel)) {
    return false
  }

  if (hasVisionInput(payload) && !modelSupportsVision(smallModel)) {
    return false
  }

  return true
}

function hasSingleShortUserTextMessage(payload: AnthropicMessagesPayload): boolean {
  if (payload.messages.length !== 1) {
    return false
  }

  const [message] = payload.messages
  if (message.role !== 'user') {
    return false
  }

  if (typeof message.content === 'string') {
    return message.content.trim().length > 0 && message.content.length <= 64
  }

  if (message.content.length !== 1 || message.content[0]?.type !== 'text') {
    return false
  }

  const text = message.content[0].text.trim()
  return text.length > 0 && text.length <= 64
}

function findModel(modelId: string): Model | undefined {
  return state.cache.models?.data.find(model => model.id === modelId)
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
