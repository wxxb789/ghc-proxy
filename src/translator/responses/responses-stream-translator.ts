import type { ResponsesStreamState } from './types'
import type { AnthropicStreamEventData } from '~/translator'
import type {
  ResponseCompletedEvent,
  ResponseCreatedEvent,
  ResponseErrorEvent,
  ResponseFailedEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  ResponseIncompleteEvent,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseReasoningSummaryTextDeltaEvent,
  ResponseReasoningSummaryTextDoneEvent,
  ResponseStreamEvent,
  ResponseTextDeltaEvent,
  ResponseTextDoneEvent,
} from '~/types'
import { THINKING_TEXT } from './anthropic-to-responses'
import { translateResponsesToAnthropic } from './responses-to-anthropic'
import { SignatureCodec } from './signature-codec'

const MAX_CONSECUTIVE_FUNCTION_CALL_WHITESPACE = 20

class FunctionCallArgumentsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FunctionCallArgumentsValidationError'
  }
}

function updateWhitespaceRunState(
  previousCount: number,
  chunk: string,
): { nextCount: number, exceeded: boolean } {
  let count = previousCount

  for (const char of chunk) {
    if (char === ' ' || char === '\r' || char === '\n' || char === '\t') {
      count += 1
      if (count > MAX_CONSECUTIVE_FUNCTION_CALL_WHITESPACE) {
        return { nextCount: count, exceeded: true }
      }
      continue
    }
    count = 0
  }

  return { nextCount: count, exceeded: false }
}

export class ResponsesStreamTranslator {
  private readonly state: ResponsesStreamState = {
    messageStartSent: false,
    messageCompleted: false,
    nextContentBlockIndex: 0,
    activeScalarBlockKey: null,
    activeScalarBlockIndex: null,
    blockHasDelta: new Set(),
    functionCallStateByOutputIndex: new Map(),
  }

  get isCompleted(): boolean {
    return this.state.messageCompleted
  }

  onEvent(rawEvent: ResponseStreamEvent): Array<AnthropicStreamEventData> {
    switch (rawEvent.type) {
      case 'response.created':
        return this.handleResponseCreated(rawEvent)
      case 'response.output_item.added':
        return this.handleOutputItemAdded(rawEvent)
      case 'response.output_item.done':
        return this.handleOutputItemDone(rawEvent)
      case 'response.output_text.delta':
        return this.handleOutputTextDelta(rawEvent)
      case 'response.output_text.done':
        return this.handleOutputTextDone(rawEvent)
      case 'response.reasoning_summary_text.delta':
        return this.handleReasoningSummaryTextDelta(rawEvent)
      case 'response.reasoning_summary_text.done':
        return this.handleReasoningSummaryTextDone(rawEvent)
      case 'response.function_call_arguments.delta':
        return this.handleFunctionCallArgumentsDelta(rawEvent)
      case 'response.function_call_arguments.done':
        return this.handleFunctionCallArgumentsDone(rawEvent)
      case 'response.completed':
      case 'response.incomplete':
        return this.handleResponseCompleted(rawEvent)
      case 'response.failed':
        return this.handleResponseFailed(rawEvent)
      case 'error':
        return this.handleErrorEvent(rawEvent)
      default:
        return []
    }
  }

  onDone(): Array<AnthropicStreamEventData> {
    if (this.state.messageCompleted) {
      return []
    }

    this.state.messageCompleted = true
    return [buildErrorEvent('Responses stream ended without completion')]
  }

  onError(error?: unknown): Array<AnthropicStreamEventData> {
    this.state.messageCompleted = true
    return [buildErrorEvent(error instanceof Error ? error.message : 'Responses stream failed')]
  }

