import type { ProxyEffectId } from './effects'
import type { ModelMappingInfo, ModelTransformStep } from '~/lib/request-logger'

import { isTimeoutLikeError } from '~/lib/timeout-error'
import { effectForModelTransform } from './effects'

export const RECENT_REQUEST_LIMIT = 256

const KNOWN_OBSERVED_ENDPOINTS = new Set([
  '/',
  '/health',
  '/token',
  '/usage',
  '/models',
  '/v1/models',
  '/embeddings',
  '/v1/embeddings',
  '/chat/completions',
  '/v1/chat/completions',
  '/responses',
  '/v1/responses',
  '/responses/input_tokens',
  '/v1/responses/input_tokens',
  '/v1/messages',
  '/v1/messages/count_tokens',
])
const RESPONSE_INPUT_ITEMS_ENDPOINT_RE = /^(\/v1)?\/responses\/[^/]+\/input_items$/
const RESPONSE_RESOURCE_ENDPOINT_RE = /^(\/v1)?\/responses\/[^/]+$/
const OBSERVED_METHOD_RE = /^[A-Z]{1,12}$/
const OBSERVED_MODEL_ID_RE = /^[a-z\d][\w.:/-]{0,127}$/i
const OBSERVED_TAG_RE = /^[a-z\d][\w.:-]{0,63}$/i
const OBSERVED_ERROR_SUMMARY_RE = /^(?:Unhandled proxy error|Upstream timeout|Request validation failed|Unknown endpoint|(?:Upstream )?HTTP [1-5]\d{2}(?: \([\w.:-]{1,64}\))?)$/
const OBSERVED_ERROR_CATEGORIES = new Set([
  'api_error',
  'auth_error',
  'authentication_error',
  'invalid_request_error',
  'not_found_error',
  'overloaded_error',
  'permission_error',
  'rate_limit_error',
  'server_error',
  'timeout_error',
  'translation_error',
  'unsupported_input',
  'upstream_error',
])

export type ObservedRequestState
  = | 'in_flight'
    | 'streaming'
    | 'completed'
    | 'failed'
    | 'aborted'

export type ObservedModelTransform = ModelTransformStep
export type ObservedModelMapping = ModelMappingInfo

export interface ObservedRequest {
  requestId: string
  method: string
  endpoint: string
  state: ObservedRequestState
  startedAt: string
  durationMs: number
  status?: number
  requestedModel?: string
  effectiveModel?: string
  modelTransforms: Array<ObservedModelTransform>
  selectedStrategy?: string
  effects: Array<{ id: ProxyEffectId, count: number }>
  errorSummary?: string
}

interface ActiveRequest extends Omit<ObservedRequest, 'durationMs' | 'effects' | 'startedAt'> {
  startedAtMs: number
  effectCounts: Partial<Record<ProxyEffectId, number>>
}

export interface RequestActivitySnapshot {
  active: Array<ObservedRequest>
  recent: Array<ObservedRequest>
  totals: {
    started: number
    completed: number
    failed: number
    aborted: number
  }
  effectCounts: Partial<Record<ProxyEffectId, number>>
}

export interface RequestActivitySummary {
  active: number
  recent: number
  totals: RequestActivitySnapshot['totals']
  effectCounts: Partial<Record<ProxyEffectId, number>>
}

interface StartRequestInput {
  requestId: string
  method: string
  endpoint: string
  requestedModel?: string
}

class FixedRing<T> {
  private readonly entries: Array<T | undefined>
  private next = 0
  private size = 0

  constructor(capacity: number) {
    this.entries = Array.from({ length: capacity }).fill(undefined) as Array<T | undefined>
  }

  push(value: T): void {
    this.entries[this.next] = value
    this.next = (this.next + 1) % this.entries.length
    this.size = Math.min(this.size + 1, this.entries.length)
  }

  get length(): number {
    return this.size
  }

  newestFirst(): Array<T> {
    const values: Array<T> = []
    for (let offset = 0; offset < this.size; offset++) {
      const index = (this.next - 1 - offset + this.entries.length) % this.entries.length
      const value = this.entries[index]
      if (value !== undefined)
        values.push(value)
    }
    return values
  }

  updateFirst(
    predicate: (value: T) => boolean,
    update: (value: T) => T,
  ): boolean {
    for (let offset = 0; offset < this.size; offset++) {
      const index = (this.next - 1 - offset + this.entries.length) % this.entries.length
      const value = this.entries[index]
      if (value !== undefined && predicate(value)) {
        this.entries[index] = update(value)
        return true
      }
    }
    return false
  }
}

export class RequestActivityStore {
  private readonly active = new Map<string, ActiveRequest>()
  private recent = new FixedRing<ObservedRequest>(RECENT_REQUEST_LIMIT)
  private readonly effectCounts: Partial<Record<ProxyEffectId, number>> = {}
  private readonly effectBuffers = new Map<
    string,
    Partial<Record<ProxyEffectId, number>>
  >()

