import type { CapacityCooldownScope } from '~/lib/error'
import type { RecoveryEvent } from '~/lib/request-logger'

import consola from 'consola'

import {
  DEFAULT_UPSTREAM_QUEUE_MAX_RETRIES,
  DEFAULT_UPSTREAM_RECOVERY_BUDGET_SECONDS,
  MAX_UPSTREAM_QUEUE_RETRIES,
  MAX_UPSTREAM_RECOVERY_BUDGET_SECONDS,
  MIN_UPSTREAM_RECOVERY_BUDGET_SECONDS,
} from '~/lib/config'
import {
  HTTPError,
  isRetryableConnectionEstablishmentError,
  isTransientUpstreamStatus,
  resolveCapacityCooldownScope,
} from '~/lib/error'
import { logRecoveryEvent } from '~/lib/request-logger'
import { formatDurationMs } from '~/util/duration'
import { sleep as defaultSleep } from '~/util/sleep'

export interface UpstreamRequestQueueOptions {
  concurrency: number
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  maxQueueDepth: number
  recoveryBudgetMs: number
}

export interface RecoveryCooldownState {
  scope: CapacityCooldownScope
  notBeforeMonotonicMs: number
  effectiveModel?: string
}

export interface RecoveryPublicError {
  status: number
  retryAfter?: string
}

export interface UpstreamRecoveryRecord {
  requestId: string
  callerRequestId?: string
  retryCount: number
  retryLimit?: number
  startedAtMonotonicMs?: number
  deadlineMonotonicMs?: number
  sourceModel?: string
  cooldown?: RecoveryCooldownState
  publicError?: RecoveryPublicError
}

export interface UpstreamRequestContext {
  method?: string
  url: string
  /**
   * Which upstream failures may be replayed for this request. Omitted = none.
   * `true` keeps the transient-status policy for effect-free calls;
   * `'capacity'` limits generation HTTP retries to 429/529. Both forms may
   * retry the measured pre-connection allowlist.
   */
  retryable?: boolean | 'capacity'
  effectiveModel?: string
  recovery?: UpstreamRecoveryRecord
  offerLocalModelCooldown?: boolean
}

export interface QueuedUpstreamResponse {
  response: Response
  release: () => void
  recovery: UpstreamRecoveryRecord
}

interface UpstreamRequestQueueDeps {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  wallNow?: () => number
  random?: () => number
  logger?: QueueLogger
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

interface QueueLogger {
  warn: (message: string) => void
  info?: (message: string, fields: RecoveryEvent) => void
}

interface QueueLease {
  release: () => void
}

interface QueueWaiter {
  context: UpstreamRequestContext & { recovery: UpstreamRecoveryRecord }
  causalError?: unknown
  enqueuedAt: number
  resolve: (lease: QueueLease) => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

interface RetryDelay {
  delayMs: number
  source: 'retry-after' | 'backoff'
  retryAfter?: string
}

const DEFAULT_UPSTREAM_QUEUE_OPTIONS: UpstreamRequestQueueOptions = {
  concurrency: 10,
  maxRetries: DEFAULT_UPSTREAM_QUEUE_MAX_RETRIES,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  maxQueueDepth: 1_000,
  recoveryBudgetMs: DEFAULT_UPSTREAM_RECOVERY_BUDGET_SECONDS * 1_000,
}

const MAX_TIMER_DELAY_MS = 2_147_483_647
const RETRY_AFTER_SECONDS_RE = /^\d+(?:\.\d+)?$/
const RETRY_AFTER_HTTP_DATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/

export class TerminalUpstreamRecoveryError extends HTTPError {
  readonly recovery: UpstreamRecoveryRecord
  private fallbackClaimed = false

  constructor(source: HTTPError, recovery: UpstreamRecoveryRecord) {
    super(source.status, source.body, { headers: source.headers })
    this.name = 'TerminalUpstreamRecoveryError'
    this.recovery = recovery
  }

  claimFallback(): boolean {
    if (this.fallbackClaimed)
      return false
    this.fallbackClaimed = true
    return true
  }
}

export class LocalModelCooldownError extends TerminalUpstreamRecoveryError {
  private handled = false
  private readonly resumeDispatch: () => Promise<QueuedUpstreamResponse>

