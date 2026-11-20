import type { DecisionsQuestionMapping } from './mapping'
import type { HTTPErrorBody } from '~/lib/error'

import { HTTPError, withTranslationErrors } from '~/lib/error'
import { isTimeoutLikeError } from '~/lib/timeout-error'
import { ClientAbortError, isClientAbortError } from '~/lib/upstream-signal'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'

const MAX_ERROR_MESSAGE = 500
const MAX_ERROR_DETAILS = 20
const MAX_ERROR_BODY = 64_000
const SAFE_TOKEN_RE = /^[\w.:-]{1,64}$/
const NUMERIC_RE = /^\d+$/
// System One reports some validation failures as a plain `detail` string that
// names the internal question key and the upstream validator.
const DETAIL_QUESTION_RE = /question "(q\d+)"/
const NATIVE_DETAIL_QUESTION_RE = /question "([^"\r\n]{1,200})"/
const NATIVE_PARAM_RE = /^(?:questions|state)(?:\.[^\r\n]{1,240})?$/u
const DETAIL_VALIDATOR_PREFIX_RE = /^invalid TypeSafe request: /

export async function callDecisionsUpstream(
  call: () => Promise<unknown>,
  callerSignal: AbortSignal,
  message: string,
  kind: 'invalid_upstream_decisions_response' | 'invalid_upstream_systemone_response',
): Promise<unknown> {
  try {
    return await call()
  }
  catch (error) {
    // A bare AbortError from a cancelled body read has no marker. Tag it
    // before the shared error mapper so caller aborts aren't recorded as
    // failures and deadline aborts stay timeout-shaped.
    if (error instanceof DOMException && error.name === 'AbortError' && callerSignal.aborted)
      throw new ClientAbortError()
    if (error instanceof SyntaxError) {
      withTranslationErrors(() => {
        throw new TranslationFailure(message, { status: 502, kind })
      })
    }
    throw error
  }
}

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
/**
 * Map a System One `error.param` onto the public Decisions shape. Internal
 * paths (`state`, `questions.qN[.criteria.xN]`) never cross the boundary as-is:
 * a public client cannot locate `state` or a `qN` key in the request it sent.
 * Unmappable params are dropped rather than leaked.
 */
function mapStructuredParam(
  value: string,
  questions: Array<DecisionsQuestionMapping> | undefined,
): string | undefined {
  if (!SAFE_TOKEN_RE.test(value))
    return undefined
  if (value === 'state')
    return 'input'
  if (!value.startsWith('questions.'))
    return undefined
  const location = value.split('.')
  return mapQuestionPath(location, questions)
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

/**
 * Rewrite a string `detail` so it names the public question index instead of
 * the internal `qN` key, and report that index as the error param.
 */
function mapDetailString(
  detail: string,
  questions: Array<DecisionsQuestionMapping> | undefined,
): { message: string, param?: string } {
  const key = DETAIL_QUESTION_RE.exec(detail)?.[1]
  const param = key ? mapQuestionPath(['questions', key], questions) : undefined
  let message = detail.replace(DETAIL_VALIDATOR_PREFIX_RE, 'invalid decisions request: ')
  if (key && param)
    message = message.replace(`question "${key}"`, param)
  return { message, ...(param ? { param } : {}) }
}

function nativeDetailPath(location: unknown): string | undefined {
  if (!Array.isArray(location))
    return undefined
  const start = location.findIndex(part => part === 'questions' || part === 'state')
  if (start < 0 || location.length - start > 20)
    return undefined
  const parts: Array<string> = []
  for (const part of location.slice(start)) {
    if (typeof part === 'string' && part.length <= 240)
      parts.push(part)
    else if (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0)
      parts.push(String(part))
    else
      return undefined
  }
  const path = parts.join('.')
  return NATIVE_PARAM_RE.test(path) ? path : undefined
}

interface DetailInput {
  loc?: unknown
  msg?: unknown
  type?: unknown
}

function readValidationDetails(
  value: unknown,
  mapPath: (location: unknown) => string | undefined,
  fallbackMessage: string,
): { details: Array<{ path: string, message: string, code?: string }>, firstPath?: string } {
  const items = Array.isArray(value)
    ? value.filter((item): item is DetailInput =>
        typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    : []
  const details: Array<{ path: string, message: string, code?: string }> = []

  for (const item of items.slice(0, MAX_ERROR_DETAILS)) {
    const path = mapPath(item.loc)
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
    firstPath: details.find(detail => detail.path !== 'body')?.path,
  }
}

interface UpstreamErrorMapper {
  mapStructuredParam: (value: string) => string | undefined
  mapDetailString: (detail: string) => { message: string, param?: string }
  mapDetailPath: (location: unknown) => string | undefined
}

const systemOneErrorMapper: UpstreamErrorMapper = {
  mapStructuredParam: value => NATIVE_PARAM_RE.test(value) ? value : undefined,
  mapDetailString(detail) {
    const key = NATIVE_DETAIL_QUESTION_RE.exec(detail)?.[1]
    return { message: detail, ...(key !== undefined ? { param: `questions.${key}` } : {}) }
  },
  mapDetailPath: nativeDetailPath,
}

async function readErrorBody(response: Response): Promise<string> {
  if (!response.body || response.bodyUsed)
    return response.text()

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let oversized = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done)
        break
      // Drain the remainder without decoding so later aborts/timeouts still surface.
      if (oversized)
        continue
      for (let offset = 0; offset < value.length; offset += 8192) {
        const chunk = decoder.decode(value.subarray(offset, offset + 8192), { stream: true })
        if (text.length + chunk.length > MAX_ERROR_BODY) {
          oversized = true
          text = ''
          break
        }
        text += chunk
      }
    }
    return oversized ? '' : text + decoder.decode()
  }
  finally {
    reader.releaseLock()
  }
}

async function normalizeUpstreamError(
  message: string,
  response: Response,
  mapper: UpstreamErrorMapper,
): Promise<HTTPError> {
  let raw = ''
  try {
    raw = await readErrorBody(response)
  }
  catch (error) {
    if (
      isClientAbortError(error) || isTimeoutLikeError(error)
      || (error instanceof DOMException && error.name === 'AbortError')
    ) {
      throw error
    }
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
      if (typeof error.param === 'string')
        param = mapper.mapStructuredParam(error.param)
      if (typeof error.code === 'string' && SAFE_TOKEN_RE.test(error.code))
        code = error.code
    }
    else if (typeof body.detail === 'string') {
      const mapped = mapper.mapDetailString(body.detail)
      errorMessage = boundedMessage(mapped.message, message)
      param = mapped.param
    }
    else if (Array.isArray(body.detail)) {
      const mapped = readValidationDetails(body.detail, mapper.mapDetailPath, message)
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

export function normalizeDecisionsUpstreamError(
  message: string,
  response: Response,
  questions?: Array<DecisionsQuestionMapping>,
): Promise<HTTPError> {
  return normalizeUpstreamError(message, response, {
    mapStructuredParam: value => mapStructuredParam(value, questions),
    mapDetailString: detail => mapDetailString(detail, questions),
    mapDetailPath: location => mapQuestionPath(location, questions),
  })
}

export function normalizeSystemOneUpstreamError(message: string, response: Response): Promise<HTTPError> {
  return normalizeUpstreamError(message, response, systemOneErrorMapper)
}
