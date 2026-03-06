import type { AnthropicOpenAIMapperOptions } from './anthropic-openai-mapper'

import type { TranslationIssue } from './translation-issue'
import type { TranslationPolicy } from './translation-policy'

import type {
  AnthropicCountTokensPayload,
  AnthropicMessagesPayload,
  AnthropicResponse,
} from './types'
import type { CapiChatCompletionResponse } from '~/core/capi'
import type { ChatCompletionsPayload } from '~/types'

import { AnthropicMessagesAdapter } from '~/adapters'
import { defaultTranslationPolicy } from './translation-policy'

export interface AnthropicTranslatorOptions {
  modelResolver?: AnthropicOpenAIMapperOptions['resolveModel']
  getModelCapabilities?: AnthropicOpenAIMapperOptions['getModelCapabilities']
  policy?: TranslationPolicy
}

export class AnthropicTranslator {
  private readonly adapter: AnthropicMessagesAdapter

  constructor(options: AnthropicTranslatorOptions = {}) {
    this.adapter = new AnthropicMessagesAdapter({
      modelResolver: options.modelResolver ?? ((model: string) => model),
      getModelCapabilities:
        options.getModelCapabilities
        ?? ((model: string) => ({
          supportsThinkingBudget: model.startsWith('claude'),
        })),
      policy: options.policy ?? defaultTranslationPolicy,
    })
  }

  toOpenAI(
    payload: AnthropicMessagesPayload | AnthropicCountTokensPayload,
  ): ChatCompletionsPayload {
    return this.adapter.toCapiPlan(payload).payload
  }

  fromOpenAI(response: CapiChatCompletionResponse): AnthropicResponse {
    return this.adapter.fromCapiResponse(response)
  }

  createStreamTranslator() {
    return this.adapter.createStreamSerializer()
  }

  getLastIssues(): Array<TranslationIssue> {
    return this.adapter.getLastIssues()
  }
}
