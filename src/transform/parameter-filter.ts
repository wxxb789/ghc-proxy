import type { Model, ResponsesPayload } from '~/types'

import consola from 'consola'

import { configStore, modelCache } from '~/state'
import { matchesGlob } from './model-rewrite'

/**
 * Parameters the default rule strips for reasoning models on the Responses
 * boundary. Reasoning models (gpt-5 family, o-series, codex) reject sampling
 * parameters upstream with a 400 "Unsupported parameter" error, so the proxy
 * drops them instead of leaking the incompatibility to the client.
 */
const DEFAULT_REASONING_UNSUPPORTED_PARAMS = ['temperature', 'top_p'] as const

/**
 * Models that accept a parameter the blanket reasoning rule would otherwise
 * strip. Probed 2026-07-26 (`scripts/probes/sampling-params.ts`): every
 * `/responses` reasoning model rejected `temperature`, but `gpt-5.3-codex`
 * accepted `top_p` (200) while its siblings returned
 * `Unsupported parameter: 'top_p' is not supported with this model`.
 *
 * Copilot does not advertise per-parameter support — `capabilities.supports`
 * is byte-identical across gpt-5.3-codex, gpt-5.4 and gpt-5.4-mini — so this
 * cannot be derived and has to be an evidence-backed glob list. Re-run the
 * probe when new models appear.
 */
const REASONING_PARAM_EXEMPTIONS: Array<{ models: Array<string>, params: Array<string> }> = [
  { models: ['*-codex', '*-codex-*'], params: ['top_p'] },
]

/**
 * A reasoning model is any model that advertises one or more
 * `reasoning_effort` levels. This dynamically covers the full reasoning
 * family (mini, codex, future point releases) without a hardcoded ID list.
 */
export function isReasoningModel(model: Model | undefined): boolean {
  return modelCache.supportsReasoningEffort(model)
}

/**
 * Resolve the set of request parameters to strip for a given model on the
 * Responses boundary.
 *
 * Rule composition:
 * 1. Built-in default: reasoning models strip {@link DEFAULT_REASONING_UNSUPPORTED_PARAMS}.
 *    Disabled entirely when `responsesApiParameterFiltersReplaceDefault` is true.
 * 2. User rules (`responsesApiParameterFilters`): every rule whose `models`
 *    glob matches the resolved model id contributes its `params`.
 *
 * The result is the union of all matching rules, so user rules ADD to the
 * default. Setting `responsesApiParameterFiltersReplaceDefault: true` disables
 * the default so user rules fully OVERWRITE it.
 */
export function resolveStrippedResponsesParams(model: Model | undefined): Set<string> {
  const params = new Set<string>()
  const modelId = model?.id

  if (!configStore.shouldReplaceDefaultParameterFilters() && isReasoningModel(model)) {
    const exempt = modelId ? resolveReasoningExemptions(modelId) : new Set<string>()
    for (const param of DEFAULT_REASONING_UNSUPPORTED_PARAMS) {
      if (!exempt.has(param)) {
        params.add(param)
      }
    }
  }

  if (modelId) {
    for (const rule of configStore.getResponsesParameterFilters()) {
      if (rule.models.some(pattern => matchesGlob(pattern, modelId))) {
        for (const param of rule.params) {
          params.add(param)
        }
      }
    }
  }

  return params
}

/**
 * Params the default reasoning rule must NOT strip for this model.
 *
 * Exemptions only narrow the built-in default — a user rule naming the same
 * param still strips it, so an operator can always be more conservative than
 * the probe evidence.
 */
function resolveReasoningExemptions(modelId: string): Set<string> {
  const exempt = new Set<string>()
  for (const rule of REASONING_PARAM_EXEMPTIONS) {
    if (rule.models.some(pattern => matchesGlob(pattern, modelId))) {
      for (const param of rule.params) {
        exempt.add(param)
      }
    }
  }
  return exempt
}

/**
 * Strip unsupported parameters from a Responses payload before dispatch.
 * Keys are deleted entirely (never set to null) because upstream rejects the
 * mere presence of the key, not just non-null values.
 */
export function applyResponsesParameterFilters(
  payload: ResponsesPayload,
  model: Model | undefined,
): void {
  const strip = resolveStrippedResponsesParams(model)
  if (strip.size === 0) {
    return
  }

  const removed: Array<string> = []
  for (const key of strip) {
    if (key in payload) {
      delete payload[key]
      removed.push(key)
    }
  }

  if (removed.length > 0) {
    consola.debug(
      `Stripped unsupported responses params for model ${model?.id}: ${removed.join(', ')}`,
    )
  }
}
