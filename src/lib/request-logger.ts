import type { CapacityCooldownScope } from '~/lib/error'

import consola from 'consola'
import { colorize } from 'consola/utils'

import { formatDurationMs } from '~/util/duration'

export type ModelTransformTag
  = | 'AUTO_CORRECT'
    | 'CONFIG_REWRITE'
    | 'COMPACT'
    | 'MODEL_RESOLVE'
    | 'OVERLOAD_FALLBACK'

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

/**
 * Per-request start timestamp for the access log.
 *
 * Keyed on the `Request` the same way `requestCorrelation` is, so entries are
 * GC'd with it. This lives here rather than in `derive()` because `derive` does
 * not run on a route Elysia never matched — `onRequest` does, and it preserves
 * `Request` identity through to `onAfterResponse`. Reading a missing `derive`
 * value is what rendered every unmatched route's duration as the literal string
 * `NaNs`.
 *
 * That lifecycle behavior was measured once by hand on Bun 1.3.14 and on Node
 * 24.18 via `@elysiajs/node`. **The automated suite runs only under Bun**, so
 * the Node half is a point-in-time observation rather than standing coverage —
 * see `docs/solutions/testing/green-suite-is-evidence-about-one-runtime.md`. If
 * the Node adapter ever stops firing `onRequest` on an unmatched path, or
 * re-wraps the `Request` between hooks, the lookup misses and the duration
 * silently degrades to `-` on that runtime with a green suite.
 */
const requestStartTimes = new WeakMap<Request, number>()

/**
 * Record when a request arrived. Called from `onRequest`, which fires on every
 * path including ones no route matches.
 *
 * The `void` return type is load-bearing, not decoration. `WeakMap.set` returns
 * the WeakMap, and Elysia turns any non-undefined `onRequest` return into the
 * response body — a setter written as a concise arrow over `.set()` makes every
 * response in the proxy the string `[object WeakMap]`. `tsc` does not catch it.
 */
export function markRequestStart(request: Request): void {
  requestStartTimes.set(request, Date.now())
}

export function getRequestStart(request: Request): number | undefined {
  return requestStartTimes.get(request)
}

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
  callerRequestId?: string
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

const MAX_LOGGED_CALLER_REQUEST_ID_LENGTH = 128
const UNSAFE_CALLER_REQUEST_ID_CHARACTERS = /[^\w.:@/-]/g

function sanitizeCallerRequestId(value: string | undefined): string | undefined {
  return value
    ? value.replace(UNSAFE_CALLER_REQUEST_ID_CHARACTERS, '_').slice(0, MAX_LOGGED_CALLER_REQUEST_ID_LENGTH)
    : undefined
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

function isRoutineRecoveryEvent(fields: RecoveryEvent): boolean {
  return (
    fields.event === 'cooldown'
    || (fields.event === 'grant' && fields.queueWaitMs === 0)
    || (
      fields.event === 'retry'
      && fields.status !== undefined
      && fields.decision === 'retry'
    )
  )
}

function formatRecoveryEventLine(fields: RecoveryEvent): string {
  const kind = fields.status === 429
    ? 'rate limit'
    : fields.status === 529
      ? 'overload'
      : 'recovery'
  const includeQueueState = fields.event === 'admission' || fields.event === 'grant'
  const details = [
    `Upstream ${kind}`,
    fields.decision ?? fields.event,
    fields.status !== undefined ? `status=${fields.status}` : undefined,
    fields.effectiveModel ? `model=${JSON.stringify(fields.effectiveModel).slice(1, -1)}` : undefined,
    fields.scope ? `scope=${fields.scope}` : undefined,
    fields.retryCount !== undefined ? `retry=${fields.retryCount}` : undefined,
    fields.connectionClass ? `connection=${fields.connectionClass}` : undefined,
    fields.delayMs !== undefined ? `wait=${formatDurationMs(fields.delayMs)}` : undefined,
    fields.delaySource ? `source=${fields.delaySource}` : undefined,
    fields.queueWaitMs !== undefined && fields.queueWaitMs > 0
      ? `queueWait=${formatDurationMs(fields.queueWaitMs)}`
      : undefined,
    includeQueueState && fields.activeSlots !== undefined && fields.maxSlots !== undefined
      ? `slots=${fields.activeSlots}/${fields.maxSlots}`
      : undefined,
    includeQueueState && fields.pendingDepth !== undefined && fields.maxPendingDepth !== undefined
      ? `queue=${fields.pendingDepth}/${fields.maxPendingDepth}`
      : undefined,
    fields.remainingBudgetMs !== undefined
      ? `budget=${formatDurationMs(fields.remainingBudgetMs)}`
      : undefined,
    `rid=${fields.requestId.slice(0, 8)}`,
  ]
  return details.filter(value => value !== undefined).join(' ')
}

export function logRecoveryEvent(
  input: RecoveryEvent,
  logger: RecoveryEventLogger = consola,
): void {
  if (logger === consola && isRoutineRecoveryEvent(input))
    return

  const callerRequestId = sanitizeCallerRequestId(input.callerRequestId)
  const fields: RecoveryEvent = {
    requestId: input.requestId,
    ...(callerRequestId ? { callerRequestId } : {}),
    event: input.event,
  }
  for (const key of RECOVERY_EVENT_OPTIONAL_FIELDS) {
    if (input[key] !== undefined)
      Object.assign(fields, { [key]: input[key] })
  }
  if (logger === consola) {
    consola.info(formatRecoveryEventLine(fields))
    return
  }
  logger.info('Upstream recovery', fields)
}

export function setRequestModelMapping(request: Request, info: ModelMappingInfo): void {
  requestModelMapping.set(request, info)
}

export function getRequestModelMapping(request: Request): ModelMappingInfo | undefined {
  return requestModelMapping.get(request)
}

/**
 * Format how long a request took, given the timestamp recorded at arrival.
 *
 * Renders `-` rather than a number when the start is missing or the arithmetic
 * is not finite. The caller is expected to supply a real start (see
 * {@link markRequestStart}); this is the shared-formatter backstop, so a future
 * code path that skips the `onRequest` hook degrades to an honest `-` instead
 * of printing `NaNs`.
 */
export function formatElapsed(start: number | undefined) {
  if (start === undefined)
    return '-'

  const elapsed = Date.now() - start
  return Number.isFinite(elapsed) ? formatDurationMs(elapsed) : '-'
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
  callerRequestId?: string,
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
  const safeCallerRequestId = sanitizeCallerRequestId(callerRequestId)
  const callerRid = safeCallerRequestId
    ? ` ${colorize('dim', `callerRid=${safeCallerRequestId}`)}`
    : ''

  // eslint-disable-next-line no-console
  console.log(`${line}${formatModelMapping(modelInfo)}${rid}${callerRid}`)
}