  constructor(
    recovery: UpstreamRecoveryRecord,
    retryAfter: string,
    resumeDispatch: () => Promise<QueuedUpstreamResponse>,
  ) {
    super(new HTTPError(529, {
      error: {
        message: 'The selected upstream model is temporarily overloaded.',
        type: 'overloaded_error',
      },
    }, { headers: { 'retry-after': retryAfter } }), recovery)
    this.name = 'LocalModelCooldownError'
    this.resumeDispatch = resumeDispatch
  }

  override claimFallback(): boolean {
    if (this.handled)
      return false
    this.handled = true
    return super.claimFallback()
  }

  resume(): Promise<QueuedUpstreamResponse> {
    if (this.handled)
      return Promise.reject(new Error('Recovery handoff already consumed'))
    this.handled = true
    return this.resumeDispatch()
  }
}

export class UpstreamRequestQueue {
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly wallNow: () => number
  private readonly random: () => number
  private readonly logger: QueueLogger
  private readonly setTimer: typeof globalThis.setTimeout
  private readonly clearTimer: typeof globalThis.clearTimeout
  private options: UpstreamRequestQueueOptions
  private active = 0
  private accountNotBefore = 0
  private readonly modelNotBefore = new Map<string, number>()
  private drainTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  private drainTimerAt: number | undefined
  private readonly waiters: QueueWaiter[] = []

  constructor(
    options: Partial<UpstreamRequestQueueOptions> = {},
    deps: UpstreamRequestQueueDeps = {},
  ) {
    this.options = normalizeOptions(options)
    this.sleep = deps.sleep ?? defaultSleep
    this.now = deps.now ?? (() => performance.now())
    this.wallNow = deps.wallNow ?? Date.now
    this.random = deps.random ?? Math.random
    this.logger = deps.logger ?? consola
    this.setTimer = deps.setTimeout ?? globalThis.setTimeout
    this.clearTimer = deps.clearTimeout ?? globalThis.clearTimeout
  }

  updateOptions(options: Partial<UpstreamRequestQueueOptions>): void {
    this.options = normalizeOptions(mergeDefinedOptions(this.options, options))
    this.drain()
  }

