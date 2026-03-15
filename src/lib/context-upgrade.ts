import { HTTPError } from './error'
import { findModelById } from './model-capabilities'

/** Data-driven upgrade rules. Add new entries to extend. */
const CONTEXT_UPGRADE_RULES: ReadonlyArray<{
  from: string
  to: string
  tokenThreshold: number
}> = [
  { from: 'claude-opus-4.6', to: 'claude-opus-4.6-1m', tokenThreshold: 190_000 },
]

/** Pre-computed set for fast model eligibility checks (avoids token estimation on non-eligible models). */
const UPGRADE_ELIGIBLE_MODELS = new Set(CONTEXT_UPGRADE_RULES.map(r => r.from))

/**
 * Quick check: does this model have any context-upgrade rules?
 * Use to skip expensive token estimation for ineligible models.
 */
export function hasContextUpgradeRule(model: string): boolean {
  return UPGRADE_ELIGIBLE_MODELS.has(model)
}

/** Find the upgrade rule for a model whose target exists in Copilot's model list. */
function findUpgradeRule(model: string) {
  for (const rule of CONTEXT_UPGRADE_RULES) {
    if (model === rule.from && findModelById(rule.to)) {
      return rule
    }
  }
  return undefined
}

/**
 * Proactive: resolve the upgrade target model for a given model + token count.
 * Returns the target model ID, or undefined if no upgrade applies.
 */
export function resolveContextUpgrade(
  model: string,
  estimatedTokens: number,
): string | undefined {
  const rule = findUpgradeRule(model)
  if (rule && estimatedTokens > rule.tokenThreshold) {
    return rule.to
  }
  return undefined
}

/**
 * Reactive: get the upgrade target for a model on context-length error.
 * Returns the target model ID, or undefined if no fallback applies.
 */
export function getContextUpgradeTarget(model: string): string | undefined {
  return findUpgradeRule(model)?.to
}

/** Context-length error detection with pattern matching */
const CONTEXT_ERROR_PATTERNS = [
  /context.length/i,
  /too.long/i,
  /token.*(limit|maximum|exceed)/i,
  /(limit|maximum|exceed).*token/i,
]

export function isContextLengthError(error: unknown): boolean {
  if (!(error instanceof HTTPError) || error.status !== 400) {
    return false
  }
  const message = error.body?.error?.message
  return message ? CONTEXT_ERROR_PATTERNS.some(pattern => pattern.test(message)) : false
}
