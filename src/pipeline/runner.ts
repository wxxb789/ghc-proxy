import type { CopilotClient } from '~/clients'
import type { UpstreamRecoveryRecord } from '~/clients/upstream-queue'
import type { StrategyRegistry } from '~/dispatch'
import type { ProtocolId, RequestMeta } from '~/ingest'
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo } from '~/lib/request-logger'
import type { Model } from '~/types'

import { createCopilotClient } from '~/clients/factory'
import {
  FallbackCooldownError,
  TerminalUpstreamRecoveryError,
} from '~/clients/upstream-queue'
import { protocolRegistry } from '~/ingest'
import { HTTPError, isRetryableConnectionEstablishmentError } from '~/lib/error'
import {
  appendModelStepInPlace,
  getEffectiveModel,
  logRecoveryEvent,
} from '~/lib/request-logger'
import {
  createUpstreamDeadlineFromConfig,
  createUpstreamSignalFromConfig,
} from '~/lib/upstream-signal'
import { effectForStrategy } from '~/observability/effects'
import { configStore, getCurrentRoutedAccountName, MESSAGES_ENDPOINT, modelCache, RESPONSES_ENDPOINT, runtimeStore } from '~/state'
import { resolveRequestModel } from '~/transform/resolve-model'

export interface PipelineParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
  requestId: string
  callerRequestId?: string
}

export interface PipelineResult {
  result: ExecutionResult
  modelMapping: ModelMappingInfo
}

export interface IngestContext<TPayload> {
  payload: TPayload
  meta: RequestMeta
  headers: Headers
}

export interface TransformContext<TPayload> {
  payload: TPayload
  meta: RequestMeta
  headers: Headers
  selectedModel: Model | undefined
}

export interface PipelineConfig<TPayload, TStrategyCtx> {
  protocol: ProtocolId
  /**
   * Apply compact small-model routing. Only `/v1/messages` sends an
   * Anthropic-shaped payload for the policy to inspect.
   */
  applyModelPolicy?: boolean
  strategyRegistry: StrategyRegistry<TStrategyCtx>
  buildStrategyContext: (ctx: {
    payload: TPayload
    meta: RequestMeta
    headers: Headers
    selectedModel: Model | undefined
    copilotClient: CopilotClient
    upstreamSignal: ReturnType<typeof createUpstreamSignalFromConfig>
    modelMapping: ModelMappingInfo
    recovery: UpstreamRecoveryRecord
  }) => TStrategyCtx
  /**
   * Runs immediately after ingest, before transform. Resolves the payload that
   * flows into transform + dispatch — the return value is REQUIRED.
   *
   * - Side-effect callers (logging, capturing the original payload, parsing
   *   headers) end with `return ctx.payload` to forward the ingested payload
   *   unchanged.
   * - Replacement callers return a different payload to substitute it (e.g.
   *   `/responses` swaps in the emulator's upstream payload).
   *
   * The required `TPayload` return is deliberate: a replacement caller that
   * forgets to return is a compile error (`void` is not assignable to
   * `TPayload`), not a silent fallback to the un-replaced payload.
   */
  afterIngest?: (ctx: IngestContext<TPayload>) => TPayload
  afterTransform?: (ctx: TransformContext<TPayload>) => void | Promise<void>
}

