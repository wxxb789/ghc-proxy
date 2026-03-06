import type {
  CapiChatCompletionChunk,
  CapiChatCompletionResponse,
  CapiExecutionPlan,
  CapiRequestContext,
} from '~/core/capi'
import type {
  ConversationBlock,
  ConversationRequest,
  ConversationTurn,
} from '~/core/conversation'
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from '~/types'

import { buildCapiExecutionPlan } from '~/core/capi'

function toConversationBlocks(
  content: ChatCompletionsPayload['messages'][number]['content'],
): Array<ConversationBlock> {
  if (content === null) {
    return []
  }

  if (typeof content === 'string') {
    return content.length > 0
      ? [{ kind: 'text', text: content }]
      : []
  }

  return content.map((part) => {
    if (part.type === 'text') {
      return {
        kind: 'text',
        text: part.text,
      }
    }

    return {
      kind: 'image',
      url: part.image_url.url,
      detail: part.image_url.detail,
    }
  })
}

function normalizeToolArguments(
  argumentsText: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  }
  catch {
  }

  return {}
}

function toConversationTurns(payload: ChatCompletionsPayload): Array<ConversationTurn> {
  return payload.messages.map((message) => {
    const blocks = toConversationBlocks(message.content)

    if (message.role === 'assistant') {
      const toolBlocks = message.tool_calls?.map(toolCall => ({
        kind: 'tool_use' as const,
        id: toolCall.id,
        name: toolCall.function.name,
        input: normalizeToolArguments(toolCall.function.arguments),
        argumentsText: toolCall.function.arguments,
      }))

      return {
        role: 'assistant',
        blocks: [...blocks, ...(toolBlocks ?? [])],
      }
    }

    if (message.role === 'tool') {
      return {
        role: 'tool',
        blocks,
        meta: {
          toolCallId: message.tool_call_id,
        },
      }
    }

    return {
      role: message.role,
      blocks,
    }
  })
}

function sanitizeResponse(response: CapiChatCompletionResponse): ChatCompletionResponse {
  return {
    id: response.id,
    object: response.object,
    created: response.created,
    model: response.model,
    system_fingerprint: response.system_fingerprint,
    usage: response.usage,
    choices: response.choices.map(choice => ({
      index: choice.index,
      finish_reason: choice.finish_reason,
      logprobs: choice.logprobs,
      message: {
        role: choice.message.role,
        content: choice.message.content,
        ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
      },
    })),
  }
}

function sanitizeChunk(chunk: CapiChatCompletionChunk): ChatCompletionChunk {
  return {
    id: chunk.id,
    object: chunk.object,
    created: chunk.created,
    model: chunk.model,
    system_fingerprint: chunk.system_fingerprint,
    usage: chunk.usage,
    choices: chunk.choices.map(choice => ({
      index: choice.index,
      finish_reason: choice.finish_reason,
      logprobs: choice.logprobs,
      delta: {
        ...(choice.delta.role && choice.delta.role !== 'developer'
          ? { role: choice.delta.role }
          : {}),
        content: choice.delta.content,
        reasoning_text: choice.delta.reasoning_text,
        tool_calls: choice.delta.tool_calls,
      },
    })),
  }
}

export class OpenAIChatAdapter {
  toConversation(payload: ChatCompletionsPayload): ConversationRequest {
    return {
      model: payload.model,
      turns: toConversationTurns(payload),
      maxTokens: payload.max_tokens ?? undefined,
      stopSequences:
        payload.stop == null
          ? undefined
          : Array.isArray(payload.stop)
            ? payload.stop
            : [payload.stop],
      stream: payload.stream ?? undefined,
      temperature: payload.temperature,
      topP: payload.top_p,
      userId: payload.user ?? undefined,
      tools: payload.tools?.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        inputSchema: tool.function.parameters,
      })),
      toolChoice:
        payload.tool_choice == null
          ? undefined
          : typeof payload.tool_choice === 'string'
            ? payload.tool_choice === 'required'
              ? { type: 'required' }
              : payload.tool_choice === 'none'
                ? { type: 'none' }
                : { type: 'auto' }
            : { type: 'tool', name: payload.tool_choice.function.name },
      thinking:
        payload.thinking_budget != null
          ? { type: 'enabled', budgetTokens: payload.thinking_budget }
          : undefined,
    }
  }

  toCapiPlan(
    payload: ChatCompletionsPayload,
    options?: { requestContext?: Partial<CapiRequestContext> },
  ): CapiExecutionPlan {
    return buildCapiExecutionPlan(this.toConversation(payload), {
      requestContext: options?.requestContext,
    })
  }

  toTokenCountPayload(payload: ChatCompletionsPayload) {
    return this.toCapiPlan(payload).tokenCountPayload
  }

  fromCapiResponse(response: CapiChatCompletionResponse): ChatCompletionResponse {
    return sanitizeResponse(response)
  }

  serializeStreamChunk(chunk: CapiChatCompletionChunk): ChatCompletionChunk {
    return sanitizeChunk(chunk)
  }
}
