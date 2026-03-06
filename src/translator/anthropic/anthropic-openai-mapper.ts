import type {
  NormalizedAnthropicRequest,
  NormalizedImageBlock,
  NormalizedTextBlock,
  NormalizedToolResultBlock,
  NormalizedTurn,
} from './ir'

import type { TranslationContext } from './translation-policy'
import type { ChatCompletionsPayload, ContentPart, Message, Tool } from '~/types'

export interface ModelCapabilities {
  supportsThinkingBudget: boolean
}

export interface AnthropicOpenAIMapperOptions {
  resolveModel: (model: string) => string
  getModelCapabilities: (model: string) => ModelCapabilities
}

function assertNever(value: never): never {
  throw new Error(`Unexpected normalized value: ${JSON.stringify(value)}`)
}

function asContentPart(
  block: NormalizedTextBlock | NormalizedImageBlock,
): ContentPart {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image':
      return {
        type: 'image_url',
        image_url: {
          url: `data:${block.mediaType};base64,${block.data}`,
        },
      }
  }
}

function serializeContentBlocks(
  blocks: Array<NormalizedTextBlock | NormalizedImageBlock>,
): Message['content'] {
  if (blocks.length === 0) {
    return null
  }

  if (blocks.every(block => block.kind === 'text')) {
    if (blocks.length === 1) {
      return blocks[0].text
    }

    return blocks.map(block => ({ type: 'text', text: block.text }))
  }

  return blocks.map(asContentPart)
}

function mapToolResultBlock(
  block: NormalizedToolResultBlock,
  context: TranslationContext,
): Message {
  const contentBlocks = block.content
  if (block.isError) {
    context.record({
      kind: 'lossy_tool_result_error_flag_dropped',
      severity: 'warning',
      message: 'tool_result.is_error is not representable in OpenAI tool messages and was dropped.',
    })
  }

  return {
    role: 'tool',
    tool_call_id: block.toolUseId,
    content: serializeContentBlocks(contentBlocks),
  }
}

function mapUserTurn(
  turn: NormalizedTurn,
  context: TranslationContext,
): Array<Message> {
  const messages: Array<Message> = []
  const pendingUserBlocks: Array<NormalizedTextBlock | NormalizedImageBlock> = []

  const flushUserBlocks = () => {
    if (pendingUserBlocks.length === 0) {
      return
    }

    messages.push({
      role: 'user',
      content: serializeContentBlocks(pendingUserBlocks),
    })
    pendingUserBlocks.length = 0
  }

  for (const block of turn.blocks) {
    switch (block.kind) {
      case 'text':
      case 'image':
        pendingUserBlocks.push(block)
        break
      case 'tool_result':
        flushUserBlocks()
        messages.push(mapToolResultBlock(block, context))
        break
      case 'thinking':
      case 'tool_use':
        context.record(
          {
            kind: 'unsupported_user_block',
            severity: 'error',
            message: `Unsupported user block kind "${block.kind}".`,
          },
          { fatalInStrict: true },
        )
        break
    }
  }

  flushUserBlocks()
  return messages
}

function mapAssistantTurn(
  turn: NormalizedTurn,
  context: TranslationContext,
): Array<Message> {
  const textBlocks: Array<NormalizedTextBlock> = []
  const toolCalls: NonNullable<Message['tool_calls']> = []
  let sawToolUse = false
  let sawTextAfterToolUse = false

  for (const block of turn.blocks) {
    switch (block.kind) {
      case 'text':
        if (sawToolUse) {
          sawTextAfterToolUse = true
        }
        textBlocks.push(block)
        break
      case 'thinking':
        context.record({
          kind: 'lossy_thinking_omitted_from_prompt',
          severity: 'warning',
          message: 'Anthropic thinking blocks were preserved internally but omitted from the OpenAI prompt.',
        })
        if (sawToolUse) {
          sawTextAfterToolUse = true
        }
        break
      case 'tool_use':
        sawToolUse = true
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        })
        break
      case 'image':
      case 'tool_result':
        context.record(
          {
            kind: 'unsupported_assistant_block',
            severity: 'error',
            message: `Unsupported assistant block kind "${block.kind}".`,
          },
          { fatalInStrict: true },
        )
        break
    }
  }

  if (sawTextAfterToolUse) {
    context.record({
      kind: 'lossy_interleaving_flattened',
      severity: 'warning',
      message: 'Assistant text/tool_use interleaving was flattened to OpenAI content + tool_calls.',
    })
  }

  const content = serializeContentBlocks(textBlocks)
  return [
    {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ]
}

