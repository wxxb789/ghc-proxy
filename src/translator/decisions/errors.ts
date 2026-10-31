import type { DecisionsQuestionMapping } from './mapping'
import type { HTTPErrorBody } from '~/lib/error'

import { HTTPError } from '~/lib/error'

const MAX_ERROR_MESSAGE = 500
const MAX_ERROR_DETAILS = 20
const MAX_ERROR_BODY = 64_000
const SAFE_TOKEN_RE = /^[\w.:-]{1,64}$/
const NUMERIC_RE = /^\d+$/

function boundedMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    return fallback
  return value.length > MAX_ERROR_MESSAGE
    ? `${value.slice(0, MAX_ERROR_MESSAGE)}…`
    : value
}

function errorTypeForStatus(status: number): string {
  if (status === 401)
    return 'authentication_error'
  if (status === 403)
    return 'permission_error'
  if (status === 404)
    return 'not_found_error'
  if (status === 408)
    return 'timeout_error'
  if (status === 429)
    return 'rate_limit_error'
  if (status === 529)
    return 'overloaded_error'
  if (status >= 500)
    return 'server_error'
  return 'invalid_request_error'
}

function mapQuestionPath(
  location: unknown,
  questions: Array<DecisionsQuestionMapping> | undefined,
): string | undefined {
  if (!questions || !Array.isArray(location))
    return undefined

  const questionIndex = location.indexOf('questions')
  if (questionIndex < 0)
    return undefined

  const key = location[questionIndex + 1]
  if (typeof key !== 'string')
    return undefined

  const mappingIndex = questions.findIndex(question => question.key === key)
  if (mappingIndex < 0)
    return undefined

  const mapping = questions[mappingIndex]
  const criteriaIndex = location.indexOf('criteria', questionIndex + 2)
  const criterion = criteriaIndex >= 0 ? location[criteriaIndex + 1] : undefined

  if (mapping.choiceValues && typeof criterion === 'string') {
    const choiceIndex = mapping.choiceValues.findIndex(choice => choice.key === criterion)
    if (choiceIndex >= 0)
      return `questions[${mappingIndex}].choices[${choiceIndex}]`
  }

  if (mapping.scoreLabels && typeof criterion === 'string' && NUMERIC_RE.test(criterion)) {
    const levelIndex = Number(criterion)
    if (levelIndex < mapping.scoreLabels.length)
      return `questions[${mappingIndex}].levels[${levelIndex}]`
  }

  return `questions[${mappingIndex}]`
}

interface DetailInput {
  loc?: unknown
  msg?: unknown
  type?: unknown
}

function readValidationDetails(
  value: unknown,
  questions: Array<DecisionsQuestionMapping> | undefined,
  fallbackMessage: string,
): { details: Array<{ path: string, message: string, code?: string }>, firstPath?: string } {
  const items = Array.isArray(value)
    ? value.filter((item): item is DetailInput =>
        typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    : []
  const details: Array<{ path: string, message: string, code?: string }> = []

  for (const item of items.slice(0, MAX_ERROR_DETAILS)) {
    const path = mapQuestionPath(item.loc, questions)
    const message = boundedMessage(item.msg, fallbackMessage)
    const code = typeof item.type === 'string' && SAFE_TOKEN_RE.test(item.type)
      ? item.type
      : undefined
    if (path)
      details.push({ path, message, ...(code ? { code } : {}) })
    else
      details.push({ path: 'body', message, ...(code ? { code } : {}) })
  }

  return {
    details,
    firstPath: details.find(detail => detail.path.startsWith('questions['))?.path,
  }
}

/**
 * Convert a System One error response into the OpenAI Decisions envelope before
 * any shared upstream logger can inspect the body. Rejected evidence never
 * reaches the log or the wire.
 */
export async function normalizeDecisionsUpstreamError(
  message: string,
  response: Response,
  questions?: Array<DecisionsQuestionMapping>,
): Promise<HTTPError> {
  let raw = ''
  try {
    raw = await response.text()
  }
  catch {
    raw = ''
  }

  let parsed: unknown
  if (raw.length > 0 && raw.length <= MAX_ERROR_BODY) {
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      parsed = undefined
    }
  }

  let errorMessage = message
  let param: string | undefined
  let code: string | undefined
  let details: Array<{ path: string, message: string, code?: string }> = []

  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const body = parsed as Record<string, unknown>
    const structured = body.error
    if (typeof structured === 'object' && structured !== null && !Array.isArray(structured)) {
      const error = structured as Record<string, unknown>
      errorMessage = boundedMessage(error.message, message)
      if (typeof error.param === 'string' && SAFE_TOKEN_RE.test(error.param))
        param = error.param
      if (typeof error.code === 'string' && SAFE_TOKEN_RE.test(error.code))
        code = error.code
    }
    else if (typeof body.detail === 'string') {
      errorMessage = boundedMessage(body.detail, message)
    }
    else if (Array.isArray(body.detail)) {
      const mapped = readValidationDetails(body.detail, questions, message)
      details = mapped.details
      param = mapped.firstPath
      code = 'upstream_validation_error'
    }
    else if (typeof body.detail === 'object' && body.detail !== null && !Array.isArray(body.detail)) {
      errorMessage = boundedMessage('message' in body.detail ? body.detail.message : undefined, message)
    }
  }

  const error: HTTPErrorBody['error'] = {
    message: errorMessage,
    type: errorTypeForStatus(response.status),
    ...(param ? { param } : {}),
    ...(code ? { code } : {}),
    ...(details.length > 0 ? { details } : {}),
  }

  const retryAfter = response.headers.get('retry-after')
  return new HTTPError(
    response.status,
    { error },
    retryAfter ? { headers: { 'retry-after': retryAfter } } : undefined,
  )
}
