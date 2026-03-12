import type {
  ResponseContextManagementCompactionItem,
  ResponseInputItem,
  ResponsesPayload,
} from '~/types'

import { isResponsesApiContextManagementModel } from '~/lib/config'

/** Default token threshold when model limits are unknown. */
const DEFAULT_COMPACT_THRESHOLD = 50_000
/** Fraction of max prompt tokens to use as compact threshold. */
const COMPACT_THRESHOLD_RATIO = 0.9

export function getResponsesRequestOptions(
  payload: ResponsesPayload,
): { vision: boolean, initiator: 'user' | 'agent' } {
  return {
    vision: hasVisionInput(payload),
    initiator: hasAgentInitiator(payload) ? 'agent' : 'user',
  }
}

export function hasAgentInitiator(payload: ResponsesPayload): boolean {
  const lastItem = getPayloadItems(payload).at(-1)
  if (!lastItem) {
    return false
  }
  if (!('role' in lastItem) || !lastItem.role) {
    return true
  }
  return String(lastItem.role).toLowerCase() === 'assistant'
}

export function hasVisionInput(payload: ResponsesPayload): boolean {
  return getPayloadItems(payload).some(item => containsVisionContent(item))
}

export function resolveResponsesCompactThreshold(
  maxPromptTokens?: number,
): number {
  if (typeof maxPromptTokens === 'number' && maxPromptTokens > 0) {
    return Math.floor(maxPromptTokens * COMPACT_THRESHOLD_RATIO)
  }
  return DEFAULT_COMPACT_THRESHOLD
}

function createCompactionContextManagement(
  compactThreshold: number,
): Array<ResponseContextManagementCompactionItem> {
  return [{
    type: 'compaction',
    compact_threshold: compactThreshold,
  }]
}

export function applyContextManagement(
  payload: ResponsesPayload,
  maxPromptTokens?: number,
): void {
  if (payload.context_management !== undefined) {
    return
  }
  if (!isResponsesApiContextManagementModel(payload.model)) {
    return
  }

  payload.context_management = createCompactionContextManagement(
    resolveResponsesCompactThreshold(maxPromptTokens),
  )
}

export function compactInputByLatestCompaction(
  payload: ResponsesPayload,
): void {
  if (!Array.isArray(payload.input) || payload.input.length === 0) {
    return
  }

  const latestCompactionMessageIndex = getLatestCompactionMessageIndex(payload.input)
  if (latestCompactionMessageIndex === undefined) {
    return
  }

  payload.input = payload.input.slice(latestCompactionMessageIndex)
}

function getLatestCompactionMessageIndex(
  input: Array<ResponseInputItem>,
): number | undefined {
  for (let index = input.length - 1; index >= 0; index--) {
    if (isCompactionInputItem(input[index])) {
      return index
    }
  }
}

function isCompactionInputItem(value: ResponseInputItem): boolean {
  return 'type' in value && value.type === 'compaction'
}

function getPayloadItems(payload: ResponsesPayload): Array<ResponseInputItem> {
  return Array.isArray(payload.input) ? payload.input : []
}

function containsVisionContent(value: unknown): boolean {
  if (!value) {
    return false
  }
  if (Array.isArray(value)) {
    return value.some(entry => containsVisionContent(entry))
  }
  if (typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>
  if (record.type === 'input_image') {
    return true
  }
  if (Array.isArray(record.content)) {
    return record.content.some(entry => containsVisionContent(entry))
  }
  return false
}
