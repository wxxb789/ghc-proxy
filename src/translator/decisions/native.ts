import type { DecisionsRequest, DecisionsResponse } from '~/types'

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
 * gets a unique placeholder that `restoreNativeDecisionsNames` maps back.
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

/**
 * Pass the upstream response through, restoring the public names replaced by
 * placeholders. Answers are otherwise returned exactly as upstream sent them.
 */
export function restoreNativeDecisionsNames(
  raw: unknown,
  placeholders: Map<string, string | null>,
): DecisionsResponse {
  if (
    placeholders.size === 0
    || typeof raw !== 'object'
    || raw === null
    || !('answers' in raw)
    || !Array.isArray(raw.answers)
  ) {
    return raw as DecisionsResponse
  }

  return {
    ...raw,
    answers: raw.answers.map((answer: unknown) => {
      if (
        typeof answer === 'object'
        && answer !== null
        && 'name' in answer
        && typeof answer.name === 'string'
        && placeholders.has(answer.name)
      ) {
        return { ...answer, name: placeholders.get(answer.name) }
      }
      return answer
    }),
  } as DecisionsResponse
}