  private handleResponseCreated(
    rawEvent: ResponseCreatedEvent,
  ): Array<AnthropicStreamEventData> {
    this.state.messageStartSent = true
    const cachedTokens = rawEvent.response.usage?.input_tokens_details?.cached_tokens ?? 0

    return [{
      type: 'message_start',
      message: {
        id: rawEvent.response.id,
        type: 'message',
        role: 'assistant',
        content: [],
        model: rawEvent.response.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: (rawEvent.response.usage?.input_tokens ?? 0) - cachedTokens,
          output_tokens: 0,
          cache_read_input_tokens: cachedTokens,
        },
      },
    }]
  }

  private handleOutputItemAdded(
    rawEvent: ResponseOutputItemAddedEvent,
  ): Array<AnthropicStreamEventData> {
    if (rawEvent.item.type !== 'function_call') {
      return []
    }

    const events: Array<AnthropicStreamEventData> = []
    const blockIndex = this.openFunctionCallBlock({
      outputIndex: rawEvent.output_index,
      toolCallId: rawEvent.item.call_id,
      name: rawEvent.item.name,
      events,
    })

    if (rawEvent.item.arguments) {
      events.push({
        type: 'content_block_delta',
        index: blockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: rawEvent.item.arguments,
        },
      })
      this.state.blockHasDelta.add(blockIndex)
    }

    return events
  }

  private handleOutputItemDone(
    rawEvent: ResponseOutputItemDoneEvent,
  ): Array<AnthropicStreamEventData> {
    const events: Array<AnthropicStreamEventData> = []

    if (rawEvent.item.type === 'compaction') {
      if (!rawEvent.item.id || !rawEvent.item.encrypted_content) {
        return events
      }

      const blockIndex = this.openThinkingBlock(rawEvent.output_index, events)
      if (!this.state.blockHasDelta.has(blockIndex)) {
        events.push({
          type: 'content_block_delta',
          index: blockIndex,
          delta: {
            type: 'thinking_delta',
            thinking: THINKING_TEXT,
          },
        })
      }

      events.push({
        type: 'content_block_delta',
        index: blockIndex,
        delta: {
          type: 'signature_delta',
          signature: SignatureCodec.encodeCompaction({
            id: rawEvent.item.id,
            encrypted_content: rawEvent.item.encrypted_content,
          }),
        },
      })
      this.state.blockHasDelta.add(blockIndex)
      this.closeScalarBlock(`thinking:${rawEvent.output_index}`, events)
      return events
    }

    if (rawEvent.item.type === 'reasoning') {
      const blockIndex = this.openThinkingBlock(rawEvent.output_index, events)
      if ((!rawEvent.item.summary || rawEvent.item.summary.length === 0) && !this.state.blockHasDelta.has(blockIndex)) {
        events.push({
          type: 'content_block_delta',
          index: blockIndex,
          delta: {
            type: 'thinking_delta',
            thinking: THINKING_TEXT,
          },
        })
      }
      events.push({
        type: 'content_block_delta',
        index: blockIndex,
        delta: {
          type: 'signature_delta',
          signature: SignatureCodec.encodeReasoning(rawEvent.item),
        },
      })
      this.state.blockHasDelta.add(blockIndex)
      this.closeScalarBlock(`thinking:${rawEvent.output_index}`, events)
    }

    if (rawEvent.item.type === 'function_call') {
      const blockIndex = this.openFunctionCallBlock({
        outputIndex: rawEvent.output_index,
        toolCallId: rawEvent.item.call_id,
        name: rawEvent.item.name,
        events,
      })
      if (rawEvent.item.arguments && !this.state.blockHasDelta.has(blockIndex)) {
        events.push({
          type: 'content_block_delta',
          index: blockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: rawEvent.item.arguments,
          },
        })
        this.state.blockHasDelta.add(blockIndex)
      }
      this.closeFunctionCallBlock(rawEvent.output_index, events)
    }

    return events
  }

  private handleOutputTextDelta(
    rawEvent: ResponseTextDeltaEvent,
  ): Array<AnthropicStreamEventData> {
    if (!rawEvent.delta) {
      return []
    }

    const events: Array<AnthropicStreamEventData> = []
    const blockIndex = this.openTextBlock(rawEvent.output_index, rawEvent.content_index, events)
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: {
        type: 'text_delta',
        text: rawEvent.delta,
      },
    })
    this.state.blockHasDelta.add(blockIndex)
    return events
  }

  private handleOutputTextDone(
    rawEvent: ResponseTextDoneEvent,
  ): Array<AnthropicStreamEventData> {
    if (!rawEvent.text) {
      return []
    }

    const events: Array<AnthropicStreamEventData> = []
    const blockIndex = this.openTextBlock(rawEvent.output_index, rawEvent.content_index, events)
    if (!this.state.blockHasDelta.has(blockIndex)) {
      events.push({
        type: 'content_block_delta',
        index: blockIndex,
        delta: {
          type: 'text_delta',
          text: rawEvent.text,
        },
      })
    }
    this.closeScalarBlock(`text:${rawEvent.output_index}:${rawEvent.content_index}`, events)
    return events
  }

  private handleReasoningSummaryTextDelta(
    rawEvent: ResponseReasoningSummaryTextDeltaEvent,
  ): Array<AnthropicStreamEventData> {
    const events: Array<AnthropicStreamEventData> = []
    const blockIndex = this.openThinkingBlock(rawEvent.output_index, events)
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: {
        type: 'thinking_delta',
        thinking: rawEvent.delta,
      },
    })
    this.state.blockHasDelta.add(blockIndex)
    return events
  }

  private handleReasoningSummaryTextDone(
    rawEvent: ResponseReasoningSummaryTextDoneEvent,
  ): Array<AnthropicStreamEventData> {
    if (!rawEvent.text) {
      return []
    }

    const events: Array<AnthropicStreamEventData> = []
    const blockIndex = this.openThinkingBlock(rawEvent.output_index, events)
    if (!this.state.blockHasDelta.has(blockIndex)) {
      events.push({
        type: 'content_block_delta',
        index: blockIndex,
        delta: {
          type: 'thinking_delta',
          thinking: rawEvent.text,
        },
      })
    }
    this.closeScalarBlock(`thinking:${rawEvent.output_index}`, events)
    return events
  }

  private handleFunctionCallArgumentsDelta(
    rawEvent: ResponseFunctionCallArgumentsDeltaEvent,
  ): Array<AnthropicStreamEventData> {
    if (!rawEvent.delta) {
      return []
    }

    const events: Array<AnthropicStreamEventData> = []
    const blockIndex = this.openFunctionCallBlock({
      outputIndex: rawEvent.output_index,
      events,
    })

    const functionCallState = this.state.functionCallStateByOutputIndex.get(rawEvent.output_index)
    if (!functionCallState) {
      return this.handleFunctionCallArgumentsValidationError(
        new FunctionCallArgumentsValidationError('Received function call arguments delta without an open tool call block.'),
      )
    }
    if (functionCallState.closed) {
      return this.handleFunctionCallArgumentsValidationError(
        new FunctionCallArgumentsValidationError('Received function call arguments delta after the tool call block was already completed.'),
      )
    }

    const { nextCount, exceeded } = updateWhitespaceRunState(
      functionCallState.consecutiveWhitespaceCount,
      rawEvent.delta,
    )
    if (exceeded) {
      return this.handleFunctionCallArgumentsValidationError(
        new FunctionCallArgumentsValidationError('Received function call arguments delta containing more than 20 consecutive whitespace characters.'),
      )
    }
    functionCallState.consecutiveWhitespaceCount = nextCount

    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: {
        type: 'input_json_delta',
        partial_json: rawEvent.delta,
      },
    })
    this.state.blockHasDelta.add(blockIndex)
    return events
  }

  private handleFunctionCallArgumentsDone(
    rawEvent: ResponseFunctionCallArgumentsDoneEvent,
  ): Array<AnthropicStreamEventData> {
    const events: Array<AnthropicStreamEventData> = []
    const blockIndex = this.openFunctionCallBlock({
      outputIndex: rawEvent.output_index,
      events,
    })

    if (rawEvent.arguments && !this.state.blockHasDelta.has(blockIndex)) {
      events.push({
        type: 'content_block_delta',
        index: blockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: rawEvent.arguments,
        },
      })
      this.state.blockHasDelta.add(blockIndex)
    }

    this.closeFunctionCallBlock(rawEvent.output_index, events)
    return events
  }

  private handleResponseCompleted(
    rawEvent: ResponseCompletedEvent | ResponseIncompleteEvent,
  ): Array<AnthropicStreamEventData> {
    const events: Array<AnthropicStreamEventData> = []
    this.closeAllOpenBlocks(events)
    const anthropic = translateResponsesToAnthropic(rawEvent.response)
    events.push({
      type: 'message_delta',
      delta: {
        stop_reason: anthropic.stop_reason,
        stop_sequence: anthropic.stop_sequence,
      },
      usage: anthropic.usage,
    })
    events.push({ type: 'message_stop' })
    this.state.messageCompleted = true
    return events
  }

  private handleResponseFailed(
    rawEvent: ResponseFailedEvent,
  ): Array<AnthropicStreamEventData> {
    this.state.messageCompleted = true
    return [buildErrorEvent(rawEvent.response.error?.message ?? 'The response failed due to an unknown error.')]
  }

  private handleErrorEvent(
    rawEvent: ResponseErrorEvent,
  ): Array<AnthropicStreamEventData> {
    this.state.messageCompleted = true
    return [buildErrorEvent(rawEvent.message || 'An unexpected error occurred during streaming.')]
  }

  private handleFunctionCallArgumentsValidationError(
    error: FunctionCallArgumentsValidationError,
  ): Array<AnthropicStreamEventData> {
    const events: Array<AnthropicStreamEventData> = []
    this.closeAllOpenBlocks(events)
    this.state.messageCompleted = true
    events.push(buildErrorEvent(error.message))
    return events
  }

  private openTextBlock(
    outputIndex: number,
    contentIndex: number,
    events: Array<AnthropicStreamEventData>,
  ): number {
    return this.openScalarBlock({
      key: `text:${outputIndex}:${contentIndex}`,
      contentBlock: {
        type: 'text',
        text: '',
      },
      events,
    })
  }

  private openThinkingBlock(
    outputIndex: number,
    events: Array<AnthropicStreamEventData>,
  ): number {
    return this.openScalarBlock({
      key: `thinking:${outputIndex}`,
      contentBlock: {
        type: 'thinking',
        thinking: '',
      },
      events,
    })
  }

  private openFunctionCallBlock(params: {
    outputIndex: number
    toolCallId?: string
    name?: string
    events: Array<AnthropicStreamEventData>
  }): number {
    let state = this.state.functionCallStateByOutputIndex.get(params.outputIndex)
    if (!state) {
      const blockIndex = this.state.nextContentBlockIndex++
      state = {
        blockIndex,
        toolCallId: params.toolCallId ?? `tool_call_${blockIndex}`,
        name: params.name ?? 'function',
        consecutiveWhitespaceCount: 0,
        started: false,
        closed: false,
      }
      this.state.functionCallStateByOutputIndex.set(params.outputIndex, state)
    }
    else if (state.closed) {
      throw new FunctionCallArgumentsValidationError('Cannot reopen a completed tool call block.')
    }

    if (!state.started) {
      params.events.push({
        type: 'content_block_start',
        index: state.blockIndex,
        content_block: {
          type: 'tool_use',
          id: state.toolCallId,
          name: state.name,
          input: {},
        },
      })
      state.started = true
    }

    return state.blockIndex
  }

  private openScalarBlock(params: {
    key: string
    contentBlock: Extract<
      AnthropicStreamEventData,
      { type: 'content_block_start' }
    >['content_block']
    events: Array<AnthropicStreamEventData>
  }): number {
    if (this.state.activeScalarBlockKey === params.key && this.state.activeScalarBlockIndex !== null) {
      return this.state.activeScalarBlockIndex
    }

    this.closeActiveScalarBlock(params.events)

    const blockIndex = this.state.nextContentBlockIndex++
    params.events.push({
      type: 'content_block_start',
      index: blockIndex,
      content_block: params.contentBlock,
    })
    this.state.activeScalarBlockKey = params.key
    this.state.activeScalarBlockIndex = blockIndex
    return blockIndex
  }

  private closeScalarBlock(
    key: string,
    events: Array<AnthropicStreamEventData>,
  ) {
    if (this.state.activeScalarBlockKey !== key) {
      return
    }
    this.closeActiveScalarBlock(events)
  }

  private closeActiveScalarBlock(events: Array<AnthropicStreamEventData>) {
    if (this.state.activeScalarBlockIndex === null) {
      return
    }

    events.push({
      type: 'content_block_stop',
      index: this.state.activeScalarBlockIndex,
    })
    this.state.blockHasDelta.delete(this.state.activeScalarBlockIndex)
    this.state.activeScalarBlockKey = null
    this.state.activeScalarBlockIndex = null
  }

  private closeFunctionCallBlock(
    outputIndex: number,
    events: Array<AnthropicStreamEventData>,
  ) {
    const state = this.state.functionCallStateByOutputIndex.get(outputIndex)
    if (!state || !state.started || state.closed) {
      return
    }

    events.push({
      type: 'content_block_stop',
      index: state.blockIndex,
    })
    this.state.blockHasDelta.delete(state.blockIndex)
    state.closed = true
  }

  private closeAllOpenBlocks(events: Array<AnthropicStreamEventData>) {
    this.closeActiveScalarBlock(events)

    const functionBlocks = [...this.state.functionCallStateByOutputIndex.entries()]
      .map(([, state]) => state)
      .filter(state => state.started && !state.closed)
      .sort((left, right) => left.blockIndex - right.blockIndex)

    for (const state of functionBlocks) {
      events.push({
        type: 'content_block_stop',
        index: state.blockIndex,
      })
      this.state.blockHasDelta.delete(state.blockIndex)
      state.closed = true
    }
  }
}

export function buildErrorEvent(message: string): AnthropicStreamEventData {
  return {
    type: 'error',
    error: {
      type: 'api_error',
      message,
    },
  }
}
