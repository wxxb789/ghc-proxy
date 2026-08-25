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
  upstreamErrorType,
} from '~/lib/error'
import { logRecoveryEvent } from '~/lib/request-logger'
import { runtimeStore } from '~/state/runtime'
import { formatDurationMs } from '~/util/duration'

export interface UpstreamRequestQueueOptions {
  concurrency: number
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  maxQueueDepth: number
  recoveryBudgetMs: number
}

export interface UpstreamRequestQueueSnapshot {
  active: number
  concurrency: number
  pending: number
  maxPending: number
  accountCooldown: boolean
  modelCooldowns: number
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

export interface RecoveryQueueMetrics {
  activeSlots: number
  maxSlots: number
  pendingDepth: number
  maxPendingDepth: number
}

export interface UpstreamRecoveryRecord {
  requestId: string
  callerRequestId?: string
  callerSignal?: AbortSignal
  retryCount: number
  retryLimit?: number
  startedAtMonotonicMs?: number
  deadlineMonotonicMs?: number
  sourceModel?: string
  cooldown?: RecoveryCooldownState
  publicError?: RecoveryPublicError
  fallbackFetchStarted?: boolean
  queueMetrics?: RecoveryQueueMetrics
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
  offerLocalModelCooldown?: boolean | ((effectiveModel: string) => boolean)
  fallbackAttempt?: boolean
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
  wakeAt?: number
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
  constructor(
    recovery: UpstreamRecoveryRecord,
    retryAfter: string,
  ) {
    super(new HTTPError(529, {
      error: {
        message: 'The selected upstream model is temporarily overloaded.',
        type: 'overloaded_error',
      },
    }, { headers: { 'retry-after': retryAfter } }), recovery)
    this.name = 'LocalModelCooldownError'
  }
}

export class FallbackCooldownError extends Error {
  readonly scope: Exclude<CapacityCooldownScope, 'request'>
  readonly effectiveModel?: string

  constructor(cooldown: RecoveryCooldownState) {
    super('Fallback target is locally cooled')
    this.name = 'FallbackCooldownError'
    this.scope = cooldown.scope as Exclude<CapacityCooldownScope, 'request'>
    this.effectiveModel = cooldown.effectiveModel
  }
}

export class UpstreamRequestQueue {
  private readonly sleep: ((ms: number) => Promise<void>) | undefined
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
  private readonly terminalRecoveries = new WeakSet<UpstreamRecoveryRecord>()

