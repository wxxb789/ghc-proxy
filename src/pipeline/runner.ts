import type { CopilotClient } from '~/clients'
import type { StrategyRegistry } from '~/dispatch'
import type { ProtocolId, RequestMeta } from '~/ingest'
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo } from '~/lib/request-logger'
import type { Model } from '~/types'

import { createCopilotClient } from '~/clients/factory'
import { protocolRegistry } from '~/ingest'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { resolveRequestModel } from '~/transform/resolve-model'

export interface PipelineParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
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
  const ingested = protocolRegistry.ingest<TPayload>(
    config.protocol,
    params.body,
    params.headers,
  )
  const meta = ingested.meta

  const payload = config.afterIngest
    ? config.afterIngest({ payload: ingested.payload, meta, headers: params.headers })
    : ingested.payload

  const { resolvedModel: selectedModel, modelMapping } = resolveRequestModel({
    payload: payload as { model: string },
    betaHeaders: meta.betaHeaders,
    applyPolicy: config.applyModelPolicy,
  })

  if (config.afterTransform) {
    await config.afterTransform({ payload, meta, headers: params.headers, selectedModel })
  }

  const upstreamSignal = createUpstreamSignalFromConfig(params.signal)
  const copilotClient = createCopilotClient()

  const ctx = config.buildStrategyContext({
    payload,
    meta,
    headers: params.headers,
    selectedModel,
    copilotClient,
    upstreamSignal,
    modelMapping,
  })
  const entry = config.strategyRegistry.select(selectedModel, ctx)
  const result = await entry.execute(ctx)

  return { result, modelMapping }
}
