import type {
  CapiChatCompletionResponse,
  CapiExecutionPlan,
  CapiRequestContext,
} from '~/core/capi'
import type {
  ConversationBlock,
  ConversationImageBlock,
  ConversationRequest,
  ConversationTextBlock,
  ConversationTurn,
} from '~/core/conversation'
import type { AnthropicOpenAIMapperOptions } from '~/translator/anthropic/anthropic-openai-mapper'
import type { NormalizedAnthropicRequest, NormalizedBlock, NormalizedTurn } from '~/translator/anthropic/ir'
import type { TranslationIssue } from '~/translator/anthropic/translation-issue'
import type { TranslationPolicy } from '~/translator/anthropic/translation-policy'
import type {
  AnthropicCountTokensPayload,
  AnthropicMessagesPayload,
  AnthropicResponse,
} from '~/translator/anthropic/types'

import { buildCapiExecutionPlan } from '~/core/capi'
import { normalizeAnthropicRequest } from '~/translator/anthropic/anthropic-normalizer'
import { AnthropicStreamTranslator } from '~/translator/anthropic/anthropic-stream-transducer'
import { mapOpenAIResponseToAnthropic } from '~/translator/anthropic/openai-anthropic-mapper'
import { normalizeOpenAIResponse } from '~/translator/anthropic/openai-normalizer'
import { defaultTranslationPolicy, TranslationContext } from '~/translator/anthropic/translation-policy'

export interface AnthropicMessagesAdapterOptions {
  modelResolver?: AnthropicOpenAIMapperOptions['resolveModel']
  getModelCapabilities?: AnthropicOpenAIMapperOptions['getModelCapabilities']
  policy?: TranslationPolicy
}

interface NormalizedAnthropicConversation {
  normalized: NormalizedAnthropicRequest
  conversation: ConversationRequest
  issues: Array<TranslationIssue>
}

function toConversationBlock(block: NormalizedBlock): ConversationBlock {
  switch (block.kind) {
    case 'text':
      return {
        kind: 'text',
        text: block.text,
      }
    case 'image':
      return {
        kind: 'image',
        url: `data:${block.mediaType};base64,${block.data}`,
      }
    case 'thinking':
      return {
        kind: 'thinking',
        text: block.thinking,
        signature: block.signature,
      }
    case 'tool_use':
      return {
        kind: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
        argumentsText: JSON.stringify(block.input),
      }
    case 'tool_result':
      return {
        kind: 'tool_result',
        toolUseId: block.toolUseId,
        content: block.content.map(contentBlock => toConversationBlock(contentBlock)) as Array<ConversationTextBlock | ConversationImageBlock>,
        isError: block.isError,
      }
  }
}

function toConversationTurn(turn: NormalizedTurn): ConversationTurn {
  return {
    role: turn.role,
    blocks: turn.blocks.map(toConversationBlock),
  }
}

function recordAnthropicRequestIssues(
  request: NormalizedAnthropicRequest,
  context: TranslationContext,
) {
  if (request.topK !== undefined) {
    context.record(
      {
        kind: 'unsupported_top_k',
        severity: 'warning',
        message: 'Anthropic top_k is not supported by the upstream Copilot CAPI payload and was dropped.',
      },
      { fatalInStrict: true },
    )
  }

  if (request.serviceTier !== undefined) {
    context.record(
      {
        kind: 'unsupported_service_tier',
        severity: 'warning',
        message: 'Anthropic service_tier is not supported by the upstream Copilot CAPI payload and was dropped.',
      },
      { fatalInStrict: true },
    )
  }

  for (const turn of request.turns) {
    if (turn.role === 'user') {
      for (const block of turn.blocks) {
        if (block.kind === 'tool_result' && block.isError) {
          context.record({
            kind: 'lossy_tool_result_error_flag_dropped',
            severity: 'warning',
            message: 'tool_result.is_error is not representable in upstream tool messages and was dropped.',
          })
        }
      }
      continue
    }

    if (turn.role !== 'assistant') {
      continue
    }

    let sawToolUse = false
    let sawTextOrThinkingAfterTool = false
    let sawThinking = false

    for (const block of turn.blocks) {
      if (block.kind === 'thinking') {
        sawThinking = true
        if (sawToolUse) {
          sawTextOrThinkingAfterTool = true
        }
      }
      else if (block.kind === 'text') {
        if (sawToolUse) {
          sawTextOrThinkingAfterTool = true
        }
      }
      else if (block.kind === 'tool_use') {
        sawToolUse = true
      }
    }

    if (sawThinking) {
      context.record({
        kind: 'lossy_thinking_omitted_from_prompt',
        severity: 'warning',
        message: 'Anthropic thinking blocks were preserved internally but omitted from the upstream prompt.',
      })
    }

    if (sawTextOrThinkingAfterTool) {
      context.record({
        kind: 'lossy_interleaving_flattened',
        severity: 'warning',
        message: 'Assistant text/tool_use interleaving was flattened to upstream content + tool_calls.',
      })
    }
  }
}

