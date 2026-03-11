import type {
  AnthropicAssistantContentBlock,
  AnthropicAssistantMessage,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUserContentBlock,
  AnthropicUserMessage,
} from '~/translator'
import type {
  ResponseFunctionCallOutputItem,
  ResponseFunctionToolCallItem,
  ResponseInputCompaction,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseInputReasoning,
  ResponseInputText,
  ResponsesPayload,
  ResponseTool,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from '~/types'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'

import { SignatureCodec } from './signature-codec'

const MESSAGE_TYPE = 'message'

export const THINKING_TEXT = 'Thinking...'

export interface AnthropicToResponsesOptions {
  reasoningEffortResolver?: (model: string) => string
}

export function translateAnthropicToResponsesPayload(
  payload: AnthropicMessagesPayload,
  options?: AnthropicToResponsesOptions,
): ResponsesPayload {
  assertResponsesCompatibleRequest(payload)

  const input: Array<ResponseInputItem> = []

  for (const message of payload.messages) {
    input.push(...translateMessage(message))
  }

  const { safetyIdentifier, promptCacheKey } = parseUserId(payload.metadata?.user_id)
  const reasoning = resolveResponsesReasoningConfig(payload, options)

  return {
    model: payload.model,
    input,
    instructions: translateSystemPrompt(payload.system),
    temperature: payload.temperature ?? null,
    top_p: payload.top_p ?? null,
    max_output_tokens: payload.max_tokens,
    tools: convertAnthropicTools(payload.tools),
    tool_choice: convertAnthropicToolChoice(payload.tool_choice),
    metadata: payload.metadata ? { ...payload.metadata } : null,
    safety_identifier: safetyIdentifier,
    prompt_cache_key: promptCacheKey,
    stream: payload.stream ?? null,
    store: false,
    parallel_tool_calls: true,
    ...(reasoning
      ? {
          reasoning,
          include: ['reasoning.encrypted_content'],
        }
      : {}),
  }
}

export function encodeCompactionCarrierSignature(compaction: { id: string, encrypted_content: string }): string {
  return SignatureCodec.encodeCompaction(compaction)
}

export function decodeCompactionCarrierSignature(
  signature: string,
): { id: string, encrypted_content: string } | undefined {
  return SignatureCodec.decodeCompaction(signature)
}

function translateMessage(message: AnthropicMessage): Array<ResponseInputItem> {
  if (message.role === 'user') {
    return translateUserMessage(message)
  }
  return translateAssistantMessage(message)
}

function translateUserMessage(
  message: AnthropicUserMessage,
): Array<ResponseInputItem> {
  if (typeof message.content === 'string') {
    return [createMessage('user', message.content)]
  }
  if (!Array.isArray(message.content)) {
    return []
  }

  const items: Array<ResponseInputItem> = []
  const pendingContent: Array<ResponseInputContent> = []

  for (const block of message.content) {
    if (block.type === 'tool_result') {
      flushPendingContent(pendingContent, items, { role: 'user' })
      items.push(createFunctionCallOutput(block))
      continue
    }

    const converted = translateUserContentBlock(block)
    if (converted) {
      pendingContent.push(converted)
    }
  }

  flushPendingContent(pendingContent, items, { role: 'user' })
  return items
}

function translateAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<ResponseInputItem> {
  const assistantPhase = resolveAssistantPhase(message.content)
  if (typeof message.content === 'string') {
    return [createMessage('assistant', message.content, assistantPhase)]
  }
  if (!Array.isArray(message.content)) {
    return []
  }

  const items: Array<ResponseInputItem> = []
  const pendingContent: Array<ResponseInputContent> = []

  for (const block of message.content) {
    if (block.type === 'tool_use') {
      flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
      items.push(createFunctionToolCall(block))
      continue
    }

    if (block.type === 'thinking' && block.signature) {
      const compaction = createCompactionContent(block)
      if (compaction) {
        flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
        items.push(compaction)
        continue
      }

      if (SignatureCodec.isReasoningSignature(block.signature)) {
        flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
        items.push(createReasoningContent(block))
        continue
      }
    }

    const converted = translateAssistantContentBlock(block)
    if (converted) {
      pendingContent.push(converted)
    }
  }

  flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
  return items
}

function translateUserContentBlock(
  block: AnthropicUserContentBlock,
): ResponseInputContent | undefined {
  switch (block.type) {
    case 'text':
      return createTextContent(block.text)
    case 'image':
      return createImageContent(block)
    default:
      return undefined
  }
}

function translateAssistantContentBlock(
  block: AnthropicAssistantContentBlock,
): ResponseInputContent | undefined {
  switch (block.type) {
    case 'text':
      return createOutputTextContent(block.text)
    default:
      return undefined
  }
}

function flushPendingContent(
  pendingContent: Array<ResponseInputContent>,
  target: Array<ResponseInputItem>,
  message: Pick<ResponseInputMessage, 'role' | 'phase'>,
) {
  if (pendingContent.length === 0) {
    return
  }

  target.push(createMessage(message.role, [...pendingContent], message.phase))
  pendingContent.length = 0
}

function createMessage(
  role: ResponseInputMessage['role'],
  content: string | Array<ResponseInputContent>,
  phase?: ResponseInputMessage['phase'],
): ResponseInputMessage {
  return {
    type: MESSAGE_TYPE,
    role,
    content,
    ...(role === 'assistant' && phase ? { phase } : {}),
  }
}

function resolveAssistantPhase(
  content: AnthropicAssistantMessage['content'],
): ResponseInputMessage['phase'] | undefined {
  if (typeof content === 'string') {
    return 'final_answer'
  }
  if (!Array.isArray(content)) {
    return undefined
  }

  const hasText = content.some(block => block.type === 'text')
  if (!hasText) {
    return undefined
  }
  return content.some(block => block.type === 'tool_use')
    ? 'commentary'
    : 'final_answer'
}

function createTextContent(text: string): ResponseInputText {
  return { type: 'input_text', text }
}

function createOutputTextContent(text: string): ResponseInputText {
  return { type: 'output_text', text }
}

function createImageContent(block: AnthropicImageBlock): ResponseInputImage {
  return {
    type: 'input_image',
    image_url: `data:${block.source.media_type};base64,${block.source.data}`,
    detail: 'auto',
  }
}

function createReasoningContent(
  block: AnthropicThinkingBlock,
): ResponseInputReasoning {
  const { encryptedContent, id } = SignatureCodec.decodeReasoning(block.signature ?? '')
  const thinking = block.thinking === THINKING_TEXT ? '' : block.thinking
  return {
    id,
    type: 'reasoning',
    summary: thinking ? [{ type: 'summary_text', text: thinking }] : [],
    encrypted_content: encryptedContent,
  }
}

function createCompactionContent(
  block: AnthropicThinkingBlock,
): ResponseInputCompaction | undefined {
  const compaction = decodeCompactionCarrierSignature(block.signature ?? '')
  if (!compaction) {
    return undefined
  }
  return {
    id: compaction.id,
    type: 'compaction',
    encrypted_content: compaction.encrypted_content,
  }
}

function createFunctionToolCall(
  block: AnthropicToolUseBlock,
): ResponseFunctionToolCallItem {
  return {
    type: 'function_call',
    call_id: block.id,
    name: block.name,
    arguments: JSON.stringify(block.input),
    status: 'completed',
  }
}

function createFunctionCallOutput(
  block: AnthropicToolResultBlock,
): ResponseFunctionCallOutputItem {
  return {
    type: 'function_call_output',
    call_id: block.tool_use_id,
    output: convertToolResultContent(block.content),
    status: block.is_error ? 'incomplete' : 'completed',
  }
}

function translateSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): string | null {
  if (!system) {
    return null
  }
  if (typeof system === 'string') {
    return system
  }
  const text = system.map(block => block.text).join(' ')
  return text.length > 0 ? text : null
}