  private started = 0
  private completed = 0
  private failed = 0
  private aborted = 0
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  start(input: StartRequestInput): void {
    if (this.active.has(input.requestId))
      return

    const startedAtMs = this.now()
    this.active.set(input.requestId, {
      requestId: input.requestId,
      method: sanitizeMethod(input.method),
      endpoint: input.endpoint,
      state: 'in_flight',
      startedAtMs,
      ...(input.requestedModel
        ? { requestedModel: sanitizeModelId(input.requestedModel) }
        : {}),
      modelTransforms: [],
      effectCounts: {},
    })
    this.started++
  }

  recordRequestedModel(requestId: string, model: string): void {
    const request = this.active.get(requestId)
    if (request)
      request.requestedModel = sanitizeModelId(model)
  }

  recordModelMapping(requestId: string, mapping: ObservedModelMapping): void {
    const request = this.active.get(requestId)
    if (!request)
      return

    const previouslyRecordedSteps = request.modelTransforms.length
    request.requestedModel = mapping.originalModel
      ? sanitizeModelId(mapping.originalModel)
      : request.requestedModel
    request.modelTransforms = mapping.steps.map(step => ({
      tag: step.tag,
      from: sanitizeModelId(step.from),
      to: sanitizeModelId(step.to),
    }))
    const effective = request.modelTransforms.at(-1)?.to ?? request.requestedModel
    if (effective)
      request.effectiveModel = effective

    for (const step of mapping.steps.slice(previouslyRecordedSteps)) {
      const effect = effectForModelTransform(step.tag)
      if (effect)
        this.recordEffect(requestId, effect)
    }
  }

  recordStrategy(requestId: string, strategy: string): void {
    const request = this.active.get(requestId)
    if (request)
      request.selectedStrategy = sanitizeTag(strategy)
  }

  beginEffectBuffer(requestId: string): void {
    if (this.active.has(requestId) && !this.effectBuffers.has(requestId))
      this.effectBuffers.set(requestId, {})
  }

  commitEffectBuffer(requestId: string): void {
    const buffer = this.effectBuffers.get(requestId)
    if (!buffer)
      return

    this.effectBuffers.delete(requestId)
    for (const [effect, count] of Object.entries(buffer) as Array<
      [ProxyEffectId, number | undefined]
    >) {
      if (count)
        this.recordEffect(requestId, effect, count)
    }
  }

  discardEffectBuffer(requestId: string): void {
    this.effectBuffers.delete(requestId)
  }

  recordEffect(requestId: string, effect: ProxyEffectId, count = 1): void {
    if (!Number.isFinite(count) || count <= 0)
      return

    const request = this.active.get(requestId)
    if (!request)
      return

    const normalizedCount = Math.floor(count)
    const buffer = this.effectBuffers.get(requestId)
    if (buffer) {
      buffer[effect] = (buffer[effect] ?? 0) + normalizedCount
      return
    }

    this.effectCounts[effect] = (this.effectCounts[effect] ?? 0) + normalizedCount
    request.effectCounts[effect]
      = (request.effectCounts[effect] ?? 0) + normalizedCount
  }

  recordError(requestId: string, summary: string): void {
    const request = this.active.get(requestId)
    if (request)
      request.errorSummary = sanitizeStoredErrorSummary(summary)
  }

  markStreaming(requestId: string): void {
    const request = this.active.get(requestId)
    if (request && request.state !== 'aborted')
      request.state = 'streaming'
  }

  markAborted(requestId: string): void {
    const request = this.active.get(requestId)
    if (request) {
      request.state = 'aborted'
      return
    }

    const reclassified = this.recent.updateFirst(
      request => request.requestId === requestId && request.state === 'completed',
      request => ({ ...request, state: 'aborted' }),
    )
    if (reclassified) {
      this.completed--
      this.aborted++
    }
  }

  complete(requestId: string, status: number): boolean {
    const request = this.active.get(requestId)
    if (!request)
      return false

    this.active.delete(requestId)
    this.effectBuffers.delete(requestId)
    const failed = status >= 400 || request.errorSummary !== undefined
    const aborted = !failed && request.state === 'aborted'
    const completedRequest = projectRequest(
      request,
      Math.max(0, this.now() - request.startedAtMs),
      aborted ? 'aborted' : failed ? 'failed' : 'completed',
      status,
    )
    this.recent.push(completedRequest)
    if (aborted)
      this.aborted++
    else
      this.completed++
    if (failed)
      this.failed++
    return true
  }

  snapshot(): RequestActivitySnapshot {
    const at = this.now()
    const active = [...this.active.values()]
      .toSorted((left, right) => right.startedAtMs - left.startedAtMs)
      .map(request => projectRequest(
        request,
        Math.max(0, at - request.startedAtMs),
        request.state,
      ))

    return {
      active,
      recent: this.recent.newestFirst().map(cloneObservedRequest),
      totals: {
        started: this.started,
        completed: this.completed,
        failed: this.failed,
        aborted: this.aborted,
      },
      effectCounts: { ...this.effectCounts },
    }
  }