export async function runPipeline<TPayload, TStrategyCtx>(
  params: PipelineParams,
  config: PipelineConfig<TPayload, TStrategyCtx>,
): Promise<PipelineResult> {
  const upstreamDeadlineMonotonicMs = createUpstreamDeadlineFromConfig()
  const recovery = createRecoveryRecord(params)
  const ingested = protocolRegistry.ingest<TPayload>(
    config.protocol,
    params.body,
    params.headers,
  )
  const meta = ingested.meta

  const payload = config.afterIngest
    ? config.afterIngest({ payload: ingested.payload, meta, headers: params.headers })
    : ingested.payload
  const baseSourceModel = resolveBaseModel(payload, meta, config)
  const fallbackPossible = shouldPreservePristinePayload(
    config.protocol,
    baseSourceModel,
  )
  const pristinePayload = fallbackPossible
    ? structuredClone(payload)
    : payload
  const sourceAttempt = await prepareAttempt(
    payload,
    meta,
    params,
    config,
    recovery,
    upstreamDeadlineMonotonicMs,
    {
      offerLocalModelCooldown: sourceModel => fallbackPossible
        && validateFallback(config.protocol, pristinePayload, sourceModel).ok,
    },
  )
  sourceAttempt.commitObservability()

  try {
    const result = await sourceAttempt.execute()
    return { result, modelMapping: sourceAttempt.modelMapping }
  }
  catch (error) {
    if (!(error instanceof TerminalUpstreamRecoveryError) || error.status !== 529)
      throw error

    const sourceModel = error.recovery.sourceModel
    if (!sourceModel) {
      emitFallbackEvent(error.recovery, undefined, 'missing-source-model', 529)
      throw error
    }

    const candidate = fallbackPossible
      ? validateFallback(config.protocol, pristinePayload, sourceModel)
      : { ok: false, reason: 'not-configured' } as const
    if (!candidate.ok) {
      emitFallbackEvent(error.recovery, sourceModel, candidate.reason, 529)
      throw error
    }

    if (
      sourceAttempt.baseModel !== resolveBaseModel(pristinePayload, meta, config)
      || getEffectiveModel(sourceAttempt.modelMapping) !== sourceModel
    ) {
      emitFallbackEvent(error.recovery, sourceModel, 'source-resolution-changed', 529)
      throw error
    }

    params.signal.throwIfAborted()
    if (!error.claimFallback())
      throw error
    error.recovery.fallbackFetchStarted = false

    const fallbackMapping: ModelMappingInfo = {
      originalModel: sourceAttempt.modelMapping.originalModel,
      steps: [...sourceAttempt.modelMapping.steps],
    }
    appendModelStepInPlace(
      fallbackMapping,
      'OVERLOAD_FALLBACK',
      candidate.target.id,
    )

    let fallbackAttempt: PreparedAttempt
    try {
      fallbackAttempt = await prepareAttempt(
        structuredClone(pristinePayload),
        meta,
        params,
        config,
        error.recovery,
        upstreamDeadlineMonotonicMs,
        {
          target: candidate.target,
          modelMapping: fallbackMapping,
          fallbackAttempt: true,
        },
      )
    }
    catch {
      if (params.signal.aborted)
        throw params.signal.reason
      emitFallbackEvent(error.recovery, candidate.target.id, 'preflight-rejected', 529)
      throw error
    }

    error.recovery.retryLimit = error.recovery.retryCount
    emitFallbackEvent(error.recovery, candidate.target.id, 'selected', 529)
    error.recovery.onFallbackFetchStart = fallbackAttempt.commitObservability

    try {
      const result = await fallbackAttempt.execute()
      fallbackAttempt.commitObservability()
      emitFallbackEvent(error.recovery, candidate.target.id, 'succeeded')
      return {
        result: discloseActualModel(result, candidate.target.id),
        modelMapping: fallbackMapping,
      }
    }
    catch (fallbackError) {
      if (error.recovery.fallbackFetchStarted)
        fallbackAttempt.commitObservability()
      else
        fallbackAttempt.discardObservability()
      if (params.signal.aborted)
        throw params.signal.reason
      if (fallbackError instanceof FallbackCooldownError) {
        emitFallbackEvent(error.recovery, candidate.target.id, 'target-cooldown', 529)
        throw error
      }
      if (!error.recovery.fallbackFetchStarted) {
        emitFallbackEvent(error.recovery, candidate.target.id, 'pre-fetch-failed', 529)
        throw error
      }
      emitFallbackEvent(
        error.recovery,
        candidate.target.id,
        'target-failed',
        fallbackError instanceof HTTPError ? fallbackError.status : undefined,
        isRetryableConnectionEstablishmentError(fallbackError),
      )
      throw fallbackError
    }
    finally {
      delete error.recovery.onFallbackFetchStart
    }
  }
}

interface PreparedAttempt {
  baseModel: string
  modelMapping: ModelMappingInfo
  commitObservability: () => void
  discardObservability: () => void
  execute: () => Promise<ExecutionResult>
}

