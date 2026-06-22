import type {
  AnthropicContentBlockDeltaEvent,
  AnthropicContentBlockStartEvent,
  AnthropicContentBlockStopEvent,
  AnthropicStreamEventData,
  AnthropicStreamState,
} from './types'

import type { CapiChatCompletionChunk } from '~/core/capi'
import type { ConversationDelta } from '~/core/conversation'

import { mapOpenAIStopReasonToAnthropic, mapOpenAIUsageToAnthropic } from './shared'

class TextBlockWriter {
  private readonly state: AnthropicStreamState
  private readonly blockType: 'text' | 'thinking'

  constructor(
    state: AnthropicStreamState,
    blockType: 'text' | 'thinking',
  ) {
    this.state = state
    this.blockType = blockType
  }

  open(events: Array<AnthropicStreamEventData>): number {
    const existingIndex = this.blockType === 'text'
      ? this.state.openTextBlockIndex
      : this.state.openThinkingBlockIndex
    if (existingIndex !== null) {
      return existingIndex
    }

    const index = this.state.nextContentBlockIndex++
    const event: AnthropicContentBlockStartEvent = this.blockType === 'text'
      ? {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'text',
            text: '',
          },
        }
      : {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'thinking',
            thinking: '',
          },
        }
    events.push(event)

    if (this.blockType === 'text') {
      this.state.openTextBlockIndex = index
    }
    else {
      this.state.openThinkingBlockIndex = index
    }

    return index
  }

  append(events: Array<AnthropicStreamEventData>, text: string) {
    if (!text) {
      return
    }

    const index = this.open(events)
    const delta: AnthropicContentBlockDeltaEvent = this.blockType === 'text'
      ? {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'text_delta',
            text,
          },
        }
      : {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'thinking_delta',
            thinking: text,
          },
        }
    events.push(delta)
  }

  close(events: Array<AnthropicStreamEventData>) {
    const index = this.blockType === 'text'
      ? this.state.openTextBlockIndex
      : this.state.openThinkingBlockIndex
    if (index === null) {
      return
    }

    const event: AnthropicContentBlockStopEvent = {
      type: 'content_block_stop',
      index,
    }
    events.push(event)
    if (this.blockType === 'text') {
      this.state.openTextBlockIndex = null
    }
    else {
      this.state.openThinkingBlockIndex = null
    }
  }
}

class ToolUseBlockWriter {
  private readonly state: AnthropicStreamState

  constructor(state: AnthropicStreamState) {
    this.state = state
  }

  append(
    events: Array<AnthropicStreamEventData>,
    toolCall: NonNullable<CapiChatCompletionChunk['choices'][number]['delta']['tool_calls']>[number],
  ) {
    const lane = this.state.toolCalls[toolCall.index] ?? {
      started: false,
      closed: false,
    }

    if (lane.closed) {
      return
    }

    if (toolCall.id) {
      lane.id = toolCall.id
    }
    if (toolCall.function?.name) {
      lane.name = toolCall.function.name
    }

    if (!lane.started && lane.id && lane.name) {
      lane.anthropicBlockIndex = this.state.nextContentBlockIndex++
      lane.started = true
      events.push({
        type: 'content_block_start',
        index: lane.anthropicBlockIndex,
        content_block: {
          type: 'tool_use',
          id: lane.id,
          name: lane.name,
          input: {},
        },
      })
    }

    if (lane.started && toolCall.function?.arguments) {
      events.push({
        type: 'content_block_delta',
        index: lane.anthropicBlockIndex!,
        delta: {
          type: 'input_json_delta',
          partial_json: toolCall.function.arguments,
        },
      })
    }

    this.state.toolCalls[toolCall.index] = lane
  }

  closeAll(events: Array<AnthropicStreamEventData>) {
    const lanes = Object.values(this.state.toolCalls)
      .filter(lane => lane.started && !lane.closed && lane.anthropicBlockIndex !== undefined)
      .sort((left, right) => left.anthropicBlockIndex! - right.anthropicBlockIndex!)

    for (const lane of lanes) {
      events.push({
        type: 'content_block_stop',
        index: lane.anthropicBlockIndex!,
      })
      lane.closed = true
    }
  }
}

export class AnthropicStreamTranslator {
  private readonly state: AnthropicStreamState
  private readonly textWriter: TextBlockWriter
  private readonly thinkingWriter: TextBlockWriter
  private readonly toolWriter: ToolUseBlockWriter