  constructor(
    options: Partial<UpstreamRequestQueueOptions> = {},
    deps: UpstreamRequestQueueDeps = {},
  ) {
    this.options = normalizeOptions(options)
    this.sleep = deps.sleep
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

  snapshot(): UpstreamRequestQueueSnapshot {
    this.clearExpiredModels()
    return {
      active: this.active,
      concurrency: this.options.concurrency,
      pending: this.waiters.length,
      maxPending: this.options.maxQueueDepth,
      accountCooldown: this.accountNotBefore > this.now(),
      modelCooldowns: this.modelNotBefore.size,
    }
  }

  async dispatch(
    fetcher: (signal?: AbortSignal) => Promise<Response>,
    inputContext: UpstreamRequestContext,
    signal?: AbortSignal,
  ): Promise<QueuedUpstreamResponse> {
    const recovery = inputContext.recovery ?? {
      requestId: crypto.randomUUID(),
      ...(signal ? { callerSignal: signal } : {}),
      retryCount: 0,
    }
    const context = { ...inputContext, recovery }
    recovery.sourceModel ??= context.effectiveModel

    signal?.throwIfAborted()
    this.throwIfFallbackCooled(context)

    const localCooldown = this.getActiveCooldown(context.effectiveModel)
    const offerLocalModelCooldown = typeof context.offerLocalModelCooldown === 'function'
      ? Boolean(
          context.effectiveModel
          && context.offerLocalModelCooldown(context.effectiveModel),
        )
      : context.offerLocalModelCooldown
    if (
      offerLocalModelCooldown
      && localCooldown?.scope === 'model'
      && localCooldown.notBeforeMonotonicMs > this.now()
    ) {
      this.startRecovery(recovery)
      this.setRecoveryCooldown(recovery, localCooldown)
      const retryAfter = formatRetryAfter(localCooldown.notBeforeMonotonicMs - this.now())
      recovery.publicError = { status: 529, retryAfter }
      this.emitTerminal('retry', context, {
        retryCount: recovery.retryCount,
        status: 529,
        scope: 'model',
        decision: 'local-cooldown',
      })
      throw new LocalModelCooldownError(
        recovery,
        retryAfter,
      )
    }

    try {
      return await this.runDispatch(fetcher, context, signal)
    }
    catch (error) {
      const connectionClass = isRetryableConnectionEstablishmentError(error)
      if (recovery.callerSignal?.aborted) {
        this.emitTerminal(
          recovery.startedAtMonotonicMs === undefined ? 'admission' : 'retry',
          context,
          { retryCount: recovery.retryCount, decision: 'cancelled' },
        )
      }
      else if (signal?.aborted) {
        this.emitTerminal('budget', context, {
          retryCount: recovery.retryCount,
          status: 504,
          decision: 'deadline-exceeded',
        })
      }
      else if (
        (error instanceof HTTPError && error.status === 504)
        || this.remainingBudget(recovery) === 0
      ) {
        this.emitTerminal('budget', context, {
          retryCount: recovery.retryCount,
          status: error instanceof HTTPError ? error.status : undefined,
          decision: 'deadline-exceeded',
        })
      }
      else if (connectionClass && !this.canRetry(recovery)) {
        this.emitTerminal('retry', context, {
          retryCount: recovery.retryCount,
          connectionClass,
          decision: 'retry-exhausted',
        })
      }
      else if (recovery.startedAtMonotonicMs !== undefined) {
        this.emitTerminal('retry', context, {
          retryCount: recovery.retryCount,
          status: error instanceof HTTPError ? error.status : undefined,
          connectionClass,
          decision: 'failed',
        })
      }
      throw error
    }
  }

  private async runDispatch(
    fetcher: (signal?: AbortSignal) => Promise<Response>,
    context: UpstreamRequestContext & { recovery: UpstreamRecoveryRecord },
    signal?: AbortSignal,
  ): Promise<QueuedUpstreamResponse> {
    const { recovery } = context

    let lastConnectionError: unknown

    for (;;) {
      signal?.throwIfAborted()
      this.throwIfRecoveryExpired(recovery, lastConnectionError)
      const lease = await this.acquire(context, signal, lastConnectionError)
      let response: Response

      try {
        this.throwIfRecoveryExpired(recovery, lastConnectionError)
        if (context.fallbackAttempt)
          recovery.fallbackFetchStarted = true
        response = await this.fetchBeforeDeadline(fetcher, signal, recovery, lastConnectionError)
        lastConnectionError = undefined
      }
      catch (error) {
        lease.release()
        if (signal?.aborted)
          throw signal.reason
        if (error instanceof RecoveryBudgetError)
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

      try {
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
          return this.committed(
            response,
            lease,
            context,
            capacity ? retryDelay : undefined,
            capacity ? 'capacity-terminal' : 'upstream-terminal',
          )
        }

        this.startRecovery(recovery)
        if (!capacity)
          recovery.publicError = { status }
        retryDelay ??= this.getRetryDelay(response, recovery.retryCount, recovery)
        const remaining = this.remainingBudget(recovery)
        const serverMinimumDoesNotFit = retryDelay.source === 'retry-after'
          && retryDelay.delayMs >= remaining

        if (!this.canRetry(recovery) || serverMinimumDoesNotFit) {
          const decision = serverMinimumDoesNotFit
            ? 'server-delay-exceeds-budget'
            : 'retry-limit'
          this.emitTerminal('budget', context, {
            retryCount: recovery.retryCount,
            status,
            scope,
            delaySource: retryDelay.source,
            delayMs: retryDelay.delayMs,
            remainingBudgetMs: remaining,
            decision,
          })
          return this.committed(
            response,
            lease,
            context,
            capacity ? retryDelay : undefined,
            decision,
          )
        }

        discardResponse(response)
        lease.release()
        recovery.retryCount++
        const statusLabel = status === 429
          ? 'rate limited (429)'
          : status === 529
            ? 'overloaded (529)'
            : String(status)
        this.logger.warn(
          [
            `Upstream ${statusLabel};`,
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
      catch (error) {
        discardResponse(response)
        lease.release()
        throw error
      }
    }
  }

  private async acquire(
    context: UpstreamRequestContext & { recovery: UpstreamRecoveryRecord },
    signal?: AbortSignal,
    causalError?: unknown,
  ): Promise<QueueLease> {
    signal?.throwIfAborted()
    this.throwIfFallbackCooled(context)
    this.prepareCooldownWait(context)
    this.throwIfRecoveryExpired(context.recovery, causalError)

    const eligible = this.isEligible(context)
    if (
      this.active < this.options.concurrency
      && (eligible || (this.drainTimerAt !== undefined && this.drainTimerAt <= this.now()))
    ) {
      this.drain()
      if (eligible && this.active < this.options.concurrency)
        return this.grant(context, 0)
    }

    if (this.waiters.length >= this.options.maxQueueDepth) {
      this.drain()
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
          if (
            waiter.wakeAt === this.drainTimerAt
            && !this.waiters.some(candidate => candidate.wakeAt === waiter.wakeAt)
          ) {
            this.scheduleNextWake()
          }
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
      this.emit('admission', context, { decision: 'queued' })
      this.scheduleNextWake(waiter)
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
      const fallbackCooldown = waiter.context.fallbackAttempt
        ? this.getActiveCooldown(waiter.context.effectiveModel)
        : undefined
      if (fallbackCooldown) {
        this.waiters.splice(index, 1)
        this.cleanupWaiter(waiter)
        this.emit('admission', waiter.context, {
          scope: fallbackCooldown.scope,
          decision: 'fallback-cooldown',
        })
        waiter.reject(new FallbackCooldownError(fallbackCooldown))
        continue
      }
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

  private scheduleNextWake(addedWaiter?: QueueWaiter): void {
    const now = this.now()
    if (addedWaiter) {
      const wakeAt = this.getWaiterWakeAt(addedWaiter, now)
      addedWaiter.wakeAt = wakeAt
      if (
        wakeAt === undefined
        || (this.drainTimerAt !== undefined && wakeAt >= this.drainTimerAt)
      ) {
        return
      }
      this.replaceDrainTimer(wakeAt, now)
      return
    }

    let wakeAt: number | undefined

    for (const waiter of this.waiters) {
      waiter.wakeAt = this.getWaiterWakeAt(waiter, now)
      if (waiter.wakeAt !== undefined)
        wakeAt = Math.min(wakeAt ?? Number.POSITIVE_INFINITY, waiter.wakeAt)
    }

    this.replaceDrainTimer(wakeAt, now)
  }

  private getWaiterWakeAt(waiter: QueueWaiter, now: number): number | undefined {
    let wakeAt: number | undefined
    const cooldown = this.getActiveCooldown(waiter.context.effectiveModel)
    if (cooldown && cooldown.notBeforeMonotonicMs > now)
      wakeAt = cooldown.notBeforeMonotonicMs
    const deadline = waiter.context.recovery.deadlineMonotonicMs
    if (deadline !== undefined && deadline > now)
      wakeAt = Math.min(wakeAt ?? Number.POSITIVE_INFINITY, deadline)
    return wakeAt
  }

  private replaceDrainTimer(wakeAt: number | undefined, now: number): void {
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

  private throwIfFallbackCooled(context: UpstreamRequestContext): void {
    if (!context.fallbackAttempt)
      return
    const cooldown = this.getActiveCooldown(context.effectiveModel)
    if (cooldown)
      throw new FallbackCooldownError(cooldown)
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
    let stored = deadline
    if (scope === 'account') {
      this.accountNotBefore = Math.max(this.accountNotBefore, deadline)
      stored = this.accountNotBefore
    }
    else if (scope === 'model' && effectiveModel) {
      stored = Math.max(this.modelNotBefore.get(effectiveModel) ?? 0, deadline)
      this.modelNotBefore.set(effectiveModel, stored)
    }

    this.setRecoveryCooldown(context.recovery, {
      scope,
      notBeforeMonotonicMs: stored,
      ...(effectiveModel && scope === 'model' ? { effectiveModel } : {}),
    })
    this.emit('cooldown', context, {
      scope,
      delayMs,
      nextRetryAt: formatNextRetryAt(this.wallNow() + delayMs),
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
      await abortableSleep(
        this.sleep,
        delayMs,
        deadline.signal,
        this.setTimer,
        this.clearTimer,
      )
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
        throw new RecoveryBudgetError(
          recovery.fallbackFetchStarted
            ? createRecoveryTimeoutError()
            : lastConnectionError ?? createLocalCapacityError(recovery),
        )
      }
      return response
    }
    catch (error) {
      if (signal?.aborted)
        throw signal.reason
      if (deadline.timedOut()) {
        throw new RecoveryBudgetError(
          recovery.fallbackFetchStarted
            ? createRecoveryTimeoutError()
            : lastConnectionError ?? createLocalCapacityError(recovery),
        )
      }
      throw error
    }
    finally {
      deadline.cleanup()
    }
  }

  private committed(
    response: Response,
    lease: QueueLease,
    context: UpstreamRequestContext & { recovery: UpstreamRecoveryRecord },
    retryDelay?: RetryDelay,
    terminalDecision = 'upstream-terminal',
  ): QueuedUpstreamResponse {
    const { recovery } = context
    if (recovery.startedAtMonotonicMs !== undefined) {
      this.emitTerminal('retry', context, {
        retryCount: recovery.retryCount,
        status: response.status,
        scope: resolveCapacityCooldownScope(response.status, context.effectiveModel),
        decision: response.ok ? 'recovered' : terminalDecision,
      })
    }
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
    const recovery = context.recovery
    recovery.queueMetrics = {
      activeSlots: this.active,
      maxSlots: this.options.concurrency,
      pendingDepth: this.waiters.length,
      maxPendingDepth: this.options.maxQueueDepth,
    }
    const eventFields: RecoveryEvent = {
      requestId: recovery.requestId,
      callerRequestId: recovery.callerRequestId,
      event,
      effectiveModel: context.effectiveModel,
      ...recovery.queueMetrics,
      ...(recovery.startedAtMonotonicMs !== undefined
        ? {
            elapsedMs: Math.max(0, this.now() - recovery.startedAtMonotonicMs),
            remainingBudgetMs: this.remainingBudget(recovery),
          }
        : {}),
      ...fields,
    }
    recordRecoveryEffect(eventFields)
    if (!this.logger.info)
      return
    if (this.logger === consola)
      logRecoveryEvent(eventFields)
    else
      logRecoveryEvent(eventFields, { info: this.logger.info.bind(this.logger) })
  }

  private emitTerminal(
    event: RecoveryEvent['event'],
    context: UpstreamRequestContext & { recovery: UpstreamRecoveryRecord },
    fields: Omit<RecoveryEvent, 'requestId' | 'event' | 'effectiveModel' | 'activeSlots' | 'maxSlots' | 'pendingDepth' | 'maxPendingDepth'>,
  ): void {
    if (this.terminalRecoveries.has(context.recovery))
      return
    this.terminalRecoveries.add(context.recovery)
    this.emit(event, context, fields)
  }

  private cleanupWaiter(waiter: QueueWaiter): void {
    if (waiter.signal && waiter.onAbort)
      waiter.signal.removeEventListener('abort', waiter.onAbort)
  }
}

function recordRecoveryEffect(event: RecoveryEvent): void {
  if (event.event === 'grant' && (event.queueWaitMs ?? 0) > 0) {
    runtimeStore.requests.recordEffect(event.requestId, 'recovery.queued')
    return
  }
  if (event.event === 'retry' && event.decision === 'retry') {
    runtimeStore.requests.recordEffect(event.requestId, 'recovery.retry')
    return
  }
  if (event.event === 'cooldown') {
    runtimeStore.requests.recordEffect(event.requestId, 'recovery.cooldown')
    return
  }
  if (
    event.event === 'budget'
    && (
      event.decision === 'deadline-exceeded'
      || event.decision === 'server-delay-exceeds-budget'
    )
  ) {
    runtimeStore.requests.recordEffect(event.requestId, 'recovery.budget_exhausted')
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

function formatNextRetryAt(timestampMs: number): string | undefined {
  const retryAt = new Date(timestampMs)
  return Number.isNaN(retryAt.getTime()) ? undefined : retryAt.toISOString()
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
  sleep: ((ms: number) => Promise<void>) | undefined,
  ms: number,
  signal?: AbortSignal,
  setTimer: typeof globalThis.setTimeout = globalThis.setTimeout,
  clearTimer: typeof globalThis.clearTimeout = globalThis.clearTimeout,
): Promise<void> {
  if (sleep && !signal)
    return sleep(ms)
  signal?.throwIfAborted()

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    function cleanup() {
      if (timer !== undefined)
        clearTimer(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    function onAbort() {
      cleanup()
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    if (!sleep) {
      timer = setTimer(() => {
        cleanup()
        resolve()
      }, ms)
      return
    }

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

function createRecoveryTimeoutError(): HTTPError {
  return new HTTPError(504, {
    error: {
      message: localCapacityErrorMessage(504),
      type: 'timeout_error',
    },
  })
}

function createLocalCapacityError(recovery: UpstreamRecoveryRecord): HTTPError {
  const status = recovery.publicError?.status ?? 504
  const retryAfter = recovery.publicError?.retryAfter
    ?? (recovery.cooldown
      ? formatRetryAfter(recovery.cooldown.notBeforeMonotonicMs - (recovery.deadlineMonotonicMs ?? 0))
      : undefined)
  const errorType = status === 504 ? 'timeout_error' : upstreamErrorType(status)
  const error = new HTTPError(status, {
    error: {
      message: localCapacityErrorMessage(status),
      type: errorType,
    },
  }, retryAfter ? { headers: { 'retry-after': retryAfter } } : undefined)
  return status === 529 ? new TerminalUpstreamRecoveryError(error, recovery) : error
}

function localCapacityErrorMessage(status: number): string {
  switch (status) {
    case 429:
      return 'The upstream account is temporarily rate limited.'
    case 529:
      return 'The selected upstream model is temporarily overloaded.'
    case 504:
      return 'The upstream recovery budget was exhausted.'
    default:
      return `The last upstream attempt failed with status ${status}.`
  }
}
