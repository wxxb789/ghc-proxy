import type {
  CapiChatCompletionsPayload,
  CapiExecutionPlan,
  CapiMessage,
  CapiRequestContext,
  CapiTool,
  CopilotCacheControl,
} from './types'
import type {
  ConversationImageBlock,
  ConversationRequest,
  ConversationTextBlock,
  ConversationToolResultBlock,
  ConversationTurn,
} from '~/core/conversation'
import type {
  ContentPart,
  Message,
} from '~/types'

import { selectCapiProfile } from './profile'
import { buildCapiRequestContext, inferInitiator } from './request-context'

const EPHEMERAL_CACHE_CONTROL: CopilotCacheControl = {
  type: 'ephemeral',
}

function assertNever(value: never): never {
  throw new Error(`Unexpected conversation turn role: ${JSON.stringify(value)}`)
}

function asContentPart(
  block: ConversationTextBlock | ConversationImageBlock,
): ContentPart {
  if (block.kind === 'text') {
    return {
      type: 'text',
      text: block.text,
    }
  }

  return {
    type: 'image_url',
    image_url: {
      url: block.url,
      ...(block.detail ? { detail: block.detail } : {}),
    },
  }
}

function serializeContentBlocks(
  blocks: Array<ConversationTextBlock | ConversationImageBlock>,
): Message['content'] {
  if (blocks.length === 0) {
    return null
  }

  if (blocks.every(block => block.kind === 'text')) {
    if (blocks.length === 1) {
      return blocks[0].text
    }

    return blocks.map(block => ({
      type: 'text',
      text: block.text,
    }))
  }

  return blocks.map(asContentPart)
}

function serializeToolResultBlock(
  block: ConversationToolResultBlock,
): CapiMessage {
  return {
    role: 'tool',
    tool_call_id: block.toolUseId,
    content: serializeContentBlocks(block.content),
  }
}

function serializeUserTurn(turn: ConversationTurn): Array<CapiMessage> {
  const messages: Array<CapiMessage> = []
  const pendingBlocks: Array<ConversationTextBlock | ConversationImageBlock> = []

  const flushPendingBlocks = () => {
    if (pendingBlocks.length === 0) {
      return
    }

    messages.push({
      role: 'user',
      content: serializeContentBlocks(pendingBlocks),
    })
    pendingBlocks.length = 0
  }

  for (const block of turn.blocks) {
    if (block.kind === 'text' || block.kind === 'image') {
      pendingBlocks.push(block)
      continue
    }

    if (block.kind === 'tool_result') {
      flushPendingBlocks()
      messages.push(serializeToolResultBlock(block))
    }
  }

  flushPendingBlocks()
  return messages
}

function serializeAssistantTurn(turn: ConversationTurn): Array<CapiMessage> {
  const textBlocks: Array<ConversationTextBlock | ConversationImageBlock> = []
  const toolCalls: NonNullable<CapiMessage['tool_calls']> = []

  for (const block of turn.blocks) {
    if (block.kind === 'text' || block.kind === 'image') {
      textBlocks.push(block)
      continue
    }

    if (block.kind === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: block.argumentsText,
        },
      })
    }
  }

  return [{
    role: 'assistant',
    content: serializeContentBlocks(textBlocks),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(turn.meta?.reasoningOpaque ? { reasoning_opaque: turn.meta.reasoningOpaque } : {}),
    ...(turn.meta?.encryptedContent !== undefined ? { encrypted_content: turn.meta.encryptedContent } : {}),
    ...(turn.meta?.phase ? { phase: turn.meta.phase } : {}),
    ...(turn.meta?.copilotAnnotations !== undefined ? { copilot_annotations: turn.meta.copilotAnnotations } : {}),
  }]
}

function serializeSystemLikeTurn(turn: ConversationTurn): Array<CapiMessage> {
  const contentBlocks = turn.blocks.filter(
    (block): block is ConversationTextBlock | ConversationImageBlock =>
      block.kind === 'text' || block.kind === 'image',
  )

  return [{
    role: turn.role,
    content: serializeContentBlocks(contentBlocks),
  }]
}

function serializeToolTurn(turn: ConversationTurn): Array<CapiMessage> {
  const contentBlocks = turn.blocks.filter(
    (block): block is ConversationTextBlock | ConversationImageBlock =>
      block.kind === 'text' || block.kind === 'image',
  )

  return [{
    role: 'tool',
    tool_call_id: turn.meta?.toolCallId,
    content: serializeContentBlocks(contentBlocks),
  }]
}

