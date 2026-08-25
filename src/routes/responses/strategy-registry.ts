import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { StrategyEntry } from '~/dispatch'
import type { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import type { ResponsesPayload, ResponsesResult } from '~/types'

import { resolveInitiator } from '~/core/capi/request-context'
import { StrategyRegistry } from '~/dispatch'
import { runStrategy } from '~/lib/execution-strategy'
import { runtimeStore } from '~/state'

import { createResponsesPassthroughStrategy } from './strategy'

export interface ResponsesStrategyContext {
  requestId: string
  copilotClient: CopilotClient
  payload: ResponsesPayload
  upstreamSignal: ReturnType<typeof createUpstreamSignalFromConfig>
  requestContext: Partial<CapiRequestContext>
  vision: boolean
  initiator: 'user' | 'agent'
  decorateResponse?: (response: ResponsesResult) => ResponsesResult
  onTerminalResponse?: (response: ResponsesResult) => void
}

const responsesPassthroughEntry: StrategyEntry<ResponsesStrategyContext> = {
  name: 'responses-passthrough',
  canHandle: () => true,
  async execute(ctx) {
    const strategy = createResponsesPassthroughStrategy(ctx.copilotClient, ctx.payload, {
      vision: ctx.vision,
      initiator: resolveInitiator(ctx.initiator, ctx.requestContext),
      requestContext: ctx.requestContext,
      signal: ctx.upstreamSignal.signal,
      mapResponse: ctx.decorateResponse,
      onTerminalResponse: ctx.onTerminalResponse,
    })
    return await runStrategy(strategy, ctx.upstreamSignal, {
      onStreamError: error => runtimeStore.recordStreamError(ctx.requestId, error),
    })
  },
}

export const responsesStrategyRegistry = new StrategyRegistry<ResponsesStrategyContext>()
responsesStrategyRegistry.register(responsesPassthroughEntry)
