import type { ModelTransformOutput, ModelTransformStep } from './types'

import { applyModelRewrite } from './model-rewrite'

export const rewriteStep: ModelTransformStep = {
  tag: 'rewrite',
  apply(input): ModelTransformOutput | null {
    const payload = input.payload as { model: string }
    const original = payload.model
    payload.model = input.model
    let result: ReturnType<typeof applyModelRewrite>
    try {
      result = applyModelRewrite(payload)
    }
    finally {
      payload.model = original
    }

    if (!result.reason) {
      return null
    }

    return {
      model: result.model,
      tag: result.reason,
      mutatePayload: (p) => {
        ;(p as { model: string }).model = result.model
      },
    }
  },
}