  constructor() {
    this.state = {
      messageStartSent: false,
      nextContentBlockIndex: 0,
      openTextBlockIndex: null,
      openThinkingBlockIndex: null,
      toolCalls: {},
      messageStopSent: false,
    }
    this.textWriter = new TextBlockWriter(this.state, 'text')
    this.thinkingWriter = new TextBlockWriter(this.state, 'thinking')
    this.toolWriter = new ToolUseBlockWriter(this.state)
  }

  onChunk(chunk: CapiChatCompletionChunk): Array<AnthropicStreamEventData> {
    const deltas = this.toConversationDeltas(chunk)
    if (chunk.usage) {
      this.state.lastUsage = chunk.usage
    }
    if (deltas.length === 0) {
      return []
    }

    const events: Array<AnthropicStreamEventData> = []

    this.appendMessageStart(events, chunk)

    for (const delta of deltas) {
      switch (delta.kind) {
        case 'message_start':
          break
        case 'thinking_delta':
          this.textWriter.close(events)
          this.thinkingWriter.append(events, delta.text)
          break
        case 'text_delta':
          this.thinkingWriter.close(events)
          this.textWriter.append(events, delta.text)
          break
        case 'tool_use_delta':
          this.thinkingWriter.close(events)
          this.textWriter.close(events)
          this.toolWriter.append(events, {
            index: delta.toolIndex,
            ...(delta.id ? { id: delta.id } : {}),
            ...(delta.name || delta.argumentsText
              ? {
                  function: {
                    ...(delta.name ? { name: delta.name } : {}),
                    ...(delta.argumentsText ? { arguments: delta.argumentsText } : {}),
                  },
                }
              : {}),
          })
          break
        case 'message_stop':
          this.state.pendingStopReason = delta.stopReason
          // Close open blocks but defer message_delta/message_stop to onDone()
          // so that usage from a subsequent usage-only chunk can be captured
          this.closeAllBlocks(events)
          break
      }
    }

    return events
  }

  onDone(): Array<AnthropicStreamEventData> {
    if (!this.state.messageStartSent || this.state.messageStopSent) {
      return []
    }

    const events: Array<AnthropicStreamEventData> = []
    this.closeAllBlocks(events)

    events.push(
      {
        type: 'message_delta',
        delta: {
          stop_reason: mapOpenAIStopReasonToAnthropic(this.state.pendingStopReason ?? 'stop'),
          stop_sequence: null,
        },
        ...(this.state.lastUsage ? { usage: mapOpenAIUsageToAnthropic(this.state.lastUsage) } : {}),
      },
      {
        type: 'message_stop',
      },
    )

    this.state.messageStopSent = true
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

  private closeAllBlocks(events: Array<AnthropicStreamEventData>) {
    this.thinkingWriter.close(events)
    this.textWriter.close(events)
    this.toolWriter.closeAll(events)
  }

  private appendMessageStart(
    events: Array<AnthropicStreamEventData>,
    chunk: CapiChatCompletionChunk,
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

  private toConversationDeltas(
    chunk: CapiChatCompletionChunk,
  ): Array<ConversationDelta> {
    if (chunk.choices.length === 0) {
      return []
    }

    const sortedChoices = chunk.choices.toSorted((left, right) => left.index - right.index)
    const choice = sortedChoices[0]
    const deltas: Array<ConversationDelta> = []

    if (!this.state.messageStartSent) {
      deltas.push({
        kind: 'message_start',
        id: chunk.id,
        model: chunk.model,
        usage: chunk.usage,
      })
    }

    if (choice.delta.reasoning_text) {
      deltas.push({
        kind: 'thinking_delta',
        text: choice.delta.reasoning_text,
      })
    }

    if (choice.delta.content) {
      deltas.push({
        kind: 'text_delta',
        text: choice.delta.content,
      })
    }

    if (choice.delta.tool_calls?.length) {
      for (const toolCall of choice.delta.tool_calls) {
        deltas.push({
          kind: 'tool_use_delta',
          toolIndex: toolCall.index,
          id: toolCall.id,
          name: toolCall.function?.name,
          argumentsText: toolCall.function?.arguments,
        })
      }
    }

    if (choice.finish_reason) {
      deltas.push({
        kind: 'message_stop',
        stopReason: choice.finish_reason,
        usage: chunk.usage,
      })
    }

    return deltas
  }
}
