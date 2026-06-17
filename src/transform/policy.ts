import type { ModelTransformStep } from './types'
import type { AnthropicMessagesPayload } from '~/translator'

import { applyMessagesModelPolicy } from '~/lib/request-model-policy'
import { CONTEXT_BETA_RE } from './constants'

export const modelPolicyStep: ModelTransformStep = {
  tag: 'POLICY',
  apply({ payload, meta }) {
    // A context-* beta signals the client wants extended context — skip
    // compact small-model routing for it. Copilot doesn't understand the
    // header; it is stripped separately in processAnthropicBetaHeader.
    const betaUpgraded = meta?.betaHeaders?.some(b => CONTEXT_BETA_RE.test(b)) ?? false
    const routing = applyMessagesModelPolicy(payload as AnthropicMessagesPayload, { betaUpgraded })
    if (!routing.reason)
      return null
    return {
      model: routing.routedModel,
      tag: 'COMPACT',
    }
  },
}