function serializeTurns(turns: Array<ConversationTurn>): Array<CapiMessage> {
  return turns.flatMap((turn) => {
    switch (turn.role) {
      case 'system':
      case 'developer':
        return serializeSystemLikeTurn(turn)
      case 'user':
        return serializeUserTurn(turn)
      case 'assistant':
        return serializeAssistantTurn(turn)
      case 'tool':
        return serializeToolTurn(turn)
      default:
        return assertNever(turn.role)
    }
  })
}

function serializeTools(
  tools: ConversationRequest['tools'],
): Array<CapiTool> | undefined {
  return tools?.map((tool): CapiTool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

function serializeToolChoice(
  toolChoice: ConversationRequest['toolChoice'],
): CapiChatCompletionsPayload['tool_choice'] {
  if (!toolChoice) {
    return undefined
  }

  switch (toolChoice.type) {
    case 'none':
      return 'none'
    case 'auto':
      return 'auto'
    case 'required':
      return 'required'
    case 'tool':
      return {
        type: 'function',
        function: { name: toolChoice.name },
      }
  }
}

function applyCacheCheckpoints(
  payload: CapiChatCompletionsPayload,
) {
  const firstSystemLikeIndex = payload.messages.findIndex(
    message => message.role === 'system' || message.role === 'developer',
  )
  if (firstSystemLikeIndex >= 0) {
    payload.messages[firstSystemLikeIndex] = {
      ...payload.messages[firstSystemLikeIndex],
      copilot_cache_control: EPHEMERAL_CACHE_CONTROL,
    }
  }

  if (payload.tools && payload.tools.length > 0) {
    const lastToolIndex = payload.tools.length - 1
    payload.tools[lastToolIndex] = {
      ...payload.tools[lastToolIndex],
      copilot_cache_control: EPHEMERAL_CACHE_CONTROL,
    }
  }

  const lastCacheEligibleMessageIndex = payload.messages.findLastIndex(
    message => message.role !== 'user',
  )
  if (lastCacheEligibleMessageIndex >= 0) {
    payload.messages[lastCacheEligibleMessageIndex] = {
      ...payload.messages[lastCacheEligibleMessageIndex],
      copilot_cache_control: EPHEMERAL_CACHE_CONTROL,
    }
  }
}

function stripTransportFields(
  payload: CapiChatCompletionsPayload,
): CapiExecutionPlan['tokenCountPayload'] {
  const { stream_options: _streamOptions, ...rest } = payload
  return {
    ...rest,
    messages: payload.messages.map(({ copilot_cache_control: _cache, ...message }) => message),
    tools: payload.tools?.map(({ copilot_cache_control: _cache, ...tool }) => tool) ?? payload.tools,
  }
}

export interface BuildCapiExecutionPlanOptions {
  resolveModel?: (model: string) => string
  requestContext?: Partial<CapiRequestContext>
}

export function buildCapiExecutionPlan(
  request: ConversationRequest,
  options: BuildCapiExecutionPlanOptions = {},
): CapiExecutionPlan {
  const resolvedModel = options.resolveModel?.(request.model) ?? request.model
  const profile = selectCapiProfile(resolvedModel)
  const initiator = inferInitiator(request.turns)

  const payload: CapiChatCompletionsPayload = {
    model: resolvedModel,
    messages: serializeTurns(request.turns),
    max_tokens: request.maxTokens,
    stop: request.stopSequences,
    stream: request.stream,
    temperature: request.temperature,
    top_p: request.topP,
    user: request.userId,
    tools: serializeTools(request.tools),
    tool_choice: serializeToolChoice(request.toolChoice),
    ...profile.applyThinking(request),
    ...(request.stream && profile.includeUsageOnStream
      ? { stream_options: { include_usage: true } }
      : {}),
  }

  if (profile.enableCacheControl) {
    applyCacheCheckpoints(payload)
  }

  return {
    payload,
    tokenCountPayload: stripTransportFields(payload),
    requestContext: buildCapiRequestContext(
      initiator,
      options.requestContext,
    ),
    initiator,
    profileId: profile.id,
    resolvedModel,
  }
}