  async dispatch(
    fetcher: (signal?: AbortSignal) => Promise<Response>,
    inputContext: UpstreamRequestContext,
    signal?: AbortSignal,
  ): Promise<QueuedUpstreamResponse> {
    const recovery = inputContext.recovery ?? {
      requestId: crypto.randomUUID(),
      retryCount: 0,
    }
    const context = { ...inputContext, recovery }
    recovery.sourceModel ??= context.effectiveModel

    const localCooldown = this.getActiveCooldown(context.effectiveModel)
    if (
      context.offerLocalModelCooldown
      && localCooldown?.scope === 'model'
      && localCooldown.notBeforeMonotonicMs > this.now()
    ) {
      this.startRecovery(recovery)
      this.setRecoveryCooldown(recovery, localCooldown)
      const retryAfter = formatRetryAfter(localCooldown.notBeforeMonotonicMs - this.now())
      recovery.publicError = { status: 529, retryAfter }
      throw new LocalModelCooldownError(
        recovery,
        retryAfter,
        () => this.dispatch(fetcher, { ...context, offerLocalModelCooldown: false }, signal),
      )
    }

    let lastConnectionError: unknown

    for (;;) {
      signal?.throwIfAborted()
      this.throwIfRecoveryExpired(recovery, lastConnectionError)
      const lease = await this.acquire(context, signal, lastConnectionError)
      let response: Response

      try {
        response = await this.fetchBeforeDeadline(fetcher, signal, recovery, lastConnectionError)
        lastConnectionError = undefined
      }
      catch (error) {
        lease.release()
        if (signal?.aborted)
          throw signal.reason
        if (isRecoveryBudgetError(error))
          throw error.cause ?? error

        const connectionClass = isRetryableConnectionEstablishmentError(error)
        if (!connectionClass || !context.retryable)
          throw error

        this.startRecovery(recovery)
        if (!this.canRetry(recovery))
          throw error

        lastConnectionError = error
        const delay = this.getBackoffDelay(recovery.retryCount, this.remainingBudget(recovery))
        recovery.retryCount++
        this.emit('retry', context, {
          retryCount: recovery.retryCount,
          connectionClass,
          delaySource: 'backoff',
          delayMs: delay,
          decision: 'retry',
        })
        await this.waitForRecovery(delay, signal, recovery, error)
        continue
      }

      const status = response.status
      const scope = resolveCapacityCooldownScope(status, context.effectiveModel)
      const capacity = scope !== undefined
      const mayReplay = context.retryable === 'capacity'
        ? capacity
        : context.retryable === true && isTransientUpstreamStatus(status)

      let retryDelay: RetryDelay | undefined
      if (capacity) {
        this.startRecovery(recovery)
        retryDelay = this.getRetryDelay(response, recovery.retryCount, recovery)
        this.installCooldown(scope, context.effectiveModel, retryDelay.delayMs, context)
        recovery.publicError = {
          status,
          retryAfter: retryDelay.retryAfter ?? formatRetryAfter(retryDelay.delayMs),
        }
      }

      if (!mayReplay) {
        return this.committed(response, lease, recovery, capacity ? retryDelay : undefined)
      }

      this.startRecovery(recovery)
      if (!capacity)
        recovery.publicError = { status }
      retryDelay ??= this.getRetryDelay(response, recovery.retryCount, recovery)
      const remaining = this.remainingBudget(recovery)
      const serverMinimumDoesNotFit = retryDelay.source === 'retry-after'
        && retryDelay.delayMs >= remaining

      if (!this.canRetry(recovery) || serverMinimumDoesNotFit) {
        this.emit('budget', context, {
          retryCount: recovery.retryCount,
          status,
          scope,
          delaySource: retryDelay.source,
          delayMs: retryDelay.delayMs,
          remainingBudgetMs: remaining,
          decision: serverMinimumDoesNotFit ? 'server-delay-exceeds-budget' : 'retry-limit',
        })
        return this.committed(response, lease, recovery, capacity ? retryDelay : undefined)
      }

      discardResponse(response)
      lease.release()
      recovery.retryCount++
      this.logger.warn(
        [
          `Upstream ${status};`,
          `retrying ${formatRequestContext(context)}`,
          `in ${formatDurationMs(retryDelay.delayMs)}`,
          `(attempt ${recovery.retryCount}/${recovery.retryLimit})`,
        ].join(' '),
      )
      this.emit('retry', context, {
        retryCount: recovery.retryCount,
        status,
        scope,
        delaySource: retryDelay.source,
        delayMs: retryDelay.delayMs,
        decision: 'retry',
      })
      await this.waitForRecovery(retryDelay.delayMs, signal, recovery)
    }
  }

  private async acquire(
    context: UpstreamRequestContext & { recovery: UpstreamRecoveryRecord },
    signal?: AbortSignal,
    causalError?: unknown,
  ): Promise<QueueLease> {
    signal?.throwIfAborted()
    this.prepareCooldownWait(context)
    this.throwIfRecoveryExpired(context.recovery, causalError)
    this.drain()

    if (this.active < this.options.concurrency && this.isEligible(context)) {
      return this.grant(context, 0)
    }

    if (this.waiters.length >= this.options.maxQueueDepth) {
      this.emit('admission', context, { decision: 'queue-full' })
      throw new HTTPError(503, {
        error: { message: 'Upstream queue full', type: 'overloaded_error' },
      })
    }

    return new Promise<QueueLease>((resolve, reject) => {
      const waiter: QueueWaiter = {
        context,
        causalError,
        enqueuedAt: this.now(),
        resolve,
        reject,
        signal,
      }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index === -1)
            return
          this.waiters.splice(index, 1)
          reject(signal.reason)
          this.drain()
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
      this.emit('admission', context, { decision: 'queued' })
      this.drain()
    })
  }

  private prepareCooldownWait(
    context: UpstreamRequestContext & { recovery: UpstreamRecoveryRecord },
  ): void {
    const cooldown = this.getActiveCooldown(context.effectiveModel)
    if (!cooldown)
      return

    this.startRecovery(context.recovery)
    this.setRecoveryCooldown(context.recovery, cooldown)
    const status = cooldown.scope === 'account' ? 429 : 529
    context.recovery.publicError = {
      status,
      retryAfter: formatRetryAfter(cooldown.notBeforeMonotonicMs - this.now()),
    }
    if (cooldown.notBeforeMonotonicMs > context.recovery.deadlineMonotonicMs!) {
      throw createLocalCapacityError(context.recovery)
    }
  }

