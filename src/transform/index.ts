import { composeModelTransforms } from './chain'
import { modelPolicyStep } from './policy'
import { rewriteStep } from './rewrite'

export { processAnthropicBetaHeader } from './beta-headers'
export type { BetaHeaderResult } from './beta-headers'
export { composeModelTransforms } from './chain'
export type { ModelTransformChain } from './chain'
export { modelPolicyStep } from './policy'
export { rewriteStep } from './rewrite'
export {
  filterThinkingBlocksForNativeMessages,
  hasOutputConfigFormat,
  normalizeOutputConfigEffort,
  sanitizeCacheControl,
  sanitizeOutputConfig,
} from './sanitize'
export type { ModelTransformInput, ModelTransformOutput, ModelTransformStep } from './types'

export const messagesModelChain = composeModelTransforms(
  rewriteStep,
  modelPolicyStep,
)

export const chatCompletionsModelChain = composeModelTransforms(
  rewriteStep,
)

export const responsesModelChain = composeModelTransforms(
  rewriteStep,
)
