import type { CapacityCooldownScope } from '~/lib/error'

import consola from 'consola'
import { colorize } from 'consola/utils'

import { formatDurationMs } from '~/util/duration'

export type ModelTransformTag
  = | 'AUTO_CORRECT'
    | 'CONFIG_REWRITE'
    | 'COMPACT'
    | 'MODEL_RESOLVE'

export interface ModelTransformStep {
  tag: ModelTransformTag
  from: string
  to: string
}

export interface ModelMappingInfo {
  originalModel?: string
  steps: ModelTransformStep[]
}

/**
 * Per-request model mapping store.
 * Route handlers write to this; the after-response hook reads from it.
 * Uses WeakMap so entries are GC'd when the Request is collected.
 */
const requestModelMapping = new WeakMap<Request, ModelMappingInfo>()

export interface RequestCorrelation {
  requestId: string
  callerRequestId?: string
  responseRequestId: string
}

const requestCorrelation = new WeakMap<Request, RequestCorrelation>()

export function getOrCreateRequestCorrelation(request: Request): RequestCorrelation {
  const existing = requestCorrelation.get(request)
  if (existing) {
    return existing
  }

  const requestId = crypto.randomUUID()
  const callerRequestId = request.headers.get('x-request-id') ?? undefined
  const correlation: RequestCorrelation = {
    requestId,
    ...(callerRequestId ? { callerRequestId } : {}),
    responseRequestId: callerRequestId ?? requestId,
  }
  requestCorrelation.set(request, correlation)
  return correlation
}

export type RecoveryEventName
  = | 'admission'
    | 'budget'
    | 'cooldown'
    | 'fallback'
    | 'grant'
    | 'retry'

export interface RecoveryEvent {
  requestId: string
  event: RecoveryEventName
  retryCount?: number
  status?: number
  connectionClass?: string
  effectiveModel?: string
  scope?: CapacityCooldownScope
  activeSlots?: number
  maxSlots?: number
  pendingDepth?: number
  maxPendingDepth?: number
  queueWaitMs?: number
  delaySource?: string
  delayMs?: number
  elapsedMs?: number
  remainingBudgetMs?: number
  nextRetryAt?: string
  decision?: string
}

interface RecoveryEventLogger {
  info: (message: string, fields: RecoveryEvent) => void
}

const RECOVERY_EVENT_OPTIONAL_FIELDS = [
  'retryCount',
  'status',
  'connectionClass',
  'effectiveModel',
  'scope',
  'activeSlots',
  'maxSlots',
  'pendingDepth',
  'maxPendingDepth',
  'queueWaitMs',
  'delaySource',
  'delayMs',
  'elapsedMs',
  'remainingBudgetMs',
  'nextRetryAt',
  'decision',
] as const

export function logRecoveryEvent(
  input: RecoveryEvent,
  logger: RecoveryEventLogger = consola,
): void {
  const fields: RecoveryEvent = {
    requestId: input.requestId,
    event: input.event,
  }
  for (const key of RECOVERY_EVENT_OPTIONAL_FIELDS) {
    if (input[key] !== undefined)
      Object.assign(fields, { [key]: input[key] })
  }
  logger.info('Upstream recovery', fields)
}

export function setRequestModelMapping(request: Request, info: ModelMappingInfo): void {
  requestModelMapping.set(request, info)
}

export function getRequestModelMapping(request: Request): ModelMappingInfo | undefined {
  return requestModelMapping.get(request)
}

export function formatElapsed(start: number) {
  return formatDurationMs(Date.now() - start)
}

function formatPath(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    return `${url.pathname}${url.search}`
  }
  catch {
    return rawUrl
  }
}

function colorizeStatus(status: number): string {
  if (status >= 500)
    return colorize('red', status)
  if (status >= 400)
    return colorize('yellow', status)
  if (status >= 300)
    return colorize('cyan', status)
  return colorize('green', status)
}

const methodColors: Record<string, Parameters<typeof colorize>[0]> = {
  GET: 'cyan',
  POST: 'magenta',
  PUT: 'yellow',
  PATCH: 'yellow',
  DELETE: 'red',
}

function colorizeMethod(method: string): string {
  return colorize(methodColors[method] ?? 'white', method)
}

export function getEffectiveModel(info: ModelMappingInfo): string {
  return info.steps.length > 0
    ? info.steps.at(-1)!.to
    : info.originalModel ?? '-'
}

/**
 * Mutate `modelMapping` in place by appending a transform step.
 * Strategy contexts hold a reference to the same `modelMapping`,
 * so steps are pushed directly rather than returning a new object.
 */
export function appendModelStepInPlace(
  info: ModelMappingInfo,
  tag: ModelTransformTag,
  newModel: string,
): void {
  const current = getEffectiveModel(info)
  if (newModel !== current) {
    info.steps.push({ tag, from: current, to: newModel })
  }
}

function formatModelMapping(info: ModelMappingInfo | undefined): string {
  if (!info)
    return ''

  const { originalModel, steps } = info
  if (!originalModel && steps.length === 0)
    return ''

  const display = originalModel ?? '-'
  const parts: string[] = [colorize('blueBright', display)]

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const isLast = i === steps.length - 1
    parts.push(colorize('dim', `-[${step.tag}]->`))
    parts.push(colorize(isLast ? 'greenBright' : 'cyanBright', step.to))
  }

  return ` ${colorize('dim', 'model=')}${parts.join(' ')}`
}

/**
 * Request logging function.
 * Logs a formatted request line with method, path, status, elapsed time,
 * and optional model mapping info.
 */
export function logRequest(
  method: string,
  url: string,
  status: number,
  elapsed: string,
  modelInfo?: ModelMappingInfo,
  requestId?: string,
): void {
  const path = formatPath(url)
  const line = [
    colorize('dim', '<-'),
    colorizeMethod(method),
    colorize('white', path),
    colorizeStatus(status),
    colorize('dim', elapsed),
  ].join(' ')

  const rid = requestId ? ` ${colorize('dim', `rid=${requestId.slice(0, 8)}`)}` : ''

  // eslint-disable-next-line no-console
  console.log(`${line}${formatModelMapping(modelInfo)}${rid}`)
}
