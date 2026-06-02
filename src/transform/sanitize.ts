import type { AnthropicMessagesPayload } from '~/translator'
import type { Model } from '~/types'

import { modelCache } from '~/state'
import { SignatureCodec } from '~/translator/responses/signature-codec'

export function filterThinkingBlocksForNativeMessages(
  anthropicPayload: AnthropicMessagesPayload,
): void {
  for (const message of anthropicPayload.messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue
    }
    message.content = message.content.filter((block) => {
      if (block.type !== 'thinking') {
        return true
      }
      return Boolean(
        block.thinking
        && block.thinking !== 'Thinking...'
        && block.signature
        && !SignatureCodec.isReasoningSignature(block.signature)
        && !SignatureCodec.isCompactionSignature(block.signature),
      )
    })
  }
}

const OUTPUT_CONFIG_EFFORTS = ['low', 'medium', 'high', 'max', 'xhigh'] as const
type OutputConfigEffort = typeof OUTPUT_CONFIG_EFFORTS[number]

const OUTPUT_CONFIG_EFFORT_RANK = new Map<OutputConfigEffort, number>(
  OUTPUT_CONFIG_EFFORTS.map((effort, index) => [effort, index]),
)

function isOutputConfigEffort(value: string): value is OutputConfigEffort {
  return OUTPUT_CONFIG_EFFORT_RANK.has(value as OutputConfigEffort)
}

export function normalizeOutputConfigEffort(
  effort: OutputConfigEffort,
  model: Model | undefined,
): OutputConfigEffort | undefined {
  const supportedEfforts = model?.capabilities.supports.reasoning_effort
    ?.filter(isOutputConfigEffort)
  if (!supportedEfforts?.length) {
    return undefined
  }

  if (supportedEfforts.includes(effort)) {
    return effort
  }

  return supportedEfforts.reduce((highest, current) => {
    const highestRank = OUTPUT_CONFIG_EFFORT_RANK.get(highest) ?? -1
    const currentRank = OUTPUT_CONFIG_EFFORT_RANK.get(current) ?? -1
    return currentRank > highestRank ? current : highest
  })
}

export function sanitizeOutputConfig(
  payload: AnthropicMessagesPayload,
  model: Model | undefined,
): void {
  if (!payload.output_config) {
    return
  }

  if (!modelCache.supportsOutputConfig(model)) {
    delete payload.output_config
    return
  }

  const effort = payload.output_config.effort
  if (effort == null) {
    delete payload.output_config
    return
  }

  payload.output_config = {
    effort: normalizeOutputConfigEffort(effort, model) ?? effort,
  }
}

function normalizeCacheControlBlock(obj: Record<string, unknown>): void {
  if (obj.cache_control && typeof obj.cache_control === 'object') {
    obj.cache_control = { type: (obj.cache_control as Record<string, unknown>).type }
  }
}

export function sanitizeCacheControl(payload: AnthropicMessagesPayload): void {
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      normalizeCacheControlBlock(block as unknown as Record<string, unknown>)
    }
  }

  for (const message of payload.messages) {
    normalizeCacheControlBlock(message as unknown as Record<string, unknown>)
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        normalizeCacheControlBlock(block as unknown as Record<string, unknown>)
      }
    }
  }

  if (payload.tools) {
    for (const tool of payload.tools) {
      normalizeCacheControlBlock(tool as unknown as Record<string, unknown>)
    }
  }
}
