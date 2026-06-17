import consola from 'consola'

import { configStore, modelCache } from '~/state'

// ── Types ──

export interface ModelRewriteResult {
  model: string
  originalModel: string
  reason?: 'AUTO_CORRECT' | 'CONFIG_REWRITE'
}

// ── Pre-request rewriting ──

/**
 * Unified model rewrite: user rules → built-in normalization → pass-through.
 * Call once at handler entry, before any model lookup or policy.
 */
export function rewriteModel(modelId: string): ModelRewriteResult {
  // 1. User-configured rules (first match wins)
  const userRules = configStore.getModelRewrites()
  if (userRules.length > 0) {
    for (const rule of userRules) {
      if (matchesGlob(rule.from, modelId)) {
        const target = normalizeToKnownModel(rule.to) ?? rule.to
        return { originalModel: modelId, model: target, reason: 'CONFIG_REWRITE' }
      }
    }
  }

  // 2. Built-in normalization (dash/dot equivalence)
  const normalized = normalizeToKnownModel(modelId)
  if (normalized && normalized !== modelId) {
    return { originalModel: modelId, model: normalized, reason: 'AUTO_CORRECT' }
  }

  // 3. Pass-through
  return { originalModel: modelId, model: modelId }
}

/**
 * Apply model rewrite to a mutable model field and log if changed.
 * Returns the rewrite result for downstream use.
 */
export function applyModelRewrite(payload: { model: string }): ModelRewriteResult {
  const result = rewriteModel(payload.model)
  if (result.model !== result.originalModel) {
    consola.debug(`Model rewritten: ${result.originalModel} ~> ${result.model}`)
    payload.model = result.model
  }
  return result
}

// ── Built-in normalization ──

const DOT_RE = /\./g

/**
 * Resolve a model ID against Copilot's cached model list using
 * dash/dot equivalence. Returns the canonical ID if found.
 */
function normalizeToKnownModel(modelId: string): string | undefined {
  const models = modelCache.getModels()?.data
  if (!models)
    return undefined

  // Fast path: exact match
  if (models.some(m => m.id === modelId))
    return modelId

  const normalized = modelId.replace(DOT_RE, '-')
  for (const model of models) {
    if (model.id.replace(DOT_RE, '-') === normalized)
      return model.id
  }
  return undefined
}

// ── Glob matching ──

const GLOB_SPECIAL_RE = /[.+^${}()|[\]\\]/g
const GLOB_STAR_RE = /\*/g

function matchesGlob(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) {
    return pattern === value
  }
  const regex = new RegExp(
    `^${pattern.replace(GLOB_SPECIAL_RE, '\\$&').replace(GLOB_STAR_RE, '.*')}$`,
  )
  return regex.test(value)
}
