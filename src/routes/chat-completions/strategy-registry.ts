import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { StrategyEntry } from '~/dispatch'
import type { ModelMappingInfo } from '~/lib/request-logger'
import type { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import type { ChatCompletionsPayload } from '~/types'

import consola from 'consola'
import { OpenAIChatAdapter } from '~/adapters'
import { StrategyRegistry } from '~/dispatch'
import { runStrategy } from '~/lib/execution-strategy'
import { appendModelStepInPlace } from '~/lib/request-logger'

import { createChatCompletionsStrategy } from './strategy'

export interface ChatCompletionsStrategyContext {
  copilotClient: CopilotClient
  payload: ChatCompletionsPayload
  upstreamSignal: ReturnType<typeof createUpstreamSignalFromConfig>
  requestContext: Partial<CapiRequestContext>
  modelMapping: ModelMappingInfo
}

const chatCompletionsEntry: StrategyEntry<ChatCompletionsStrategyContext> = {
  name: 'chat-completions',
  canHandle: () => true,
  async execute(ctx) {
    const adapter = new OpenAIChatAdapter()
    const plan = adapter.toCapiPlan(ctx.payload, {
      requestContext: ctx.requestContext,
    })

    appendModelStepInPlace(ctx.modelMapping, 'MODEL_RESOLVE', plan.resolvedModel)

    consola.debug('Streaming response')
    const strategy = createChatCompletionsStrategy(ctx.copilotClient, adapter, plan, ctx.upstreamSignal.signal)
    return await runStrategy(strategy, ctx.upstreamSignal)
  },
}

export const chatCompletionsStrategyRegistry = new StrategyRegistry<ChatCompletionsStrategyContext>()
chatCompletionsStrategyRegistry.register(chatCompletionsEntry)