  private drain(): void {
    this.clearExpiredModels()

    for (let index = this.waiters.length - 1; index >= 0; index--) {
      const waiter = this.waiters[index]!
      const deadline = waiter.context.recovery.deadlineMonotonicMs
      if (deadline !== undefined && this.now() >= deadline) {
        this.waiters.splice(index, 1)
        this.cleanupWaiter(waiter)
        waiter.reject(waiter.causalError ?? createLocalCapacityError(waiter.context.recovery))
      }
    }

    while (this.active < this.options.concurrency) {
      const index = this.waiters.findIndex(waiter => this.isEligible(waiter.context))
      if (index === -1)
        break
      const waiter = this.waiters.splice(index, 1)[0]!
      this.cleanupWaiter(waiter)
      waiter.resolve(this.grant(waiter.context, this.now() - waiter.enqueuedAt))
    }

    this.scheduleNextWake()
  }

  private scheduleNextWake(): void {
    let wakeAt: number | undefined
    const now = this.now()

    for (const waiter of this.waiters) {
      const cooldown = this.getActiveCooldown(waiter.context.effectiveModel)
      if (cooldown && cooldown.notBeforeMonotonicMs > now)
        wakeAt = minDefined(wakeAt, cooldown.notBeforeMonotonicMs)
      const deadline = waiter.context.recovery.deadlineMonotonicMs
      if (deadline !== undefined && deadline > now)
        wakeAt = minDefined(wakeAt, deadline)
    }

    if (wakeAt === this.drainTimerAt)
      return
    if (this.drainTimer) {
      this.clearTimer(this.drainTimer)
      this.drainTimer = undefined
      this.drainTimerAt = undefined
    }
    if (wakeAt === undefined)
      return

    this.drainTimerAt = wakeAt
    this.drainTimer = this.setTimer(() => {
      this.drainTimer = undefined
      this.drainTimerAt = undefined
      this.drain()
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, wakeAt - now)))
  }

  private grant(
    context: UpstreamRequestContext & { recovery: UpstreamRecoveryRecord },
    queueWaitMs: number,
  ): QueueLease {
    let released = false
    this.active++
    this.emit('grant', context, { queueWaitMs, decision: 'granted' })
    return {
      release: () => {
        if (released)
          return
        released = true
        this.active--
        this.drain()
      },
    }
  }

  private isEligible(context: UpstreamRequestContext): boolean {
    return this.getActiveCooldown(context.effectiveModel) === undefined
  }

  private getActiveCooldown(effectiveModel?: string): RecoveryCooldownState | undefined {
    const now = this.now()
    if (this.accountNotBefore > now) {
      return { scope: 'account', notBeforeMonotonicMs: this.accountNotBefore }
    }
    if (!effectiveModel)
      return undefined
    const modelDeadline = this.modelNotBefore.get(effectiveModel)
    if (modelDeadline === undefined)
      return undefined
    if (modelDeadline <= now) {
      this.modelNotBefore.delete(effectiveModel)
      return undefined
    }
    return {
      scope: 'model',
      notBeforeMonotonicMs: modelDeadline,
      effectiveModel,
    }
  }

  private clearExpiredModels(): void {
    const now = this.now()
    for (const [model, deadline] of this.modelNotBefore) {
      if (deadline <= now)
        this.modelNotBefore.delete(model)
    }
  }

  private installCooldown(
    scope: CapacityCooldownScope,
    effectiveModel: string | undefined,
    delayMs: number,
    context: UpstreamRequestContext & { recovery: UpstreamRecoveryRecord },
  ): void {
    const deadline = this.now() + delayMs
    if (scope === 'account') {
      this.accountNotBefore = Math.max(this.accountNotBefore, deadline)
    }
    else if (scope === 'model' && effectiveModel) {
      this.modelNotBefore.set(
        effectiveModel,
        Math.max(this.modelNotBefore.get(effectiveModel) ?? 0, deadline),
      )
    }

    const stored = scope === 'account'
      ? this.accountNotBefore
      : scope === 'model' && effectiveModel
        ? this.modelNotBefore.get(effectiveModel)!
        : deadline
    this.setRecoveryCooldown(context.recovery, {
      scope,
      notBeforeMonotonicMs: stored,
      ...(effectiveModel && scope === 'model' ? { effectiveModel } : {}),
    })
    this.emit('cooldown', context, {
      scope,
      delayMs,
      nextRetryAt: new Date(this.wallNow() + delayMs).toISOString(),
      decision: scope === 'request' ? 'request-local' : 'installed',
    })
    this.drain()
  }

