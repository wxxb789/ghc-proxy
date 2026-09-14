import type {
  ResponsesChatOutputOptions,
  ResponsesChatTool,
  ResponsesChatToolMap,
} from './chat-bridge-types'
import type { SSEOutput } from '~/lib/execution-strategy'
import type {
  ResponseCustomToolCallInputDoneEvent,
  ResponseError,
  ResponseIncompleteDetails,
  ResponseMessagePhase,
  ResponseOutputCustomToolCall,
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputText,
  ResponsesPayload,
  ResponsesResult,
  ResponseUsage,
} from '~/types'

import { randomUUID } from 'node:crypto'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'

const MAX_OUTPUT_CHARS = 2_000_000
const OUTPUT_CHARS_PER_TOKEN = 16
const MIN_OUTPUT_CHARS = 16_384
const MAX_TOOL_CALLS = 1024
const REASONING_FIELDS = ['reasoning_text', 'reasoning_content', 'reasoning_opaque', 'encrypted_content']

type RecordValue = Record<string, unknown>

interface MessagePartState {
  kind: 'text' | 'refusal'
  contentIndex: number
  text: string
  added: boolean
}

interface MessageState {
  kind: 'message'
  id: string
  outputIndex: number
  parts: Array<MessagePartState>
  phase?: ResponseMessagePhase
}

interface ToolCallState {
  kind: 'tool'
  upstreamIndex: number
  upstreamId?: string
  name?: string
  arguments: string
  metadata?: ResponsesChatTool
  outputIndex?: number
  itemId?: string
  callId?: string
  emittedArgumentLength: number
}

type OutputState = MessageState | ToolCallState

