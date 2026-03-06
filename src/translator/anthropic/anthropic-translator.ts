import type { AnthropicOpenAIMapperOptions } from './anthropic-openai-mapper'

import type { TranslationIssue } from './translation-issue'
import type { TranslationPolicy } from './translation-policy'

import type {
  AnthropicCountTokensPayload,
  AnthropicMessagesPayload,
  AnthropicResponse,
} from './types'
import type { ChatCompletionResponse, ChatCompletionsPayload } from '~/types'
import { normalizeAnthropicRequest } from './anthropic-normalizer'
import {

  mapAnthropicRequestToOpenAI,
} from './anthropic-openai-mapper'
import {
  AnthropicStreamTranslator,
} from './anthropic-stream-transducer'
import { mapOpenAIResponseToAnthropic } from './openai-anthropic-mapper'
import { normalizeOpenAIResponse } from './openai-normalizer'
import {
  defaultTranslationPolicy,
  TranslationContext,

} from './translation-policy'

export interface AnthropicTranslatorOptions {
  modelResolver?: AnthropicOpenAIMapperOptions['resolveModel']
  getModelCapabilities?: AnthropicOpenAIMapperOptions['getModelCapabilities']
  policy?: TranslationPolicy
}

export class AnthropicTranslator {
  private readonly mapperOptions: AnthropicOpenAIMapperOptions
  private readonly policy: TranslationPolicy
  private lastIssues: Array<TranslationIssue> = []

  constructor(options: AnthropicTranslatorOptions = {}) {
    this.mapperOptions = {
      resolveModel: options.modelResolver ?? (model => model),
      getModelCapabilities:
        options.getModelCapabilities
        ?? (model => ({
          supportsThinkingBudget: model.startsWith('claude'),
        })),
    }
    this.policy = options.policy ?? defaultTranslationPolicy
  }

  toOpenAI(
    payload: AnthropicMessagesPayload | AnthropicCountTokensPayload,
  ): ChatCompletionsPayload {
    const context = new TranslationContext(this.policy)
    const normalized = normalizeAnthropicRequest(payload)
    const result = mapAnthropicRequestToOpenAI(
      normalized,
      context,
      this.mapperOptions,
    )
    this.lastIssues = context.getIssues()
    return result
  }

  fromOpenAI(response: ChatCompletionResponse): AnthropicResponse {
    const context = new TranslationContext(this.policy)
    const normalized = normalizeOpenAIResponse(response, context)
    const result = mapOpenAIResponseToAnthropic(normalized)
    this.lastIssues = context.getIssues()
    return result
  }

  createStreamTranslator() {
    return new AnthropicStreamTranslator()
  }

  getLastIssues(): Array<TranslationIssue> {
    return [...this.lastIssues]
  }
}
