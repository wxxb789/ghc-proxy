import type {
  NormalizedBlock,
  NormalizedOpenAIResponse,
  NormalizedTurn,
} from './ir'

import type { TranslationContext } from './translation-policy'
import type { ChatCompletionResponse, ContentPart, Message, ToolCall } from '~/types'
import { TranslationFailure } from './translation-issue'

function normalizeContentPart(part: ContentPart): NormalizedBlock {
  switch (part.type) {
    case 'text':
      return { kind: 'text', text: part.text }
    case 'image_url': {
      const match = part.image_url.url.match(/^data:(.+);base64,(.+)$/)
      if (!match) {
        throw new TranslationFailure('OpenAI image_url must be a data URL', {
          status: 502,
          kind: 'invalid_upstream_image_url',
        })
      }

      const [, mediaType, data] = match
      if (
        mediaType !== 'image/jpeg'
        && mediaType !== 'image/png'
        && mediaType !== 'image/gif'
        && mediaType !== 'image/webp'
      ) {
        throw new TranslationFailure(`Unsupported image media type: ${mediaType}`, {
          status: 502,
          kind: 'invalid_upstream_image_url',
        })
      }

      return {
        kind: 'image',
        mediaType,
        data,
      }
    }
  }
}

function normalizeMessageContent(content: Message['content']): Array<NormalizedBlock> {
  if (content === null) {
    return []
  }

  if (typeof content === 'string') {
    return content.length > 0 ? [{ kind: 'text', text: content }] : []
  }

  return content.map(normalizeContentPart)
}

function parseToolCall(toolCall: ToolCall): NormalizedBlock {
  try {
    return {
      kind: 'tool_use',
      id: toolCall.id,
      name: toolCall.function.name,
      input: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
    }
  }
  catch {
    throw new TranslationFailure(
      `Invalid upstream tool arguments for tool "${toolCall.function.name}"`,
      {
        status: 502,
        kind: 'invalid_upstream_tool_arguments',
      },
    )
  }
}

function normalizeAssistantTurn(
  message: ChatCompletionResponse['choices'][number]['message'],
): NormalizedTurn {
  const contentBlocks = normalizeMessageContent(message.content)
  const toolBlocks = message.tool_calls?.map(parseToolCall) ?? []
  return {
    role: 'assistant',
    blocks: [...contentBlocks, ...toolBlocks],
  }
}

export function normalizeOpenAIResponse(
  response: ChatCompletionResponse,
  context: TranslationContext,
): NormalizedOpenAIResponse {
  if (response.choices.length === 0) {
    throw new TranslationFailure('Upstream response contained no choices', {
      status: 502,
      kind: 'missing_upstream_choice',
    })
  }

  const firstChoice = [...response.choices].sort((left, right) => left.index - right.index)[0]
  if (response.choices.length > 1) {
    context.record(
      {
        kind: 'lossy_multiple_choices_ignored',
        severity: 'warning',
        message: 'Upstream response contained multiple choices; only choice index 0 was used.',
      },
      { fatalInStrict: true },
    )
  }

  return {
    id: response.id,
    model: response.model,
    turn: normalizeAssistantTurn(firstChoice.message),
    finishReason: firstChoice.finish_reason,
    usage: response.usage,
  }
}