interface AttemptOptions {
  target?: Model
  modelMapping?: ModelMappingInfo
  offerLocalModelCooldown?: (effectiveModel: string) => boolean
  fallbackAttempt?: boolean
}

async function prepareAttempt<TPayload, TStrategyCtx>(
  payload: TPayload,
  meta: RequestMeta,
  params: PipelineParams,
  config: PipelineConfig<TPayload, TStrategyCtx>,
  recovery: UpstreamRecoveryRecord,
  upstreamDeadlineMonotonicMs: number | null,
  options: AttemptOptions = {},
): Promise<PreparedAttempt> {
  const resolved = resolveRequestModel({
    payload: payload as { model: string },
    betaHeaders: meta.betaHeaders,
    applyPolicy: config.applyModelPolicy,
  })
  const baseModel = resolved.model
  const selectedModel = options.target ?? resolved.resolvedModel
  const modelMapping = options.modelMapping ?? resolved.modelMapping
  const deferObservability = options.fallbackAttempt === true
  if (deferObservability)
    runtimeStore.requests.beginEffectBuffer(params.requestId)
  else
    runtimeStore.requests.recordModelMapping(params.requestId, modelMapping)
  const recordedModelStepCount = modelMapping.steps.length

  try {
    if (options.target)
      (payload as { model: string }).model = options.target.id

    if (config.afterTransform)
      await config.afterTransform({ payload, meta, headers: params.headers, selectedModel })
  }
  catch (error) {
    if (deferObservability)
      runtimeStore.requests.discardEffectBuffer(params.requestId)
    throw error
  }

  params.signal.throwIfAborted()
  const upstreamSignal = createUpstreamSignalFromConfig(
    params.signal,
    upstreamDeadlineMonotonicMs,
    () => runtimeStore.requests.markAborted(params.requestId),
  )
  const copilotClient = createCopilotClient(recovery, {
    offerLocalModelCooldown: options.offerLocalModelCooldown,
    fallbackAttempt: options.fallbackAttempt,
  })
  try {
    const ctx = config.buildStrategyContext({
      payload,
      meta,
      headers: params.headers,
      selectedModel,
      copilotClient,
      upstreamSignal,
      modelMapping,
      recovery,
    })
    const entry = config.strategyRegistry.select(selectedModel, ctx)
    const strategyEffect = effectForStrategy(config.protocol, entry.name)
    let observabilityCommitted = !deferObservability
    let observabilityDiscarded = false
    if (!deferObservability) {
      runtimeStore.requests.recordStrategy(params.requestId, entry.name)
      if (strategyEffect)
        runtimeStore.requests.recordEffect(params.requestId, strategyEffect)
    }
    const commitObservability = () => {
      if (observabilityCommitted || observabilityDiscarded)
        return
      observabilityCommitted = true
      runtimeStore.requests.recordModelMapping(params.requestId, modelMapping)
      runtimeStore.requests.recordStrategy(params.requestId, entry.name)
      if (strategyEffect)
        runtimeStore.requests.recordEffect(params.requestId, strategyEffect)
      runtimeStore.requests.commitEffectBuffer(params.requestId)
    }
    const discardObservability = () => {
      if (observabilityCommitted || observabilityDiscarded)
        return
      observabilityDiscarded = true
      runtimeStore.requests.discardEffectBuffer(params.requestId)
    }
    return {
      baseModel,
      modelMapping,
      commitObservability,
      discardObservability,
      execute: async () => {
        try {
          params.signal.throwIfAborted()
          return await entry.execute(ctx)
        }
        catch (error) {
          upstreamSignal.cleanup()
          throw error
        }
        finally {
          if (
            observabilityCommitted
            && modelMapping.steps.length !== recordedModelStepCount
          ) {
            runtimeStore.requests.recordModelMapping(params.requestId, modelMapping)
          }
        }
      },
    }
  }
  catch (error) {
    upstreamSignal.cleanup()
    if (deferObservability)
      runtimeStore.requests.discardEffectBuffer(params.requestId)
    throw error
  }
}

