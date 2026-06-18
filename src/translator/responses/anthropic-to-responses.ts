import type {
  AnthropicAssistantMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicSystemMessage,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicUserMessage,
} from '~/translator'
import type {
  ResponseInputContent,
  ResponseInputItem,
  ResponsesPayload,
  ResponseTool,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from '~/types'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { normalizeFunctionParametersSchemaForCopilot } from './function-schema'

import {
  createCompactionContent,
  createFunctionCallOutput,
  createFunctionToolCall,
  createMessage,
  createReasoningContent,
  createRedactedReasoningContent,
  createServerFunctionCallOutput,
  createTextContent,
  flushPendingContent,
  isServerToolResultBlock,
  resolveAssistantPhase,
  translateAssistantContentBlock,
  translateUserContentBlock,
} from './response-items'
import { SignatureCodec } from './signature-codec'

const USER_ID_ACCOUNT_RE = /user_([^_]+)_account/
const USER_ID_SESSION_RE = /_session_(.+)$/

export { decodeCompactionCarrierSignature, THINKING_TEXT } from './response-items'

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
  const text = resolveResponsesTextConfig(payload)

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
    ...(text ? { text } : {}),
    ...(reasoning
      ? {
          reasoning,
          include: ['reasoning.encrypted_content'],
        }
      : {}),
  }
}

function translateMessage(message: AnthropicMessage): Array<ResponseInputItem> {
  switch (message.role) {
    case 'user':
      return translateUserMessage(message)
    case 'assistant':
      return translateAssistantMessage(message)
    case 'system':
      return translateSystemMessage(message)
  }
}

function translateSystemMessage(
  message: AnthropicSystemMessage,
): Array<ResponseInputItem> {
  if (typeof message.content === 'string') {
    return [createMessage('system', message.content)]
  }
  if (!Array.isArray(message.content)) {
    return []
  }

  return [createMessage('system', message.content.map(block => createTextContent(block.text)))]
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
    if (block.type === 'tool_result' || block.type === 'mcp_tool_result') {
      flushPendingContent(pendingContent, items, { role: 'user' })
      items.push(createFunctionCallOutput(block))
      continue
    }

    if (isServerToolResultBlock(block)) {
      flushPendingContent(pendingContent, items, { role: 'user' })
      items.push(createServerFunctionCallOutput(block))
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
    if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
      flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
      items.push(createFunctionToolCall(block))
      continue
    }

    if (block.type === 'redacted_thinking') {
      flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
      items.push(createRedactedReasoningContent(block))
      continue
    }

    if (block.type === 'mcp_tool_result') {
      flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
      items.push(createFunctionCallOutput(block))
      continue
    }

    if (isServerToolResultBlock(block)) {
      flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
      items.push(createServerFunctionCallOutput(block))
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
        const { id } = SignatureCodec.decodeReasoning(block.signature)
        if (id) {
          flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
          items.push(createReasoningContent(block))
          continue
        }
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
    parameters: normalizeFunctionParametersSchemaForCopilot(tool.input_schema),
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

function resolveResponsesTextConfig(
  payload: AnthropicMessagesPayload,
): ResponsesPayload['text'] | undefined {
  const format = payload.output_config?.format
  if (!format) {
    return undefined
  }

  switch (format.type) {
    case 'json_schema':
      return {
        format: {
          type: 'json_schema',
          name: format.name ?? 'anthropic_output',
          schema: format.schema,
          ...(format.description !== undefined ? { description: format.description } : {}),
          ...(format.strict !== undefined ? { strict: format.strict } : {}),
        },
      }
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

  const userMatch = userId.match(USER_ID_ACCOUNT_RE)
  const sessionMatch = userId.match(USER_ID_SESSION_RE)

  return {
    safetyIdentifier: userMatch ? userMatch[1] : null,
    promptCacheKey: sessionMatch ? sessionMatch[1] : null,
  }
}