  private startRecovery(recovery: UpstreamRecoveryRecord): void {
    if (recovery.deadlineMonotonicMs !== undefined)
      return
    const startedAt = this.now()
    recovery.startedAtMonotonicMs = startedAt
    recovery.deadlineMonotonicMs = startedAt + this.options.recoveryBudgetMs
    recovery.retryLimit ??= this.options.maxRetries
  }

  private setRecoveryCooldown(
    recovery: UpstreamRecoveryRecord,
    cooldown: RecoveryCooldownState,
  ): void {
    if (
      !recovery.cooldown
      || cooldown.notBeforeMonotonicMs >= recovery.cooldown.notBeforeMonotonicMs
    ) {
      recovery.cooldown = cooldown
    }
  }

  private canRetry(recovery: UpstreamRecoveryRecord): boolean {
    return recovery.retryCount < (recovery.retryLimit ?? this.options.maxRetries)
      && this.remainingBudget(recovery) >= 0
  }

  private remainingBudget(recovery: UpstreamRecoveryRecord): number {
    return recovery.deadlineMonotonicMs === undefined
      ? this.options.recoveryBudgetMs
      : Math.max(0, recovery.deadlineMonotonicMs - this.now())
  }

  private throwIfRecoveryExpired(
    recovery: UpstreamRecoveryRecord,
    lastConnectionError?: unknown,
  ): void {
    if (
      recovery.deadlineMonotonicMs !== undefined
      && this.now() >= recovery.deadlineMonotonicMs
    ) {
      throw lastConnectionError ?? createLocalCapacityError(recovery)
    }
  }

  private getRetryDelay(
    response: Response,
    attempt: number,
    recovery: UpstreamRecoveryRecord,
  ): RetryDelay {
    const retryAfterMs = parseRetryAfterMs(response.headers, this.wallNow())
    const retryAfter = response.headers.get('retry-after') ?? undefined
    if (retryAfterMs !== undefined) {
      return { delayMs: retryAfterMs, source: 'retry-after', retryAfter }
    }
    return {
      delayMs: this.getBackoffDelay(attempt, this.remainingBudget(recovery)),
      source: 'backoff',
    }
  }

  private getBackoffDelay(attempt: number, remainingBudgetMs: number): number {
    const cap = Math.min(
      this.options.baseDelayMs * 2 ** attempt,
      this.options.maxDelayMs,
      Math.max(0, remainingBudgetMs),
    )
    const random = Math.min(1, Math.max(0, this.random()))
    return Math.floor(cap * random)
  }

  private async waitForRecovery(
    delayMs: number,
    signal: AbortSignal | undefined,
    recovery: UpstreamRecoveryRecord,
    lastConnectionError?: unknown,
  ): Promise<void> {
    const remaining = this.remainingBudget(recovery)
    if (delayMs > remaining)
      throw lastConnectionError ?? createLocalCapacityError(recovery)
    const deadline = createDeadlineSignal(signal, remaining, this.setTimer, this.clearTimer)
    try {
      await abortableSleep(this.sleep, delayMs, deadline.signal)
    }
    catch (error) {
      if (signal?.aborted)
        throw signal.reason
      if (deadline.timedOut())
        throw lastConnectionError ?? createLocalCapacityError(recovery)
      throw error
    }
    finally {
      deadline.cleanup()
    }
    this.throwIfRecoveryExpired(recovery, lastConnectionError)
  }

  private async fetchBeforeDeadline(
    fetcher: (signal?: AbortSignal) => Promise<Response>,
    signal: AbortSignal | undefined,
    recovery: UpstreamRecoveryRecord,
    lastConnectionError?: unknown,
  ): Promise<Response> {
    if (recovery.deadlineMonotonicMs === undefined)
      return fetcher(signal)

    const deadline = createDeadlineSignal(
      signal,
      this.remainingBudget(recovery),
      this.setTimer,
      this.clearTimer,
    )
    try {
      const response = await fetcher(deadline.signal)
      if (this.now() >= recovery.deadlineMonotonicMs) {
        discardResponse(response)
        throw new RecoveryBudgetError(lastConnectionError ?? createLocalCapacityError(recovery))
      }
      return response
    }
    catch (error) {
      if (signal?.aborted)
        throw signal.reason
      if (deadline.timedOut())
        throw new RecoveryBudgetError(lastConnectionError ?? createLocalCapacityError(recovery))
      throw error
    }
    finally {
      deadline.cleanup()
    }
  }