function resolveBaseModel<TPayload, TStrategyCtx>(
  pristinePayload: TPayload,
  meta: RequestMeta,
  config: PipelineConfig<TPayload, TStrategyCtx>,
): string {
  const payload = { ...pristinePayload as { model: string } }
  return resolveRequestModel({
    payload,
    betaHeaders: meta.betaHeaders,
    applyPolicy: config.applyModelPolicy,
  }).model
}

function shouldPreservePristinePayload(
  protocol: ProtocolId,
  baseSourceModel: string,
): boolean {
  if (configStore.getOverloadFallback(baseSourceModel)?.trim())
    return true
  if (protocol !== 'anthropic-messages' || !configStore.hasOverloadFallbacks())
    return false

  const model = modelCache.findById(baseSourceModel)
  return !model
    || (
      !modelCache.supportsEndpoint(model, MESSAGES_ENDPOINT)
      && !modelCache.supportsEndpoint(model, RESPONSES_ENDPOINT)
    )
}

type FallbackValidation
  = | { ok: true, target: Model }
    | { ok: false, reason: string }

function validateFallback(
  protocol: ProtocolId,
  payload: unknown,
  sourceModel: string,
): FallbackValidation {
  const targetId = configStore.getOverloadFallback(sourceModel)?.trim()
  if (!targetId)
    return { ok: false, reason: 'not-configured' }
  if (targetId === sourceModel)
    return { ok: false, reason: 'same-model' }

  const target = modelCache.findById(targetId)
  if (!target)
    return { ok: false, reason: 'unknown-target' }
  if (protocol === 'responses' && !modelCache.supportsEndpoint(target, RESPONSES_ENDPOINT))
    return { ok: false, reason: 'unsupported-endpoint' }
  if (requestsTools(payload) && !modelCache.supportsToolCalls(target))
    return { ok: false, reason: 'unsupported-tools' }
  if (
    requestsParallelToolCalls(protocol, payload)
    && target.capabilities.supports.parallel_tool_calls !== true
  ) {
    return { ok: false, reason: 'unsupported-parallel-tools' }
  }
  if (requestsStreaming(payload) && target.capabilities.supports.streaming === false)
    return { ok: false, reason: 'unsupported-streaming' }
  if (requestsVision(payload) && !modelCache.supportsVision(target))
    return { ok: false, reason: 'unsupported-vision' }
  if (requestsReasoningEffort(protocol, payload) && !modelCache.supportsReasoningEffort(target))
    return { ok: false, reason: 'unsupported-reasoning' }
  if (
    requestsThinking(protocol, payload)
    && !modelCache.supportsAdaptiveThinking(target)
    && !modelCache.supportsReasoningEffort(target)
  ) {
    return { ok: false, reason: 'unsupported-thinking' }
  }
  if (requestsStructuredOutput(protocol, payload) && !supportsStructuredOutput(protocol, target))
    return { ok: false, reason: 'unsupported-structured-output' }

  return { ok: true, target }
}

function requestsTools(payload: unknown): boolean {
  const tools = asRecord(payload)?.tools
  return Array.isArray(tools) && tools.length > 0
}

function requestsParallelToolCalls(protocol: ProtocolId, payload: unknown): boolean {
  if (protocol === 'anthropic-messages')
    return requestsTools(payload)
  return asRecord(payload)?.parallel_tool_calls === true
}

function requestsStreaming(payload: unknown): boolean {
  return asRecord(payload)?.stream === true
}

function requestsVision(payload: unknown): boolean {
  return containsVisionPart(asRecord(payload)?.messages)
    || containsVisionPart(asRecord(payload)?.input)
}

function containsVisionPart(value: unknown): boolean {
  if (Array.isArray(value))
    return value.some(containsVisionPart)
  const record = asRecord(value)
  if (!record)
    return false
  if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image')
    return true
  return containsVisionPart(record.content)
}

function requestsReasoningEffort(protocol: ProtocolId, payload: unknown): boolean {
  const record = asRecord(payload)
  if (!record)
    return false
  const effort = protocol === 'anthropic-messages'
    ? asRecord(record.output_config)?.effort
    : protocol === 'responses'
      ? asRecord(record.reasoning)?.effort
      : record.reasoning_effort
  return effort !== undefined && effort !== 'none'
}