interface ToolValidation {
  valid: boolean
  customInput?: string
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readOptionalString(record: RecordValue, key: string): string | undefined {
  if (!Object.hasOwn(record, key))
    return undefined
  const value = record[key]
  if (value === null || value === undefined)
    return undefined
  if (typeof value !== 'string' || value.length === 0)
    throw invalidUpstream(`Upstream Chat Completions field "${key}" is invalid.`, `invalid_${key}`)
  return value
}

function readFiniteNumber(record: RecordValue, key: string): number | undefined {
  if (!Object.hasOwn(record, key))
    return undefined
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw invalidUpstream(`Upstream Chat Completions field "${key}" is invalid.`, `invalid_${key}`)
  return value
}

function readNullableFiniteNumber(record: RecordValue, key: string): number | undefined {
  if (!Object.hasOwn(record, key))
    return undefined
  const value = record[key]
  if (value === null || value === undefined)
    return undefined
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw invalidUpstream(`Upstream Chat Completions field "${key}" is invalid.`, `invalid_${key}`)
  return value
}

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 24)}`
}

function invalidUpstream(message: string, kind = 'invalid_upstream_response'): TranslationFailure {
  return new TranslationFailure(message, {
    status: 502,
    kind,
  })
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof TranslationFailure)
    return error.message
  return 'Upstream Chat Completions stream failed.'
}

function sanitizeUpstreamErrorMessage(value: string): string {
  const message = value.trim()
  if (!message || message.length > 240)
    return 'Upstream Chat Completions returned an error frame.'
  if (message.includes('{') || message.includes('}') || message.includes('[') || message.includes(']'))
    return 'Upstream Chat Completions returned an error frame.'
  return message
}

export function translateChatToResponses(
  result: unknown,
  payload: ResponsesPayload,
  toolMap: ResponsesChatToolMap,
  options?: ResponsesChatOutputOptions,
): ResponsesResult {
  const translator = new ChatToResponsesStreamTranslator(payload, toolMap, options)
  translator.onChunk(result)
  translator.onDone()

  const response = translator.terminalResponse
  if (!response) {
    throw invalidUpstream('Upstream Chat Completions response did not produce a terminal Responses result.')
  }
  if (response.status === 'failed') {
    throw translator.translationFailure
      ?? invalidUpstream(response.error?.message ?? 'Upstream Chat Completions response failed.')
  }
  return response
}

export class ChatToResponsesStreamTranslator {
  private readonly payload: ResponsesPayload
  private readonly toolMap: ResponsesChatToolMap
  private readonly options: ResponsesChatOutputOptions
  private readonly maxOutputChars: number
  private outputChars = 0
  private readonly responseId = makeId('resp')
  private readonly outputStates: Array<OutputState> = []
  private readonly toolCalls = new Map<number, ToolCallState>()
  private readonly toolCallIds = new Map<string, number>()
  private model: string
  private responseCreatedAt = Math.floor(Date.now() / 1000)
  private responseCreated = false
  private nextSequenceNumber = 0
  private nextOutputIndex = 0
  private choiceIndex: number | undefined
  private finishReason: string | undefined
  private usage: ResponseUsage | null = null
  private messagePhase: ResponseMessagePhase | undefined
  private messageState: MessageState | undefined
  private streamMode: boolean | undefined
  private reasoningOmissionReported = false
  private terminalResponseValue: ResponsesResult | null = null
  private terminalCallbackCalled = false
  private eofCallbackCalled = false
  private translationFailureValue: TranslationFailure | null = null

  constructor(
    payload: ResponsesPayload,
    toolMap: ResponsesChatToolMap,
    options?: ResponsesChatOutputOptions,
  ) {
    this.payload = payload
    this.toolMap = toolMap
    this.options = options ?? {}
    this.model = payload.model
    const outputTokens = this.options.maxOutputTokens ?? payload.max_output_tokens
    this.maxOutputChars = outputTokens != null && Number.isFinite(outputTokens)
      ? Math.min(MAX_OUTPUT_CHARS, Math.max(MIN_OUTPUT_CHARS, outputTokens * OUTPUT_CHARS_PER_TOKEN))
      : MAX_OUTPUT_CHARS
  }

  get isDone(): boolean {
    return this.terminalResponseValue !== null
  }

  get terminalResponse(): ResponsesResult | null {
    return this.terminalResponseValue
  }

  get translationFailure(): TranslationFailure | null {
    return this.translationFailureValue
  }

  onChunk(chunk: unknown): SSEOutput[] {
    if (this.isDone)
      return []

    const events: Array<SSEOutput> = []
    try {
      this.handleChunk(chunk, events)
      return events
    }
    catch (error) {
      return events.concat(this.fail(error))
    }
  }

  onDone(): SSEOutput[] {
    if (this.isDone)
      return []

    if (!this.finishReason) {
      if (this.streamMode !== false && !this.eofCallbackCalled) {
        this.eofCallbackCalled = true
        this.options.onStreamEndWithoutTerminal?.()
      }
      return this.fail(invalidUpstream(
        'Upstream Chat Completions stream ended before a finish reason was observed.',
        'upstream_stream_eof',
      ))
    }

    const status = this.mapFinishStatus(this.finishReason)
    if (status.kind === 'failed') {
      return this.fail(invalidUpstream(
        status.message ?? 'Upstream Chat Completions response failed.',
        status.errorKind ?? 'upstream_chat_error',
      ))
    }

    return this.finish(status.kind, status.incompleteDetails, undefined)
  }

  onError(error: unknown): SSEOutput[] {
    return this.fail(invalidUpstream(safeErrorMessage(error), 'upstream_chat_error'))
  }

  private handleChunk(chunk: unknown, events: Array<SSEOutput>): void {
    if (!isRecord(chunk))
      throw invalidUpstream('Upstream Chat Completions chunk is not an object.')

    const upstreamError = this.readUpstreamError(chunk)
    if (upstreamError)
      throw invalidUpstream(upstreamError, 'upstream_chat_error')

    const choices = chunk.choices
    if (!Array.isArray(choices))
      throw invalidUpstream('Upstream Chat Completions response has no choices array.', 'missing_upstream_choices')
    if (choices.length > 1)
      throw invalidUpstream('Upstream Chat Completions response contained multiple choices.', 'multiple_upstream_choices')

    this.updateEnvelope(chunk)
    this.updateUsage(chunk.usage)

    if (choices.length === 0)
      return

    const choice = choices[0]
    if (!isRecord(choice))
      throw invalidUpstream('Upstream Chat Completions choice is invalid.', 'invalid_upstream_choice')

    const hasMessage = Object.hasOwn(choice, 'message')
    const hasDelta = Object.hasOwn(choice, 'delta')
    if (!hasMessage && !hasDelta)
      throw invalidUpstream('Upstream Chat Completions choice has neither message nor delta.', 'invalid_upstream_choice')
    if (hasMessage && hasDelta)
      throw invalidUpstream('Upstream Chat Completions choice contains conflicting message and delta fields.', 'conflicting_upstream_choice')

    const isNonStreaming = hasMessage
    if (this.streamMode === undefined)
      this.streamMode = !isNonStreaming
    else if (!this.streamMode || this.streamMode === isNonStreaming)
      throw invalidUpstream('Upstream Chat Completions changed response mode mid-stream.', 'conflicting_upstream_mode')

    this.updateChoiceIndex(choice)
    this.ensureResponseCreated(events)

    const finishReason = this.readFinishReason(choice, isNonStreaming)
    if (isNonStreaming) {
      const message = choice.message
      if (!isRecord(message))
        throw invalidUpstream('Upstream Chat Completions message is invalid.', 'invalid_upstream_message')
      this.processMessage(message, events, false)
    }
    else {
      const delta = choice.delta
      if (!isRecord(delta))
        throw invalidUpstream('Upstream Chat Completions delta is invalid.', 'invalid_upstream_delta')
      this.processMessage(delta, events, true)
    }

    if (finishReason)
      this.setFinishReason(finishReason)
  }

  private updateEnvelope(chunk: RecordValue): void {
    const created = readFiniteNumber(chunk, 'created')
    if (created !== undefined && this.responseCreated === false)
      this.responseCreatedAt = created

    const model = readOptionalString(chunk, 'model')
    if (model && this.responseCreated && model !== this.model) {
      throw invalidUpstream('Upstream Chat Completions changed model mid-stream.', 'conflicting_upstream_model')
    }
    if (model && !this.responseCreated)
      this.model = model
  }

  private updateChoiceIndex(choice: RecordValue): void {
    const index = choice.index
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0)
      throw invalidUpstream('Upstream Chat Completions choice index is invalid.', 'unknown_upstream_choice')
    if (index !== 0)
      throw invalidUpstream('Upstream Chat Completions returned an unknown choice index.', 'unknown_upstream_choice')
    if (this.choiceIndex !== undefined && this.choiceIndex !== index)
      throw invalidUpstream('Upstream Chat Completions changed choice index mid-stream.', 'conflicting_upstream_choice')
    this.choiceIndex = index
  }

  private readFinishReason(choice: RecordValue, isNonStreaming: boolean): string | undefined {
    if (!Object.hasOwn(choice, 'finish_reason')) {
      if (isNonStreaming)
        throw invalidUpstream('Upstream Chat Completions response omitted finish_reason.', 'missing_finish_reason')
      return undefined
    }

    const value = choice.finish_reason
    if (value === null || value === undefined) {
      if (isNonStreaming)
        throw invalidUpstream('Upstream Chat Completions response omitted finish_reason.', 'missing_finish_reason')
      return undefined
    }
    if (typeof value !== 'string' || value.length === 0)
      throw invalidUpstream('Upstream Chat Completions finish_reason is invalid.', 'invalid_finish_reason')
    return value
  }

  private setFinishReason(reason: string): void {
    if (this.finishReason && this.finishReason !== reason)
      throw invalidUpstream('Upstream Chat Completions returned conflicting finish reasons.', 'conflicting_finish_reason')
    this.finishReason = reason
  }

  private processMessage(message: RecordValue, events: Array<SSEOutput>, isStreaming: boolean): void {
    if (Object.hasOwn(message, 'phase'))
      this.processMessagePhase(message.phase)
    if (Object.hasOwn(message, 'content'))
      this.processContent(message.content, events)
    if (Object.hasOwn(message, 'refusal'))
      this.processRefusal(message.refusal, events)
    this.processReasoning(message)
    if (Object.hasOwn(message, 'tool_calls'))
      this.processToolCalls(message.tool_calls, events, isStreaming)
  }

  private processMessagePhase(value: unknown): void {
    if (value === null || value === undefined)
      return
    if (value !== 'commentary' && value !== 'final_answer')
      throw invalidUpstream('Upstream Chat Completions message phase is invalid.', 'invalid_upstream_phase')
    if (this.messagePhase && this.messagePhase !== value)
      throw invalidUpstream('Upstream Chat Completions returned conflicting message phases.', 'conflicting_upstream_phase')
    this.messagePhase = value
    if (this.messageState)
      this.messageState.phase = value
  }

  private processContent(content: unknown, events: Array<SSEOutput>): void {
    if (content === null || content === undefined)
      return
    if (typeof content === 'string') {
      this.appendText(content, events)
      return
    }
    if (!Array.isArray(content))
      throw invalidUpstream('Upstream Chat Completions content is invalid.', 'invalid_upstream_content')

    for (const part of content) {
      if (!isRecord(part))
        throw invalidUpstream('Upstream Chat Completions content part is invalid.', 'invalid_upstream_content')
      if (part.type === 'text' && typeof part.text === 'string') {
        this.appendText(part.text, events)
        continue
      }
      if (part.type === 'refusal' && typeof part.refusal === 'string') {
        this.processRefusal(part.refusal, events)
        continue
      }
      throw invalidUpstream('Upstream Chat Completions content part is unsupported.', 'unsupported_upstream_content')
    }
  }

  private processRefusal(value: unknown, events: Array<SSEOutput>): void {
    if (value === null || value === undefined)
      return
    if (typeof value !== 'string')
      throw invalidUpstream('Upstream Chat Completions refusal is invalid.', 'invalid_upstream_refusal')
    if (!value)
      return

    this.reserveOutputChars(value)
    const message = this.ensureMessage(events)
    let part = message.parts.find(candidate => candidate.kind === 'refusal')
    if (!part) {
      part = {
        kind: 'refusal',
        contentIndex: message.parts.length,
        text: '',
        added: false,
      }
      message.parts.push(part)
      this.emitContentPartAdded(message, part, events)
    }
    part.text += value
    events.push(this.emit({
      type: 'response.refusal.delta',
      output_index: message.outputIndex,
      item_id: message.id,
      content_index: part.contentIndex,
      delta: value,
    }))
  }

  private processReasoning(message: RecordValue): void {
    if (this.reasoningOmissionReported)
      return
    const hasReasoning = REASONING_FIELDS
      .some(key => message[key] !== undefined && message[key] !== null && message[key] !== '')
    if (!hasReasoning)
      return
    this.reasoningOmissionReported = true
    this.options.onTranslationIssue?.({
      kind: 'lossy_reasoning_omitted',
      severity: 'warning',
      message: 'Provider reasoning was omitted because its state is not portable to Responses.',
    })
  }

  private processToolCalls(value: unknown, events: Array<SSEOutput>, isStreaming: boolean): void {
    if (value === null || value === undefined)
      return
    if (!Array.isArray(value))
      throw invalidUpstream('Upstream Chat Completions tool_calls is invalid.', 'invalid_upstream_tool_calls')

    const seenIndices = new Set<number>()
    for (const [ordinal, rawToolCall] of value.entries()) {
      if (!isRecord(rawToolCall))
        throw invalidUpstream('Upstream Chat Completions tool call is invalid.', 'invalid_upstream_tool_call')
      const rawIndex = rawToolCall.index
      const index = rawIndex === undefined && !isStreaming ? ordinal : rawIndex
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0)
        throw invalidUpstream('Upstream Chat Completions tool call index is invalid.', 'invalid_upstream_tool_call')
      if (seenIndices.has(index))
        throw invalidUpstream('Upstream Chat Completions contained duplicate tool call indices.', 'conflicting_upstream_tool_call')
      seenIndices.add(index)
      if (!this.toolCalls.has(index) && this.toolCalls.size >= MAX_TOOL_CALLS)
        throw invalidUpstream('Upstream Chat Completions returned too many tool calls.', 'upstream_output_too_large')

      const state = this.toolCalls.get(index) ?? {
        kind: 'tool' as const,
        upstreamIndex: index,
        arguments: '',
        emittedArgumentLength: 0,
      }
      const id = readOptionalString(rawToolCall, 'id')
      if (id) {
        if (state.upstreamId && state.upstreamId !== id)
          throw invalidUpstream('Upstream Chat Completions returned conflicting tool call IDs.', 'conflicting_upstream_tool_call')
        const existingIndex = this.toolCallIds.get(id)
        if (existingIndex !== undefined && existingIndex !== index)
          throw invalidUpstream('Upstream Chat Completions returned duplicate tool call IDs.', 'conflicting_upstream_tool_call')
        if (!state.upstreamId)
          this.reserveOutputChars(id)
        this.toolCallIds.set(id, index)
        state.upstreamId = id
      }

      const functionValue = rawToolCall.function
      if (functionValue !== undefined && !isRecord(functionValue))
        throw invalidUpstream('Upstream Chat Completions tool function is invalid.', 'invalid_upstream_tool_call')
      if (isRecord(functionValue)) {
        const name = readOptionalString(functionValue, 'name')
        if (name) {
          if (state.name && state.name !== name)
            throw invalidUpstream('Upstream Chat Completions returned conflicting tool names.', 'conflicting_upstream_tool_call')
          if (!state.name)
            this.reserveOutputChars(name)
          state.name = name
        }
        if (Object.hasOwn(functionValue, 'arguments')) {
          const argumentsValue = functionValue.arguments
          if (typeof argumentsValue !== 'string')
            throw invalidUpstream('Upstream Chat Completions tool arguments are invalid.', 'invalid_upstream_tool_arguments')
          this.appendToolArguments(state, argumentsValue)
        }
      }

      this.resolveToolMetadata(state)
      this.toolCalls.set(index, state)
      this.openToolIfReady(state, events)
    }
  }

  private appendToolArguments(state: ToolCallState, fragment: string): void {
    if (!fragment)
      return
    this.reserveOutputChars(fragment)
    state.arguments += fragment
  }

  private reserveOutputChars(fragment: string): void {
    if (this.outputChars + fragment.length > this.maxOutputChars)
      throw invalidUpstream('Upstream Chat Completions exceeded the buffered output limit.', 'upstream_output_too_large')
    this.outputChars += fragment.length
  }

  private resolveToolMetadata(state: ToolCallState): void {
    if (!state.name)
      return
    if (state.metadata)
      return

    const metadata = this.findToolMetadata(state.name)
    if (!metadata)
      throw invalidUpstream('Upstream Chat Completions returned an unknown tool call.', 'unknown_upstream_tool')
    state.metadata = metadata
  }

  private findToolMetadata(upstreamName: string): ResponsesChatTool | undefined {
    const direct = this.toolMap.get(upstreamName)
    if (direct)
      return direct

    // A request-local map normally keys by the reserved alias. Accept a
    // canonical name only when it is unambiguous; never derive a namespace or
    // alias from a provider string and expose it to the caller.
    let match: ResponsesChatTool | undefined
    for (const metadata of this.toolMap.values()) {
      if (metadata.name !== upstreamName)
        continue
      if (match)
        return undefined
      match = metadata
    }
    return match
  }

  private openToolIfReady(state: ToolCallState, events: Array<SSEOutput>): void {
    if (!state.name || !state.upstreamId || !state.metadata)
      return
    if (state.outputIndex === undefined) {
      const custom = state.metadata.type === 'custom'
      state.outputIndex = this.allocateOutputIndex()
      state.itemId = makeId(custom ? 'ctc' : 'fc')
      state.callId = state.upstreamId
      this.outputStates.push(state)
      events.push(this.emit({
        type: 'response.output_item.added',
        output_index: state.outputIndex,
        item: this.buildToolItem(state, 'in_progress', { valid: false }),
      }))
    }

    if (state.metadata.type === 'function' && state.arguments.length > state.emittedArgumentLength) {
      const delta = state.arguments.slice(state.emittedArgumentLength)
      state.emittedArgumentLength = state.arguments.length
      events.push(this.emit({
        type: 'response.function_call_arguments.delta',
        output_index: state.outputIndex,
        item_id: state.itemId,
        delta,
      }))
    }
  }

  private appendText(value: string, events: Array<SSEOutput>): void {
    if (!value)
      return
    this.reserveOutputChars(value)
    const message = this.ensureMessage(events)
    let part = message.parts.find(candidate => candidate.kind === 'text')
    if (!part) {
      part = {
        kind: 'text',
        contentIndex: message.parts.length,
        text: '',
        added: false,
      }
      message.parts.push(part)
      this.emitContentPartAdded(message, part, events)
    }
    part.text += value
    events.push(this.emit({
      type: 'response.output_text.delta',
      output_index: message.outputIndex,
      item_id: message.id,
      content_index: part.contentIndex,
      delta: value,
    }))
  }

  private ensureMessage(events: Array<SSEOutput>): MessageState {
    if (this.messageState)
      return this.messageState

    const state: MessageState = {
      kind: 'message',
      id: makeId('msg'),
      outputIndex: this.allocateOutputIndex(),
      parts: [],
      ...(this.messagePhase ? { phase: this.messagePhase } : {}),
    }
    this.messageState = state
    this.outputStates.push(state)
    events.push(this.emit({
      type: 'response.output_item.added',
      output_index: state.outputIndex,
      item: this.buildMessageItem(state, 'in_progress'),
    }))
    return state
  }

  private emitContentPartAdded(
    message: MessageState,
    part: MessagePartState,
    events: Array<SSEOutput>,
  ): void {
    if (part.added)
      return
    part.added = true
    const content = part.kind === 'text'
      ? this.buildTextBlock('')
      : { type: 'refusal', refusal: '' }
    events.push(this.emit({
      type: 'response.content_part.added',
      output_index: message.outputIndex,
      item_id: message.id,
      content_index: part.contentIndex,
      part: content,
    }))
  }

  private updateUsage(value: unknown): void {
    if (value === undefined)
      return
    if (value === null)
      return
    if (!isRecord(value))
      throw invalidUpstream('Upstream Chat Completions usage is invalid.', 'invalid_upstream_usage')

    const promptTokens = readNullableFiniteNumber(value, 'prompt_tokens')
    const completionTokens = readNullableFiniteNumber(value, 'completion_tokens')
    const totalTokens = readNullableFiniteNumber(value, 'total_tokens')
    const promptDetails = value.prompt_tokens_details
    let cachedTokens: number | undefined
    if (promptDetails !== undefined && promptDetails !== null) {
      if (!isRecord(promptDetails))
        throw invalidUpstream('Upstream Chat Completions prompt token details are invalid.', 'invalid_upstream_usage')
      cachedTokens = readNullableFiniteNumber(promptDetails, 'cached_tokens')
    }

    const completionDetails = value.completion_tokens_details
    let reasoningTokens: number | undefined
    if (completionDetails !== undefined && completionDetails !== null) {
      if (!isRecord(completionDetails))
        throw invalidUpstream('Upstream Chat Completions completion token details are invalid.', 'invalid_upstream_usage')
      reasoningTokens = readNullableFiniteNumber(completionDetails, 'reasoning_tokens')
    }

    if (promptTokens === undefined || totalTokens === undefined)
      return

    const result: ResponseUsage = {
      input_tokens: promptTokens,
      ...(completionTokens === undefined ? {} : { output_tokens: completionTokens }),
      total_tokens: totalTokens,
      ...(cachedTokens === undefined ? {} : { input_tokens_details: { cached_tokens: cachedTokens } }),
      ...(reasoningTokens === undefined ? {} : { output_tokens_details: { reasoning_tokens: reasoningTokens } }),
    }
    this.usage = result
  }

  private ensureResponseCreated(events: Array<SSEOutput>): void {
    if (this.responseCreated)
      return
    this.responseCreated = true
    const response = this.buildResponse('in_progress', [], '', null, null, null)
    events.push(this.emit({
      type: 'response.created',
      response: this.mapLifecycleResponse(response),
    }))
    events.push(this.emit({
      type: 'response.in_progress',
      response: this.mapLifecycleResponse(response),
    }))
  }

  private finish(
    status: 'completed' | 'incomplete' | 'failed',
    incompleteDetails: ResponseIncompleteDetails | null,
    errorMessage?: string,
    emitError = true,
  ): SSEOutput[] {
    if (this.isDone)
      return []

    let finalStatus = status
    let finalIncompleteDetails = incompleteDetails
    let finalErrorMessage = errorMessage
    let validations = new Map<ToolCallState, ToolValidation>()

    try {
      validations = this.validateToolCalls(status)
    }
    catch (error) {
      const failure = error instanceof TranslationFailure
        ? error
        : invalidUpstream('Upstream Chat Completions tool output was invalid.', 'invalid_upstream_tool_call')
      this.translationFailureValue = failure
      finalStatus = 'failed'
      finalIncompleteDetails = null
      finalErrorMessage = failure.message
    }

    const events: Array<SSEOutput> = []
    if (!this.responseCreated)
      this.ensureResponseCreated(events)
    events.push(...this.closeOutputStates(finalStatus, validations))

    if (finalStatus === 'failed' && emitError) {
      events.push(this.emit({
        type: 'error',
        code: this.translationFailureValue?.kind ?? 'upstream_chat_error',
        message: finalErrorMessage ?? 'Upstream Chat Completions response failed.',
        param: null,
      }))
    }

    const response = this.buildResponse(
      finalStatus,
      this.buildOutputItems(finalStatus, validations),
      this.buildOutputText(),
      this.usage,
      finalStatus === 'failed'
        ? { message: finalErrorMessage ?? 'Upstream Chat Completions response failed.', type: 'server_error' }
        : null,
      finalIncompleteDetails,
    )
    const mapped = this.mapLifecycleResponse(response)
    this.terminalResponseValue = mapped
    if (!this.terminalCallbackCalled) {
      this.terminalCallbackCalled = true
      this.options.onTerminalResponse?.(mapped)
    }

    if (finalStatus === 'completed') {
      events.push(this.emit({ type: 'response.completed', response: mapped }))
    }
    else if (finalStatus === 'incomplete') {
      events.push(this.emit({ type: 'response.incomplete', response: mapped }))
    }
    else {
      events.push(this.emit({ type: 'response.failed', response: mapped }))
    }
    return events
  }

  private validateToolCalls(status: 'completed' | 'incomplete' | 'failed'): Map<ToolCallState, ToolValidation> {
    if (status === 'completed')
      this.validateToolChoice()
    if (this.payload.parallel_tool_calls === false && this.toolCalls.size > 1) {
      throw invalidUpstream(
        'Upstream Chat Completions returned multiple tool calls while parallel_tool_calls was disabled.',
        'parallel_tool_calls_violation',
      )
    }
    if (this.payload.tool_choice === 'none' && this.toolCalls.size > 0) {
      throw invalidUpstream(
        'Upstream Chat Completions returned a tool call while tool_choice was none.',
        'tool_choice_violation',
      )
    }

    const validations = new Map<ToolCallState, ToolValidation>()
    for (const state of this.toolCalls.values()) {
      if (!state.name || !state.upstreamId || !state.metadata || state.outputIndex === undefined) {
        if (status === 'completed')
          throw invalidUpstream('Upstream Chat Completions returned an incomplete tool call identity.', 'missing_upstream_tool_identity')
        continue
      }

      if (status === 'failed') {
        validations.set(state, { valid: false })
        continue
      }

      if (state.metadata.type === 'custom') {
        try {
          const customInput = parseCustomInput(state.arguments)
          validations.set(state, { valid: true, customInput })
        }
        catch (error) {
          if (status === 'completed')
            throw error
          validations.set(state, { valid: false })
        }
        continue
      }

      try {
        parseFunctionArguments(state.arguments)
        validations.set(state, { valid: true })
      }
      catch (error) {
        if (status === 'completed')
          throw error
        validations.set(state, { valid: false })
      }
    }
    return validations
  }

  private validateToolChoice(): void {
    const choice = this.payload.tool_choice
    let required = choice === 'required'
    let allowed: Array<RecordValue> | undefined
    if (isRecord(choice)) {
      if (choice.type === 'function' || choice.type === 'custom') {
        required = true
        allowed = [choice]
      }
      else if (choice.type === 'apply_patch') {
        required = true
        allowed = [{ type: 'custom', name: 'apply_patch' }]
      }
      else if (choice.type === 'allowed_tools') {
        required = choice.mode === 'required'
        if (!Array.isArray(choice.tools) || !choice.tools.every(isRecord))
          throw invalidUpstream('The translated allowed tool choice is invalid.', 'tool_choice_violation')
        allowed = choice.tools
      }
    }
    if (required && this.toolCalls.size === 0)
      throw invalidUpstream('Upstream Chat Completions omitted a required tool call.', 'tool_choice_violation')
    if (!allowed)
      return
    for (const state of this.toolCalls.values()) {
      const tool = state.metadata
      if (!tool || !allowed.some(reference => this.matchesToolChoice(reference, tool))) {
        throw invalidUpstream('Upstream Chat Completions returned a tool outside tool_choice.', 'tool_choice_violation')
      }
    }
  }

  private matchesToolChoice(reference: RecordValue, tool: ResponsesChatTool): boolean {
    const sameNameAndNamespace = reference.name === tool.name
      && (reference.namespace == null || reference.namespace === tool.namespace)
    if (!sameNameAndNamespace)
      return false
    return reference.type === tool.type
      || (reference.type === 'function' && tool.type === 'custom' && tool.name === 'apply_patch')
  }

  private closeOutputStates(
    status: 'completed' | 'incomplete' | 'failed',
    validations: Map<ToolCallState, ToolValidation>,
  ): Array<SSEOutput> {
    const events: Array<SSEOutput> = []
    const itemStatus = status === 'completed' ? 'completed' : 'incomplete'

    for (const state of this.outputStates) {
      if (state.kind === 'message') {
        for (const part of state.parts) {
          if (part.kind === 'text') {
            events.push(this.emit({
              type: 'response.output_text.done',
              output_index: state.outputIndex,
              item_id: state.id,
              content_index: part.contentIndex,
              text: part.text,
            }))
            events.push(this.emit({
              type: 'response.content_part.done',
              output_index: state.outputIndex,
              item_id: state.id,
              content_index: part.contentIndex,
              part: this.buildTextBlock(part.text),
            }))
          }
          else {
            events.push(this.emit({
              type: 'response.refusal.done',
              output_index: state.outputIndex,
              item_id: state.id,
              content_index: part.contentIndex,
              refusal: part.text,
            }))
            events.push(this.emit({
              type: 'response.content_part.done',
              output_index: state.outputIndex,
              item_id: state.id,
              content_index: part.contentIndex,
              part: { type: 'refusal', refusal: part.text },
            }))
          }
        }
        events.push(this.emit({
          type: 'response.output_item.done',
          output_index: state.outputIndex,
          item: this.buildMessageItem(state, itemStatus),
        }))
        continue
      }

      const validation = validations.get(state)
      if (!validation?.valid || status !== 'completed' || state.outputIndex === undefined || !state.itemId)
        continue

      if (state.metadata?.type === 'custom') {
        const input = validation.customInput ?? ''
        events.push(this.emit({
          type: 'response.custom_tool_call_input.delta',
          output_index: state.outputIndex,
          item_id: state.itemId,
          delta: input,
        }))
        const doneEvent: Omit<ResponseCustomToolCallInputDoneEvent, 'sequence_number'> = {
          type: 'response.custom_tool_call_input.done',
          output_index: state.outputIndex,
          item_id: state.itemId,
          input,
        }
        events.push(this.emit(doneEvent))
      }
      else {
        events.push(this.emit({
          type: 'response.function_call_arguments.done',
          output_index: state.outputIndex,
          item_id: state.itemId,
          name: state.metadata?.name ?? state.name ?? '',
          arguments: state.arguments,
        }))
      }
      events.push(this.emit({
        type: 'response.output_item.done',
        output_index: state.outputIndex,
        item: this.buildToolItem(state, itemStatus, validation),
      }))
    }
    return events
  }

  private buildResponse(
    status: 'in_progress' | 'completed' | 'incomplete' | 'failed',
    output: Array<ResponseOutputItem>,
    outputText: string,
    usage: ResponseUsage | null,
    error: ResponseError | null,
    incompleteDetails: ResponseIncompleteDetails | null,
  ): ResponsesResult {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.responseCreatedAt,
      model: this.model,
      previous_response_id: this.payload.previous_response_id ?? null,
      conversation: this.payload.conversation ?? null,
      output,
      output_text: outputText,
      status,
      usage,
      error,
      incomplete_details: incompleteDetails,
      instructions: this.payload.instructions ?? null,
      metadata: this.payload.metadata ?? null,
      parallel_tool_calls: this.payload.parallel_tool_calls ?? true,
      temperature: this.payload.temperature ?? null,
      tool_choice: this.payload.tool_choice ?? 'auto',
      tools: this.payload.tools ?? [],
      top_p: this.payload.top_p ?? null,
      truncation: this.payload.truncation ?? null,
      store: this.payload.store ?? null,
      user: this.payload.user ?? null,
      service_tier: this.payload.service_tier ?? null,
    }
  }

  private buildOutputItems(
    status: 'completed' | 'incomplete' | 'failed',
    validations: Map<ToolCallState, ToolValidation>,
  ): Array<ResponseOutputItem> {
    const itemStatus = status === 'completed' ? 'completed' : 'incomplete'
    const output: Array<ResponseOutputItem> = []
    for (const state of this.outputStates) {
      if (state.kind === 'message') {
        output.push(this.buildMessageItem(state, itemStatus))
      }
      else {
        const validation = validations.get(state) ?? { valid: false }
        if (state.outputIndex !== undefined && state.itemId && state.metadata && state.name && state.upstreamId) {
          output.push(this.buildToolItem(state, itemStatus, validation))
        }
      }
    }
    return output
  }

  private buildOutputText(): string {
    const text = this.messageState?.parts
      .filter(part => part.kind === 'text')
      .map(part => part.text)
      .join('')
    return text ?? ''
  }

  private buildMessageItem(state: MessageState, status: 'in_progress' | 'completed' | 'incomplete'): ResponseOutputMessage {
    return {
      id: state.id,
      type: 'message',
      role: 'assistant',
      status,
      content: state.parts.map((part) => {
        if (part.kind === 'text')
          return this.buildTextBlock(part.text)
        return { type: 'refusal', refusal: part.text }
      }),
      ...(state.phase ? { phase: state.phase } : {}),
    }
  }

  private buildToolItem(
    state: ToolCallState,
    status: 'in_progress' | 'completed' | 'incomplete',
    validation: ToolValidation,
  ): ResponseOutputFunctionCall | ResponseOutputCustomToolCall {
    const metadata = state.metadata
    const name = metadata?.name ?? state.name ?? ''
    const namespace = metadata?.namespace
    if (metadata?.type === 'custom') {
      return {
        id: state.itemId,
        type: 'custom_tool_call',
        call_id: state.callId ?? state.itemId ?? '',
        name,
        input: validation.valid
          ? (validation.customInput ?? state.arguments)
          : (status === 'in_progress' ? '' : state.arguments),
        ...(namespace ? { namespace } : {}),
        status,
      }
    }
    return {
      id: state.itemId,
      type: 'function_call',
      call_id: state.callId ?? state.itemId ?? '',
      name,
      arguments: validation.valid || status !== 'in_progress' ? state.arguments : '',
      ...(namespace ? { namespace } : {}),
      status,
    }
  }

  private buildTextBlock(text: string): ResponseOutputText {
    return {
      type: 'output_text',
      text,
      annotations: [],
    }
  }

  private allocateOutputIndex(): number {
    return this.nextOutputIndex++
  }

  private mapLifecycleResponse(response: ResponsesResult): ResponsesResult {
    return this.options.mapResponse
      ? this.options.mapResponse(response)
      : response
  }

  private emit(event: RecordValue & { type: string }): SSEOutput {
    const data = {
      ...event,
      sequence_number: this.nextSequenceNumber++,
    }
    return {
      event: event.type,
      data: JSON.stringify(data),
    }
  }

  private fail(error: unknown): SSEOutput[] {
    if (this.isDone)
      return []

    const failure = error instanceof TranslationFailure
      ? error
      : invalidUpstream('Upstream Chat Completions response is invalid.', 'invalid_upstream_response')
    this.translationFailureValue = failure
    const message = safeErrorMessage(failure)
    const events: Array<SSEOutput> = []
    this.ensureResponseCreated(events)
    events.push(this.emit({
      type: 'error',
      code: failure.kind,
      message,
      param: null,
    }))
    events.push(...this.finish('failed', null, message, false))
    return events
  }

  private readUpstreamError(chunk: RecordValue): string | undefined {
    if (chunk.type === 'error') {
      const error = chunk.error
      if (isRecord(error) && typeof error.message === 'string')
        return sanitizeUpstreamErrorMessage(error.message)
      if (typeof chunk.message === 'string')
        return sanitizeUpstreamErrorMessage(chunk.message)
      return 'Upstream Chat Completions returned an error frame.'
    }
    if (!Object.hasOwn(chunk, 'error'))
      return undefined
    const error = chunk.error
    if (isRecord(error) && typeof error.message === 'string')
      return sanitizeUpstreamErrorMessage(error.message)
    return 'Upstream Chat Completions returned an error frame.'
  }

  private mapFinishStatus(reason: string): {
    kind: 'completed' | 'incomplete' | 'failed'
    incompleteDetails: ResponseIncompleteDetails | null
    message?: string
    errorKind?: string
  } {
    switch (reason) {
      case 'stop':
      case 'tool_calls':
        return { kind: 'completed', incompleteDetails: null }
      case 'length':
        return { kind: 'incomplete', incompleteDetails: { reason: 'max_output_tokens' } }
      case 'content_filter':
        return { kind: 'incomplete', incompleteDetails: { reason: 'content_filter' } }
      case 'error':
        return {
          kind: 'failed',
          incompleteDetails: null,
          message: 'Upstream Chat Completions returned an error finish reason.',
          errorKind: 'upstream_chat_error',
        }
      default:
        return {
          kind: 'failed',
          incompleteDetails: null,
          message: 'Upstream Chat Completions returned an unsupported finish reason.',
          errorKind: 'unknown_finish_reason',
        }
    }
  }
}

function parseFunctionArguments(raw: string): void {
  if (!raw.trim())
    throw invalidUpstream('Upstream function call arguments are empty.', 'invalid_upstream_tool_arguments')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  }
  catch {
    throw invalidUpstream('Upstream function call arguments are not complete JSON.', 'invalid_upstream_tool_arguments')
  }
  if (!isRecord(parsed))
    throw invalidUpstream('Upstream function call arguments must be a JSON object.', 'invalid_upstream_tool_arguments')
}

function parseCustomInput(raw: string): string {
  if (!raw.trim())
    throw invalidUpstream('Upstream custom tool arguments are empty.', 'invalid_custom_tool_call')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  }
  catch {
    throw invalidUpstream('Upstream custom tool arguments are not complete JSON.', 'invalid_custom_tool_call')
  }
  if (
    !isRecord(parsed)
    || Object.keys(parsed).length !== 1
    || !Object.hasOwn(parsed, 'input')
    || typeof parsed.input !== 'string'
  ) {
    throw invalidUpstream('Upstream custom tool arguments must contain a string input.', 'invalid_custom_tool_call')
  }
  return parsed.input
}