  private committed(
    response: Response,
    lease: QueueLease,
    recovery: UpstreamRecoveryRecord,
    retryDelay?: RetryDelay,
  ): QueuedUpstreamResponse {
    return {
      response: retryDelay
        ? ensureRetryAfter(response, retryDelay.retryAfter ?? formatRetryAfter(retryDelay.delayMs))
        : response,
      release: lease.release,
      recovery,
    }
  }

  private emit(
    event: RecoveryEvent['event'],
    context: UpstreamRequestContext & { recovery: UpstreamRecoveryRecord },
    fields: Omit<RecoveryEvent, 'requestId' | 'event' | 'effectiveModel' | 'activeSlots' | 'maxSlots' | 'pendingDepth' | 'maxPendingDepth'>,
  ): void {
    if (!this.logger.info)
      return
    const recovery = context.recovery
    logRecoveryEvent({
      requestId: recovery.requestId,
      event,
      effectiveModel: context.effectiveModel,
      activeSlots: this.active,
      maxSlots: this.options.concurrency,
      pendingDepth: this.waiters.length,
      maxPendingDepth: this.options.maxQueueDepth,
      ...(recovery.startedAtMonotonicMs !== undefined
        ? {
            elapsedMs: Math.max(0, this.now() - recovery.startedAtMonotonicMs),
            remainingBudgetMs: this.remainingBudget(recovery),
          }
        : {}),
      ...fields,
    }, { info: this.logger.info.bind(this.logger) })
  }

  private cleanupWaiter(waiter: QueueWaiter): void {
    if (waiter.signal && waiter.onAbort)
      waiter.signal.removeEventListener('abort', waiter.onAbort)
  }
}

export function createDefaultUpstreamRequestQueue(): UpstreamRequestQueue {
  return new UpstreamRequestQueue(DEFAULT_UPSTREAM_QUEUE_OPTIONS)
}

export function parseRetryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get('retry-after')
  if (!value)
    return undefined

  if (RETRY_AFTER_SECONDS_RE.test(value)) {
    const seconds = Number(value)
    const milliseconds = seconds * 1_000
    return Number.isFinite(milliseconds) ? Math.ceil(milliseconds) : undefined
  }

  if (!RETRY_AFTER_HTTP_DATE_RE.test(value))
    return undefined
  const retryAt = Date.parse(value)
  if (Number.isNaN(retryAt))
    return undefined
  const serverDate = headers.get('date')
  const parsedServerDate = serverDate ? Date.parse(serverDate) : Number.NaN
  const reference = Number.isNaN(parsedServerDate) ? now : parsedServerDate
  return Math.max(0, retryAt - reference)
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

function normalizeOptions(
  options: Partial<UpstreamRequestQueueOptions>,
): UpstreamRequestQueueOptions {
  return {
    concurrency: Math.max(1, Math.floor(finiteOr(options.concurrency, DEFAULT_UPSTREAM_QUEUE_OPTIONS.concurrency))),
    maxRetries: Math.min(MAX_UPSTREAM_QUEUE_RETRIES, Math.max(0, Math.floor(finiteOr(options.maxRetries, DEFAULT_UPSTREAM_QUEUE_OPTIONS.maxRetries)))),
    baseDelayMs: Math.max(0, Math.floor(finiteOr(options.baseDelayMs, DEFAULT_UPSTREAM_QUEUE_OPTIONS.baseDelayMs))),
    maxDelayMs: Math.max(1, Math.floor(finiteOr(options.maxDelayMs, DEFAULT_UPSTREAM_QUEUE_OPTIONS.maxDelayMs))),
    maxQueueDepth: Math.max(1, Math.floor(finiteOr(options.maxQueueDepth, DEFAULT_UPSTREAM_QUEUE_OPTIONS.maxQueueDepth))),
    recoveryBudgetMs: Math.min(
      MAX_UPSTREAM_RECOVERY_BUDGET_SECONDS * 1_000,
      Math.max(
        MIN_UPSTREAM_RECOVERY_BUDGET_SECONDS * 1_000,
        Math.floor(finiteOr(options.recoveryBudgetMs, DEFAULT_UPSTREAM_QUEUE_OPTIONS.recoveryBudgetMs)),
      ),
    ),
  }
}

