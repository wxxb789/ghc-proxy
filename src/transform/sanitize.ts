import type { AnthropicMessagesPayload } from '~/translator'
import type { Model } from '~/types'

import consola from 'consola'
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
  return clampEffortToAdvertised(
    effort,
    model?.capabilities.supports.reasoning_effort,
  )
}

/**
 * Clamp an effort to the highest level a model actually advertises.
 *
 * Probed 2026-07-26 (`scripts/probes/effort-and-tokens.ts`): a model rejects
 * every level it does not advertise, and the levels are NOT an ordered ladder
 * every model implements a prefix of — `claude-opus-4.6` and
 * `claude-sonnet-4.6` advertise `max` but not `xhigh`, and reject `xhigh` while
 * accepting `max`. So the target must be derived from the advertised list, not
 * from a fixed fallback.
 *
 * Levels outside the Anthropic `output_config` vocabulary (`none`, `minimal`)
 * are filtered out first: they are valid clamp *inputs* on the Responses
 * boundary but never valid clamp *targets*, since silently landing on `none`
 * would disable reasoning the caller asked for.
 *
 * Returns undefined when the model advertises nothing usable, which callers
 * treat as "leave the request alone".
 */
export function clampEffortToAdvertised(
  effort: OutputConfigEffort,
  advertised: Array<string> | undefined,
): OutputConfigEffort | undefined {
  const supportedEfforts = advertised?.filter(isOutputConfigEffort)
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

/**
 * Whether {@link reduceOutputFormatForNativeMessages} can produce a
 * native-acceptable format without dropping a caller guarantee.
 *
 * Split from the reducer so strategy selection stays a pure predicate.
 */
export function canReduceOutputFormatForNativeMessages(
  payload: AnthropicMessagesPayload | undefined,
): boolean {
  const format = payload?.output_config?.format
  return !format || (format.strict === undefined && format.description === undefined)
}

/**
 * Reduce `output_config.format` to the shape Copilot's native `/v1/messages`
 * accepts.
 *
 * Probed 2026-07-26 (`scripts/probes/messages/output-format.ts`): native
 * Messages serves a bare `{ type, schema }` on every model that advertises
 * `structured_outputs`, but rejects every optional Anthropic annotation —
 * `output_config.format.name: Extra inputs are not permitted`, same for
 * `description` and `strict`. The Anthropic schema allows all three, so a
 * caller can legitimately send them.
 *
 * Only `name` is dropped here, and only because it is a pure label: Anthropic
 * documents no effect on the reply, and the Responses translator has to invent
 * one when the caller omits it. `description` and `strict` both influence the
 * reply — one guides the model's output, the other promises the schema is
 * enforced — so {@link canReduceOutputFormatForNativeMessages} keeps those
 * requests off this path entirely rather than quietly reducing them here.
 */
export function reduceOutputFormatForNativeMessages(
  payload: AnthropicMessagesPayload,
): void {
  const format = payload.output_config?.format
  if (!format || format.name === undefined) {
    return
  }

  payload.output_config = {
    ...payload.output_config,
    format: { type: format.type, schema: format.schema },
  }
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
/**
 * Normalize `output_config` for the native `/v1/messages` boundary.
 *
 * Rebuilds nothing it does not have to: the effort is clamped in place and
 * every other key is preserved. `output_config` is loose at ingress precisely
 * so newer Anthropic fields can reach a model that may accept them — dropping
 * them here would move the failure from a visible 400 to a silent semantic
 * change, which is worse.
 */
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
    // A null effort is a no-op, but the object may still carry `format` — the
    // usual shape of a structured-output request, which sends no effort at all.
    // Deleting the container here would drop the caller's schema silently.
    if (payload.output_config.format) {
      delete payload.output_config.effort
      return
    }
    delete payload.output_config
    return
  }

  payload.output_config.effort = normalizeOutputConfigEffort(effort, model) ?? effort
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

/**
 * Drop `top_p` when `temperature` is also present.
 *
 * Copilot's native `/v1/messages` endpoint rejects the pair outright for
 * non-reasoning Claude models:
 *
 *   `temperature` and `top_p` cannot both be specified for this model.
 *   Please use only one.
 *
 * Probed 2026-07-26 (`scripts/probes/sampling-params.ts`): reproduced on
 * claude-sonnet-4.5 and claude-haiku-4.5; every reasoning model accepted both.
 * Rather than leak a 400 for a combination clients send routinely, the proxy
 * keeps `temperature` — the more widely used control, and the one both the
 * Anthropic and OpenAI defaults are expressed in — and drops `top_p`.
 *
 * Applied unconditionally on this boundary: models that accept the pair are
 * unaffected in practice, since sending only `temperature` is always valid.
 */
export function sanitizeExclusiveSamplingParams(payload: AnthropicMessagesPayload): void {
  if (payload.temperature === undefined || payload.top_p === undefined) {
    return
  }

  consola.warn(
    `Dropped top_p=${payload.top_p}: Copilot rejects temperature and top_p together on /v1/messages. `
    + `Keeping temperature=${payload.temperature}.`,
  )
  delete payload.top_p
}