function mapSystemTurn(turn: NormalizedTurn): Array<Message> {
  const contentBlocks = turn.blocks.filter(
    (block): block is NormalizedTextBlock | NormalizedImageBlock =>
      block.kind === 'text' || block.kind === 'image',
  )

  return [{
    role: 'system',
    content: serializeContentBlocks(contentBlocks),
  }]
}

function mapThinkingConfig(
  request: NormalizedAnthropicRequest,
  capabilities: ModelCapabilities,
): Pick<ChatCompletionsPayload, 'reasoning_effort' | 'thinking_budget'> {
  const thinking = request.thinking
  if (!thinking || thinking.type === 'disabled') {
    return {}
  }

  const budgetTokens = thinking.type === 'adaptive' ? 24000 : thinking.budgetTokens
  const reasoningEffort = budgetTokens <= 8000
    ? 'low'
    : budgetTokens <= 24000
      ? 'medium'
      : 'high'

  return {
    reasoning_effort: reasoningEffort,
    ...(capabilities.supportsThinkingBudget ? { thinking_budget: budgetTokens } : {}),
  }
}

function mapTools(
  tools: NormalizedAnthropicRequest['tools'],
): Array<Tool> | undefined {
  return tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

function mapToolChoice(
  toolChoice: NormalizedAnthropicRequest['toolChoice'],
): ChatCompletionsPayload['tool_choice'] {
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

function mapTurns(
  turns: Array<NormalizedTurn>,
  context: TranslationContext,
): Array<Message> {
  return turns.flatMap((turn) => {
    switch (turn.role) {
      case 'system':
        return mapSystemTurn(turn)
      case 'user':
        return mapUserTurn(turn, context)
      case 'assistant':
        return mapAssistantTurn(turn, context)
      case 'tool':
        context.record(
          {
            kind: 'unsupported_openai_tool_turn',
            severity: 'error',
            message: 'Normalized tool turns are not supported when mapping Anthropic requests.',
          },
          { fatalInStrict: true },
        )
        return []
      default:
        return assertNever(turn.role)
    }
  })
}

export function mapAnthropicRequestToOpenAI(
  request: NormalizedAnthropicRequest,
  context: TranslationContext,
  options: AnthropicOpenAIMapperOptions,
): ChatCompletionsPayload {
  if (request.topK !== undefined) {
    context.record(
      {
        kind: 'unsupported_top_k',
        severity: 'warning',
        message: 'Anthropic top_k is not supported by the upstream OpenAI API and was dropped.',
      },
      { fatalInStrict: true },
    )
  }

  if (request.serviceTier !== undefined) {
    context.record(
      {
        kind: 'unsupported_service_tier',
        severity: 'warning',
        message: 'Anthropic service_tier is not supported by the upstream OpenAI API and was dropped.',
      },
      { fatalInStrict: true },
    )
  }

  const resolvedModel = options.resolveModel(request.model)
  const capabilities = options.getModelCapabilities(resolvedModel)

  return {
    model: resolvedModel,
    messages: mapTurns(request.turns, context),
    max_tokens: request.maxTokens,
    stop: request.stopSequences,
    stream: request.stream,
    temperature: request.temperature,
    top_p: request.topP,
    user: request.userId,
    tools: mapTools(request.tools),
    tool_choice: mapToolChoice(request.toolChoice),
    ...mapThinkingConfig(request, capabilities),
  }
}
