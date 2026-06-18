import type { CopilotClient } from '~/clients'
import type { StrategyRegistry } from '~/dispatch'
import type { ProtocolId, RequestMeta } from '~/ingest'
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo, ModelTransformTag } from '~/lib/request-logger'
import type { ModelTransformResult } from '~/pipeline/types'
import type { ModelTransformChain } from '~/transform'
import type { Model } from '~/types'

import { createCopilotClient } from '~/clients/factory'
import { protocolRegistry } from '~/ingest'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'

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
  transformResult: ModelTransformResult
  selectedModel: Model | undefined
}

export interface PipelineConfig<TPayload, TStrategyCtx> {
  protocol: ProtocolId
  transformChain: ModelTransformChain
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
  afterIngest?: (ctx: IngestContext<TPayload>) => TPayload | void
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

  const payload = config.afterIngest?.({ payload: ingested.payload, meta, headers: params.headers })
    ?? ingested.payload

  const transformResult = config.transformChain.apply({
    model: (payload as Record<string, string>).model,
    payload,
    headers: params.headers,
    meta: { betaHeaders: meta.betaHeaders },
  })

  ;(payload as Record<string, string>).model = transformResult.model
  const selectedModel = transformResult.resolvedModel

  const originalModel = transformResult.trace.length > 0
    ? transformResult.trace[0].from
    : (payload as Record<string, string>).model
  const modelMapping: ModelMappingInfo = {
    originalModel,
    steps: transformResult.trace.map(r => ({
      tag: r.tag as ModelTransformTag,
      from: r.from,
      to: r.to,
    })),
  }

  if (config.afterTransform) {
    await config.afterTransform({ payload, meta, headers: params.headers, transformResult, selectedModel })
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
