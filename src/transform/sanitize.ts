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

// Canonical Anthropic effort ordering: low < medium < high < xhigh < max.
// `xhigh` (added in Opus 4.7) sits between `high` and `max`. The array index is
// used as the rank when clamping an unsupported effort down to a model's
// highest advertised level, so this order must match the upstream ranking.
const OUTPUT_CONFIG_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
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

export function hasOutputConfigFormat(payload: AnthropicMessagesPayload | undefined): boolean {
  return payload?.output_config?.format != null
}

// Heuristic mapping from Anthropic classic `budget_tokens` to an adaptive
// `output_config.effort`. The result is clamped against the model's advertised
// efforts by `sanitizeOutputConfig` afterwards, so this only needs to pick a
// sensible tier from the requested budget.
function budgetTokensToEffort(budget: number): OutputConfigEffort {
  if (budget >= 24000) {
    return 'high'
  }
  if (budget >= 8000) {
    return 'medium'
  }
  return 'low'
}

/**
 * Models whose upstream `/v1/messages` endpoint only accepts the adaptive
 * thinking API reject the classic `thinking.type: "enabled"` shape with a 400.
 * Convert `enabled` → `adaptive` (+ derive `output_config.effort` from the
 * requested `budget_tokens`) for those models before forwarding. Models that
 * do not advertise `adaptive_thinking` keep the classic `enabled` shape.
 *
 * Must run before `sanitizeOutputConfig` so the derived effort is normalized
 * against the model's advertised efforts.
 */
export function convertEnabledThinkingToAdaptive(
  payload: AnthropicMessagesPayload,
  model: Model | undefined,
): void {
  if (payload.thinking?.type !== 'enabled') {
    return
  }
  if (!modelCache.supportsAdaptiveThinking(model)) {
    return
  }

  const budget = payload.thinking.budget_tokens
  payload.thinking = { type: 'adaptive' }

  // Only derive an effort for models that accept output_config; sanitizeOutputConfig
  // would otherwise strip the injected object right afterwards for reject-list models.
  if (payload.output_config?.effort == null && modelCache.supportsOutputConfig(model)) {
    payload.output_config = {
      ...payload.output_config,
      effort: budgetTokensToEffort(budget),
    }
  }
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