function mergeDefinedOptions(
  current: UpstreamRequestQueueOptions,
  next: Partial<UpstreamRequestQueueOptions>,
): UpstreamRequestQueueOptions {
  return {
    concurrency: next.concurrency ?? current.concurrency,
    maxRetries: next.maxRetries ?? current.maxRetries,
    baseDelayMs: next.baseDelayMs ?? current.baseDelayMs,
    maxDelayMs: next.maxDelayMs ?? current.maxDelayMs,
    maxQueueDepth: next.maxQueueDepth ?? current.maxQueueDepth,
    recoveryBudgetMs: next.recoveryBudgetMs ?? current.recoveryBudgetMs,
  }
}

function minDefined(current: number | undefined, next: number): number {
  return current === undefined ? next : Math.min(current, next)
}

function discardResponse(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {})
  }
  catch {
    // Cleanup is best effort; the causal upstream outcome remains authoritative.
  }
}

function ensureRetryAfter(response: Response, retryAfter: string): Response {
  if (response.headers.get('retry-after') === retryAfter)
    return response
  const headers = new Headers(response.headers)
  headers.set('retry-after', retryAfter)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function formatRetryAfter(delayMs: number): string {
  return String(Math.max(0, Math.ceil(delayMs / 1_000)))
}

function formatRequestContext(context: UpstreamRequestContext): string {
  try {
    const url = new URL(context.url)
    return `${context.method ?? 'GET'} ${url.pathname}`
  }
  catch {
    return `${context.method ?? 'GET'} ${context.url}`
  }
}

function abortableSleep(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal)
    return sleep(ms)
  signal.throwIfAborted()

  return new Promise<void>((resolve, reject) => {
    function cleanup() {
      signal.removeEventListener('abort', onAbort)
    }
    function onAbort() {
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    sleep(ms).then(
      () => {
        cleanup()
        resolve()
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function createDeadlineSignal(
  parent: AbortSignal | undefined,
  delayMs: number,
  setTimer: typeof globalThis.setTimeout,
  clearTimer: typeof globalThis.clearTimeout,
): { signal: AbortSignal, cleanup: () => void, timedOut: () => boolean } {
  const controller = new AbortController()
  let didTimeOut = false
  const timer = setTimer(() => {
    didTimeOut = true
    controller.abort(new DOMException('Recovery deadline exceeded', 'TimeoutError'))
  }, Math.max(0, delayMs))
  return {
    signal: parent
      ? AbortSignal.any([parent, controller.signal])
      : controller.signal,
    timedOut: () => didTimeOut,
    cleanup: () => clearTimer(timer),
  }
}

class RecoveryBudgetError extends Error {
  override readonly cause: unknown

  constructor(cause: unknown) {
    super('Upstream recovery deadline exceeded')
    this.name = 'RecoveryBudgetError'
    this.cause = cause
  }
}

function isRecoveryBudgetError(error: unknown): error is RecoveryBudgetError {
  return error instanceof RecoveryBudgetError
}

function createLocalCapacityError(recovery: UpstreamRecoveryRecord): HTTPError {
  const status = recovery.publicError?.status ?? 504
  const retryAfter = recovery.publicError?.retryAfter
    ?? (recovery.cooldown
      ? formatRetryAfter(recovery.cooldown.notBeforeMonotonicMs - (recovery.deadlineMonotonicMs ?? 0))
      : undefined)
  const error = new HTTPError(status, {
    error: {
      message: status === 429
        ? 'The upstream account is temporarily rate limited.'
        : status === 529
          ? 'The selected upstream model is temporarily overloaded.'
          : status === 504
            ? 'The upstream recovery budget was exhausted.'
            : `The last upstream attempt failed with status ${status}.`,
      type: status === 429
        ? 'rate_limit_error'
        : status === 529
          ? 'overloaded_error'
          : status === 504
            ? 'timeout_error'
            : 'upstream_error',
    },
  }, retryAfter ? { headers: { 'retry-after': retryAfter } } : undefined)
  return status === 529 ? new TerminalUpstreamRecoveryError(error, recovery) : error
}
