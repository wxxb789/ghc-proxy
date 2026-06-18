import { composeModelTransforms } from './chain'
import { modelPolicyStep } from './policy'
import { rewriteStep } from './rewrite'

export { processAnthropicBetaHeader } from './beta-headers'
export type { BetaHeaderResult } from './beta-headers'
export type { ModelTransformChain } from './chain'
export { normalizeOutputConfigEffort } from './sanitize'
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