function convertAnthropicTools(
  tools: Array<AnthropicTool> | undefined,
): Array<ResponseTool> | null {
  if (!tools || tools.length === 0) {
    return null
  }
  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    parameters: tool.input_schema,
    strict: false,
    ...(tool.description ? { description: tool.description } : {}),
  }))
}

function convertAnthropicToolChoice(
  choice: AnthropicMessagesPayload['tool_choice'],
): ToolChoiceOptions | ToolChoiceFunction {
  if (!choice) {
    return 'auto'
  }
  switch (choice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'tool':
      return choice.name ? { type: 'function', name: choice.name } : 'auto'
    case 'none':
      return 'none'
  }
}

function resolveResponsesReasoningConfig(
  payload: AnthropicMessagesPayload,
  options?: AnthropicToResponsesOptions,
): ResponsesPayload['reasoning'] | undefined {
  const effort = resolveResponsesReasoningEffort(payload, options)
  if (!effort) {
    return undefined
  }

  return {
    effort,
    summary: effort === 'none' ? null : 'detailed',
  }
}

function resolveResponsesReasoningEffort(
  payload: AnthropicMessagesPayload,
  options?: AnthropicToResponsesOptions,
): NonNullable<ResponsesPayload['reasoning']>['effort'] | undefined {
  if (payload.thinking?.type === 'disabled') {
    return 'none'
  }

  if (payload.output_config?.effort) {
    return mapAnthropicEffortToResponses(payload.output_config.effort)
  }

  if (payload.thinking?.type === 'adaptive') {
    return 'medium'
  }

  if (payload.thinking?.type === 'enabled') {
    return (options?.reasoningEffortResolver?.(payload.model) ?? 'medium') as NonNullable<ResponsesPayload['reasoning']>['effort']
  }

  return undefined
}

