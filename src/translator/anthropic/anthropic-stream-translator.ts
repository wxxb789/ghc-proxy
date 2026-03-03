import type { AnthropicStreamEventData, AnthropicStreamState } from './types'

import type { ChatCompletionChunk } from '~/types'

import { mapOpenAIStopReasonToAnthropic, mapOpenAIUsageToAnthropic } from './shared'

export class AnthropicStreamTranslator {
  private state: AnthropicStreamState

  constructor() {
    this.state = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      thinkingBlockOpen: false,
      toolCalls: {},
    }
  }

  onChunk(chunk: ChatCompletionChunk): Array<AnthropicStreamEventData> {
    if (chunk.choices.length === 0) {
      return []
    }

    const events: Array<AnthropicStreamEventData> = []
    const choice = chunk.choices[0]
    const { delta } = choice

    this.appendMessageStart(events, chunk)
    this.appendThinkingDelta(events, delta.reasoning_text)
    this.appendContentDelta(events, delta.content)
    this.appendToolCalls(events, delta.tool_calls)
    this.appendFinish(events, chunk, choice.finish_reason)

    return events
  }

  onError(error?: unknown): Array<AnthropicStreamEventData> {
    const message = this.getErrorMessage(error)
    return [
      {
        type: 'error',
        error: {
          type: 'api_error',
          message,
        },
      },
    ]
  }

  private getErrorMessage(error: unknown): string {
    if (this.isTimeoutError(error)) {
      return 'Upstream streaming request timed out. Please retry.'
    }
    return 'An unexpected error occurred during streaming.'
  }

  private isTimeoutError(error: unknown): boolean {
    if (error instanceof DOMException) {
      return error.name === 'TimeoutError'
    }
    if (error instanceof Error) {
      return error.name === 'TimeoutError'
    }
    return false
  }

  private isToolBlockOpen(): boolean {
    if (!this.state.contentBlockOpen) {
      return false
    }
    return Object.values(this.state.toolCalls).some((tc) => {
      return (
        tc !== undefined
        && tc.anthropicBlockIndex === this.state.contentBlockIndex
      )
    })
  }

  private appendMessageStart(
    events: Array<AnthropicStreamEventData>,
    chunk: ChatCompletionChunk,
  ) {
    if (this.state.messageStartSent) {
      return
    }

    events.push({
      type: 'message_start',
      message: {
        id: chunk.id,
        type: 'message',
        role: 'assistant',
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          ...mapOpenAIUsageToAnthropic(chunk.usage),
          output_tokens: 0,
        },
      },
    })
    this.state.messageStartSent = true
  }

  private appendThinkingDelta(
    events: Array<AnthropicStreamEventData>,
    reasoningText: string | null | undefined,
  ) {
    if (!reasoningText) {
      return
    }

    // Defensively close a non-thinking content block if one is open
    if (this.state.contentBlockOpen && !this.state.thinkingBlockOpen) {
      events.push({
        type: 'content_block_stop',
        index: this.state.contentBlockIndex,
      })
      this.state.contentBlockIndex++
      this.state.contentBlockOpen = false
    }

    // Open a thinking block if not already open
    if (!this.state.thinkingBlockOpen) {
      events.push({
        type: 'content_block_start',
        index: this.state.contentBlockIndex,
        content_block: {
          type: 'thinking',
          thinking: '',
        },
      })
      this.state.contentBlockOpen = true
      this.state.thinkingBlockOpen = true
    }

    events.push({
      type: 'content_block_delta',
      index: this.state.contentBlockIndex,
      delta: {
        type: 'thinking_delta',
        thinking: reasoningText,
      },
    })
  }

  private appendContentDelta(
    events: Array<AnthropicStreamEventData>,
    content: string | null | undefined,
  ) {
    if (!content) {
      return
    }

    // Close thinking block when transitioning to text content
    if (this.state.thinkingBlockOpen) {
      events.push({
        type: 'content_block_stop',
        index: this.state.contentBlockIndex,
      })
      this.state.contentBlockIndex++
      this.state.contentBlockOpen = false
      this.state.thinkingBlockOpen = false
    }

    if (this.isToolBlockOpen()) {
      events.push({
        type: 'content_block_stop',
        index: this.state.contentBlockIndex,
      })
      this.state.contentBlockIndex++
      this.state.contentBlockOpen = false
    }

    if (!this.state.contentBlockOpen) {
      events.push({
        type: 'content_block_start',
        index: this.state.contentBlockIndex,
        content_block: {
          type: 'text',
          text: '',
        },
      })
      this.state.contentBlockOpen = true
    }

    events.push({
      type: 'content_block_delta',
      index: this.state.contentBlockIndex,
      delta: {
        type: 'text_delta',
        text: content,
      },
    })
  }

  private appendToolCalls(
    events: Array<AnthropicStreamEventData>,
    toolCalls:
      | Array<{
        index: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
      | undefined,
  ) {
    if (!toolCalls || toolCalls.length === 0) {
      return
    }

    for (const toolCall of toolCalls) {
      if (toolCall.id && toolCall.function?.name) {
        if (this.state.contentBlockOpen) {
          events.push({
            type: 'content_block_stop',
            index: this.state.contentBlockIndex,
          })
          this.state.contentBlockIndex++
          this.state.contentBlockOpen = false
          this.state.thinkingBlockOpen = false
        }

        const anthropicBlockIndex = this.state.contentBlockIndex
        this.state.toolCalls[toolCall.index] = {
          id: toolCall.id,
          name: toolCall.function.name,
          anthropicBlockIndex,
        }

        events.push({
          type: 'content_block_start',
          index: anthropicBlockIndex,
          content_block: {
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: {},
          },
        })
        this.state.contentBlockOpen = true
      }

      if (toolCall.function?.arguments) {
        const toolCallInfo = this.state.toolCalls[toolCall.index]
        if (!toolCallInfo) {
          continue
        }

        events.push({
          type: 'content_block_delta',
          index: toolCallInfo.anthropicBlockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: toolCall.function.arguments,
          },
        })
      }
    }
  }

  private appendFinish(
    events: Array<AnthropicStreamEventData>,
    chunk: ChatCompletionChunk,
    finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null,
  ) {
    if (!finishReason) {
      return
    }

    if (this.state.contentBlockOpen) {
      events.push({
        type: 'content_block_stop',
        index: this.state.contentBlockIndex,
      })
      this.state.contentBlockOpen = false
      this.state.thinkingBlockOpen = false
    }

    events.push(
      {
        type: 'message_delta',
        delta: {
          stop_reason: mapOpenAIStopReasonToAnthropic(finishReason),
          stop_sequence: null,
        },
        usage: mapOpenAIUsageToAnthropic(chunk.usage),
      },
      {
        type: 'message_stop',
      },
    )
  }
}