function requestsThinking(protocol: ProtocolId, payload: unknown): boolean {
  const record = asRecord(payload)
  if (!record)
    return false
  if (protocol === 'anthropic-messages') {
    const type = asRecord(record.thinking)?.type
    return type === 'enabled' || type === 'adaptive'
  }
  if (protocol === 'openai-chat')
    return typeof record.thinking_budget === 'number' && record.thinking_budget > 0
  return false
}

function requestsStructuredOutput(protocol: ProtocolId, payload: unknown): boolean {
  const record = asRecord(payload)
  if (!record)
    return false
  if (protocol === 'anthropic-messages')
    return asRecord(record.output_config)?.format !== undefined
  if (protocol === 'responses') {
    const type = asRecord(asRecord(record.text)?.format)?.type
    return type !== undefined && type !== 'text'
  }
  const responseFormat = asRecord(record.response_format)
  return responseFormat?.type !== undefined && responseFormat.type !== 'text'
}

function supportsStructuredOutput(protocol: ProtocolId, model: Model): boolean {
  if (protocol === 'anthropic-messages') {
    return modelCache.supportsStructuredOutputs(model)
      || modelCache.supportsEndpoint(model, RESPONSES_ENDPOINT)
  }
  return model.capabilities.supports.structured_outputs ?? false
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function discloseActualModel(result: ExecutionResult, model: string): ExecutionResult {
  if (result.kind === 'json') {
    return {
      kind: 'json',
      data: replaceKnownModelIdentity(result.data, model),
    }
  }

  return {
    kind: 'stream',
    generator: discloseStreamModel(result.generator, model),
  }
}

async function* discloseStreamModel(
  generator: AsyncGenerator<{ id?: string, event?: string, data: string }>,
  model: string,
): AsyncGenerator<{ id?: string, event?: string, data: string }> {
  for await (const chunk of generator) {
    if (!chunk.data || chunk.data === '[DONE]') {
      yield chunk
      continue
    }
    try {
      const parsed = JSON.parse(chunk.data) as unknown
      const replaced = replaceKnownModelIdentity(parsed, model)
      yield replaced === parsed ? chunk : { ...chunk, data: JSON.stringify(replaced) }
    }
    catch {
      yield chunk
    }
  }
}

function replaceKnownModelIdentity(value: unknown, model: string): unknown {
  const record = asRecord(value)
  if (!record)
    return value

  let changed = false
  const next = { ...record }
  if (typeof record.model === 'string') {
    next.model = model
    changed = true
  }
  for (const key of ['message', 'response'] as const) {
    const nested = asRecord(record[key])
    if (nested && typeof nested.model === 'string') {
      next[key] = { ...nested, model }
      changed = true
    }
  }
  return changed ? next : value
}

function emitFallbackEvent(
  recovery: UpstreamRecoveryRecord,
  effectiveModel: string | undefined,
  decision: string,
  status?: number,
  connectionClass?: string,
): void {
  const now = performance.now()
  logRecoveryEvent({
    requestId: recovery.requestId,
    accountName: recovery.accountName,
    callerRequestId: recovery.callerRequestId,
    event: 'fallback',
    retryCount: recovery.retryCount,
    effectiveModel,
    status,
    connectionClass,
    ...recovery.queueMetrics,
    ...(recovery.startedAtMonotonicMs !== undefined
      ? { elapsedMs: Math.max(0, now - recovery.startedAtMonotonicMs) }
      : {}),
    ...(recovery.deadlineMonotonicMs !== undefined
      ? { remainingBudgetMs: Math.max(0, recovery.deadlineMonotonicMs - now) }
      : {}),
    decision,
  })
}

export function createRecoveryRecord(
  request: Pick<PipelineParams, 'requestId' | 'callerRequestId' | 'signal'>,
): UpstreamRecoveryRecord {
  return {
    requestId: request.requestId,
    accountName: getCurrentRoutedAccountName(),
    ...(request.callerRequestId ? { callerRequestId: request.callerRequestId } : {}),
    callerSignal: request.signal,
    retryCount: 0,
  }
}