function mapAnthropicEffortToResponses(
  effort: NonNullable<AnthropicMessagesPayload['output_config']>['effort'],
): NonNullable<ResponsesPayload['reasoning']>['effort'] {
  if (effort === 'max') {
    return 'xhigh'
  }
  return effort
}

function assertResponsesCompatibleRequest(
  payload: AnthropicMessagesPayload,
) {
  if (payload.stop_sequences?.length) {
    throw new TranslationFailure(
      'Anthropic stop_sequences cannot be forwarded through the Responses execution path.',
      {
        status: 400,
        kind: 'unsupported_stop_sequences',
      },
    )
  }

  if (payload.top_k !== undefined) {
    throw new TranslationFailure(
      'Anthropic top_k is not supported on the Responses execution path.',
      {
        status: 400,
        kind: 'unsupported_top_k',
      },
    )
  }

  if (payload.service_tier !== undefined) {
    throw new TranslationFailure(
      'Anthropic service_tier is not supported on the Responses execution path.',
      {
        status: 400,
        kind: 'unsupported_service_tier',
      },
    )
  }
}

function parseUserId(
  userId: string | undefined,
): { safetyIdentifier: string | null, promptCacheKey: string | null } {
  if (!userId) {
    return { safetyIdentifier: null, promptCacheKey: null }
  }

  const userMatch = userId.match(/user_([^_]+)_account/)
  const sessionMatch = userId.match(/_session_(.+)$/)

  return {
    safetyIdentifier: userMatch ? userMatch[1] : null,
    promptCacheKey: sessionMatch ? sessionMatch[1] : null,
  }
}

function convertToolResultContent(
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>,
): string | Array<ResponseInputContent> {
  if (typeof content === 'string') {
    return content
  }

  const result: Array<ResponseInputContent> = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        result.push(createTextContent(block.text))
        break
      case 'image':
        result.push(createImageContent(block))
        break
      default:
        break
    }
  }

  return result
}
