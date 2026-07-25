import type { ModelMappingInfo, ModelTransformTag } from '~/lib/request-logger'
import type { AnthropicMessagesPayload } from '~/translator'
import type { Model } from '~/types'

import { modelCache } from '~/state'
import { CONTEXT_BETA_RE } from './constants'
import { applyModelRewrite } from './model-rewrite'
import { applyMessagesModelPolicy } from './request-model-policy'

export interface ResolveRequestModelInput {
  /** Mutated in place: `model` is updated to the resolved id. */
  payload: { model: string }
  betaHeaders?: Array<string>
  /**
   * Whether to apply compact small-model routing. Only `/v1/messages` carries
   * the Anthropic-shaped payload that policy inspects; the other routes pass
   * `false`.
   */
  applyPolicy?: boolean
}

export interface ResolveRequestModelResult {
  /** Final model id after all transforms. */
  model: string
  /** Cached model record for `model`, if Copilot advertises it. */
  resolvedModel: Model | undefined
  /** Request-log trace: the original id plus one entry per transform. */
  modelMapping: ModelMappingInfo
}

/**
 * Resolve the model a request should be dispatched with.
 *
 * Applies, in order:
 * 1. model rewrite -- user `modelRewrites` rules, then dash/dot normalization
 * 2. compact small-model routing -- only when `applyPolicy` is set
 * 3. lookup against the cached Copilot model list
 *
 * Order is load-bearing: policy inspects `payload.model`, so the rewrite must
 * be written back to the payload before policy runs. Both steps mutate
 * `payload.model` directly, which is also what dispatch reads downstream.
 */
export function resolveRequestModel(
  { payload, betaHeaders, applyPolicy }: ResolveRequestModelInput,
): ResolveRequestModelResult {
  const originalModel = payload.model
  const steps: ModelMappingInfo['steps'] = []

  const rewrite = applyModelRewrite(payload)
  if (rewrite.reason) {
    steps.push({
      tag: rewrite.reason satisfies ModelTransformTag,
      from: originalModel,
      to: rewrite.model,
    })
  }

  if (applyPolicy) {
    // A context-* beta signals the client wants extended context -- skip
    // compact small-model routing for it. Copilot doesn't understand the
    // header; it is stripped separately in processAnthropicBetaHeader.
    const betaUpgraded = betaHeaders?.some(b => CONTEXT_BETA_RE.test(b)) ?? false
    const routing = applyMessagesModelPolicy(
      payload as AnthropicMessagesPayload,
      { betaUpgraded },
    )
    if (routing.reason) {
      steps.push({
        tag: 'COMPACT',
        from: routing.originalModel,
        to: routing.routedModel,
      })
      payload.model = routing.routedModel
    }
  }

  return {
    model: payload.model,
    resolvedModel: modelCache.findById(payload.model),
    modelMapping: { originalModel, steps },
  }
}
