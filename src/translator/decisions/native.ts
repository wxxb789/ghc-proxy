import type { DecisionsRequest, DecisionsResponse } from '~/types'

import { z } from 'zod'

import { nonNegativeIntegerSchema } from '~/ingest/validation/shared'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'

const nativeAnswerSchema = z.object({
  type: z.enum(['predicate', 'choice', 'score', 'refusal']),
  name: z.string().nullable().optional(),
})

const nativeResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.unknown(),
  usage: z.object({ input_tokens: nonNegativeIntegerSchema, output_tokens: nonNegativeIntegerSchema }),
})

export interface NativeDecisionsRequest {
  upstream: DecisionsRequest
  /** Placeholder name sent upstream → the public `name` it stands in for. */
  placeholders: Map<string, string | null>
}

/**
 * Prepare a request for a model served natively on Copilot `/v1/decisions`.
 * The public body is forwarded unchanged except for the resolved model id and
 * question names: the Copilot gateway answers an opaque `400 Bad Request` when
 * any question has no name, an empty name, or a name already used by another
 * question, although the public contract allows all three. Each such question
 * gets a unique placeholder that `restoreNativeDecisionsResponse` maps back.
 */
export function buildNativeDecisionsRequest(
  payload: DecisionsRequest,
  model: string,
): NativeDecisionsRequest {
  const kept = new Set<string>()
  const keepName = payload.questions.map((question) => {
    if (!question.name || kept.has(question.name))
      return false
    kept.add(question.name)
    return true
  })

  const placeholders = new Map<string, string | null>()
  const questions = payload.questions.map((question, index) => {
    if (keepName[index])
      return question
    let placeholder = `q${index}`
    while (kept.has(placeholder) || placeholders.has(placeholder))
      placeholder = `_${placeholder}`
    placeholders.set(placeholder, question.name ?? null)
    return { ...question, name: placeholder }
  })

  return {
    upstream: { ...payload, model, questions },
    placeholders,
  }
}

function hasValidAnswers(answers: unknown, questionCount: number): boolean {
  if (!Array.isArray(answers) || answers.length !== questionCount)
    return false
  for (let index = 0; index < answers.length; index++) {
    if (!nativeAnswerSchema.safeParse(answers[index]).success)
      return false
  }
  return true
}

/**
 * Pass the upstream response through, restoring the public names replaced by
 * placeholders. Answers are otherwise returned exactly as upstream sent them.
 */
export function restoreNativeDecisionsResponse(
  raw: unknown,
  { upstream, placeholders }: NativeDecisionsRequest,
): DecisionsResponse {
  const parsed = nativeResponseSchema.safeParse(raw)
  if (!parsed.success || !hasValidAnswers(parsed.data.answers, upstream.questions.length)) {
    throw new TranslationFailure('Upstream decisions response has an invalid shape.', {
      status: 502,
      kind: 'invalid_upstream_decisions_response',
    })
  }

  const response = raw as DecisionsResponse
  if (placeholders.size === 0)
    return response

  return {
    ...response,
    answers: response.answers.map((answer) => {
      if (typeof answer.name === 'string' && placeholders.has(answer.name))
        return { ...answer, name: placeholders.get(answer.name) ?? null }
      return answer
    }),
  }
}