function applyThinkingBudgetOverride(
  plan: CapiExecutionPlan,
  request: NormalizedAnthropicRequest,
  options: Required<Pick<AnthropicMessagesAdapterOptions, 'getModelCapabilities'>>,
) {
  if (!request.thinking || request.thinking.type === 'disabled') {
    return
  }

  const supportsThinkingBudget = options.getModelCapabilities(plan.resolvedModel).supportsThinkingBudget
  if (supportsThinkingBudget && plan.payload.thinking_budget == null) {
    const budgetTokens = request.thinking.type === 'adaptive'
      ? 24000
      : request.thinking.budgetTokens
    plan.payload.thinking_budget = budgetTokens
    plan.tokenCountPayload.thinking_budget = budgetTokens
  }

  if (!supportsThinkingBudget) {
    delete plan.payload.thinking_budget
    delete plan.tokenCountPayload.thinking_budget
  }
}

function normalizeAnthropicConversation(
  payload: AnthropicMessagesPayload | AnthropicCountTokensPayload,
  policy: TranslationPolicy,
): NormalizedAnthropicConversation {
  const context = new TranslationContext(policy)
  const normalized = normalizeAnthropicRequest(payload)
  recordAnthropicRequestIssues(normalized, context)

  return {
    normalized,
    conversation: {
      model: normalized.model,
      turns: normalized.turns.map(toConversationTurn),
      maxTokens: normalized.maxTokens,
      stopSequences: normalized.stopSequences,
      stream: normalized.stream,
      temperature: normalized.temperature,
      topP: normalized.topP,
      userId: normalized.userId,
      tools: normalized.tools?.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      toolChoice: normalized.toolChoice,
      thinking: normalized.thinking,
    },
    issues: context.getIssues(),
  }
}

export class AnthropicMessagesAdapter {
  private readonly options: Required<AnthropicMessagesAdapterOptions>
  private lastIssues: Array<TranslationIssue> = []

  constructor(options: AnthropicMessagesAdapterOptions = {}) {
    this.options = {
      modelResolver: options.modelResolver ?? (model => model),
      getModelCapabilities:
        options.getModelCapabilities
        ?? ((model: string) => ({
          supportsThinkingBudget: model.startsWith('claude'),
        })),
      policy: options.policy ?? defaultTranslationPolicy,
    }
  }

  toConversation(
    payload: AnthropicMessagesPayload | AnthropicCountTokensPayload,
  ): ConversationRequest {
    const { conversation, issues } = normalizeAnthropicConversation(payload, this.options.policy)
    this.lastIssues = issues
    return conversation
  }

  toCapiPlan(
    payload: AnthropicMessagesPayload | AnthropicCountTokensPayload,
    options?: { requestContext?: Partial<CapiRequestContext> },
  ): CapiExecutionPlan {
    const { conversation, normalized, issues } = normalizeAnthropicConversation(
      payload,
      this.options.policy,
    )
    this.lastIssues = issues
    const plan = buildCapiExecutionPlan(conversation, {
      resolveModel: this.options.modelResolver,
      requestContext: options?.requestContext,
    })

    applyThinkingBudgetOverride(plan, normalized, this.options)
    return plan
  }

  toTokenCountPayload(
    payload: AnthropicMessagesPayload | AnthropicCountTokensPayload,
  ) {
    return this.toCapiPlan(payload).tokenCountPayload
  }

  fromCapiResponse(response: CapiChatCompletionResponse): AnthropicResponse {
    const context = new TranslationContext(this.options.policy)
    const normalized = normalizeOpenAIResponse(response, context)
    const result = mapOpenAIResponseToAnthropic(normalized)
    this.lastIssues = context.getIssues()
    return result
  }

  createStreamSerializer() {
    return new AnthropicStreamTranslator()
  }

  getLastIssues(): Array<TranslationIssue> {
    return [...this.lastIssues]
  }
}