  summary(): RequestActivitySummary {
    return {
      active: this.active.size,
      recent: this.recent.length,
      totals: {
        started: this.started,
        completed: this.completed,
        failed: this.failed,
        aborted: this.aborted,
      },
      effectCounts: { ...this.effectCounts },
    }
  }

  reset(): void {
    this.active.clear()
    this.effectBuffers.clear()
    this.recent = new FixedRing<ObservedRequest>(RECENT_REQUEST_LIMIT)
    for (const key of Object.keys(this.effectCounts) as Array<ProxyEffectId>)
      delete this.effectCounts[key]
    this.started = 0
    this.completed = 0
    this.failed = 0
    this.aborted = 0
  }
}

export function classifyObservedEndpoint(rawUrl: string): string | undefined {
  try {
    const path = new URL(rawUrl).pathname
    if (path === '/dashboard' || path.startsWith('/dashboard/'))
      return undefined
    return normalizeObservedPath(path)
  }
  catch {
    return 'unmatched'
  }
}

function normalizeObservedPath(rawPath: string): string {
  let path = rawPath
  if (path.length > 1 && path.endsWith('/'))
    path = path.slice(0, -1)

  if (KNOWN_OBSERVED_ENDPOINTS.has(path))
    return path

  const inputItems = path.match(RESPONSE_INPUT_ITEMS_ENDPOINT_RE)
  if (inputItems)
    return `${inputItems[1] ?? ''}/responses/:responseId/input_items`

  const response = path.match(RESPONSE_RESOURCE_ENDPOINT_RE)
  if (response)
    return `${response[1] ?? ''}/responses/:responseId`

  return 'unmatched'
}

export function sanitizeObservedError(
  error: unknown,
  code: string | number,
  status: number,
): string {
  if (isTimeoutLikeError(error) || status === 504)
    return 'Upstream timeout'
  if (code === 'NOT_FOUND')
    return 'Unknown endpoint'
  if (code === 'VALIDATION' || code === 'PARSE')
    return 'Request validation failed'

  const type = readSafeErrorCategory(error)
  if (code === 'HTTP' || (status >= 400 && status < 500)) {
    return type
      ? `HTTP ${status} (${type})`
      : `HTTP ${status}`
  }
  return 'Unhandled proxy error'
}

function projectRequest(
  request: ActiveRequest,
  durationMs: number,
  state: ObservedRequestState,
  status?: number,
): ObservedRequest {
  return {
    requestId: request.requestId,
    method: request.method,
    endpoint: request.endpoint,
    state,
    startedAt: new Date(request.startedAtMs).toISOString(),
    durationMs,
    ...(status !== undefined ? { status } : {}),
    ...(request.requestedModel ? { requestedModel: request.requestedModel } : {}),
    ...(request.effectiveModel ? { effectiveModel: request.effectiveModel } : {}),
    modelTransforms: request.modelTransforms.map(step => ({ ...step })),
    ...(request.selectedStrategy
      ? { selectedStrategy: request.selectedStrategy }
      : {}),
    effects: Object.entries(request.effectCounts)
      .map(([id, count]) => ({ id: id as ProxyEffectId, count: count ?? 0 }))
      .filter(effect => effect.count > 0),
    ...(request.errorSummary ? { errorSummary: request.errorSummary } : {}),
  }
}

function cloneObservedRequest(request: ObservedRequest): ObservedRequest {
  return {
    ...request,
    modelTransforms: request.modelTransforms.map(step => ({ ...step })),
    effects: request.effects.map(effect => ({ ...effect })),
  }
}

function sanitizeMethod(method: string): string {
  return OBSERVED_METHOD_RE.test(method) ? method : 'OTHER'
}

function sanitizeModelId(model: string): string {
  return OBSERVED_MODEL_ID_RE.test(model)
    ? model
    : 'invalid-model-id'
}

function sanitizeTag(value: string): string {
  return OBSERVED_TAG_RE.test(value)
    ? value
    : 'unknown'
}

function sanitizeStoredErrorSummary(summary: string): string {
  return OBSERVED_ERROR_SUMMARY_RE.test(summary)
    ? summary
    : 'Unhandled proxy error'
}

function readSafeErrorCategory(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null)
    return undefined
  try {
    const body = 'body' in error ? (error as { body?: unknown }).body : undefined
    if (typeof body !== 'object' || body === null)
      return undefined
    const nested = 'error' in body ? (body as { error?: unknown }).error : undefined
    if (typeof nested === 'object' && nested !== null) {
      const code = 'code' in nested
        ? (nested as { code?: unknown }).code
        : undefined
      if (isObservedErrorCategory(code))
        return code
      const type = 'type' in nested
        ? (nested as { type?: unknown }).type
        : undefined
      return isObservedErrorCategory(type) ? type : undefined
    }
    const type = 'type' in body
      ? (body as { type?: unknown }).type
      : undefined
    return isObservedErrorCategory(type) ? type : undefined
  }
  catch {
    return undefined
  }
}

function isObservedErrorCategory(value: unknown): value is string {
  return typeof value === 'string' && OBSERVED_ERROR_CATEGORIES.has(value)
}
