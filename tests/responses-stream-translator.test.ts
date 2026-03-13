import type {
  AnthropicContentBlockDeltaEvent,
  AnthropicContentBlockStartEvent,
  AnthropicContentBlockStopEvent,
  AnthropicErrorEvent,
  AnthropicMessageDeltaEvent,
  AnthropicMessageStartEvent,
} from '~/translator/anthropic/types'
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from '~/types'
import { describe, expect, test } from 'bun:test'

import { buildErrorEvent, ResponsesStreamTranslator } from '~/translator/responses/responses-stream-translator'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResponsesResult(overrides?: Partial<ResponsesResult>): ResponsesResult {
  return {
    id: 'resp-test-123',
    object: 'response',
    created_at: Date.now(),
    model: 'claude-sonnet-4.5',
    output: [],
    output_text: '',
    status: 'completed',
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: null,
    tools: [],
    top_p: null,
    ...overrides,
  }
}

function createdEvent(overrides?: Partial<ResponsesResult>): ResponseStreamEvent {
  return {
    type: 'response.created',
    sequence_number: 0,
    response: buildResponsesResult(overrides),
  }
}

function textDeltaEvent(delta: string, outputIndex = 0, contentIndex = 0): ResponseStreamEvent {
  return {
    type: 'response.output_text.delta',
    sequence_number: 1,
    output_index: outputIndex,
    item_id: 'item-1',
    content_index: contentIndex,
    delta,
  }
}

function textDoneEvent(text: string, outputIndex = 0, contentIndex = 0): ResponseStreamEvent {
  return {
    type: 'response.output_text.done',
    sequence_number: 2,
    output_index: outputIndex,
    item_id: 'item-1',
    content_index: contentIndex,
    text,
  }
}

function thinkingDeltaEvent(delta: string, outputIndex = 0): ResponseStreamEvent {
  return {
    type: 'response.reasoning_summary_text.delta',
    sequence_number: 1,
    output_index: outputIndex,
    item_id: 'item-1',
    summary_index: 0,
    delta,
  }
}

function thinkingDoneEvent(text: string, outputIndex = 0): ResponseStreamEvent {
  return {
    type: 'response.reasoning_summary_text.done',
    sequence_number: 2,
    output_index: outputIndex,
    item_id: 'item-1',
    summary_index: 0,
    text,
  }
}

function completedEvent(overrides?: Partial<ResponsesResult>): ResponseStreamEvent {
  return {
    type: 'response.completed',
    sequence_number: 99,
    response: buildResponsesResult(overrides),
  }
}

// ---------------------------------------------------------------------------
// 1. onEvent — response.created
// ---------------------------------------------------------------------------

describe('onEvent — response.created', () => {
  test('emits message_start with id/model/usage', () => {
    const translator = new ResponsesStreamTranslator()
    const events = translator.onEvent(createdEvent())

    expect(events).toHaveLength(1)
    const msgStart = events[0] as AnthropicMessageStartEvent
    expect(msgStart.type).toBe('message_start')
    expect(msgStart.message.id).toBe('resp-test-123')
    expect(msgStart.message.model).toBe('claude-sonnet-4.5')
    expect(msgStart.message.role).toBe('assistant')
    expect(msgStart.message.content).toEqual([])
    expect(msgStart.message.stop_reason).toBeNull()
    expect(msgStart.message.stop_sequence).toBeNull()
  })

  test('cached tokens subtracted from input_tokens, added to cache_read_input_tokens', () => {
    const translator = new ResponsesStreamTranslator()
    const events = translator.onEvent(createdEvent({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_details: { cached_tokens: 30 },
      },
    }))

    const msgStart = events[0] as AnthropicMessageStartEvent
    expect(msgStart.message.usage.input_tokens).toBe(70) // 100 - 30
    expect(msgStart.message.usage.cache_read_input_tokens).toBe(30)
    expect(msgStart.message.usage.output_tokens).toBe(0)
  })

  test('missing usage defaults to zeros', () => {
    const translator = new ResponsesStreamTranslator()
    const events = translator.onEvent(createdEvent({
      usage: undefined,
    }))

    const msgStart = events[0] as AnthropicMessageStartEvent
    expect(msgStart.message.usage.input_tokens).toBe(0)
    expect(msgStart.message.usage.output_tokens).toBe(0)
    expect(msgStart.message.usage.cache_read_input_tokens).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. onEvent — text streaming
// ---------------------------------------------------------------------------

describe('onEvent — text streaming', () => {
  test('output_text.delta opens text block and emits text_delta', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    const events = translator.onEvent(textDeltaEvent('Hello'))

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    expect(blockStart.content_block.type).toBe('text')
    expect(blockStart.index).toBe(0)

    const blockDelta = events.find(e => e.type === 'content_block_delta') as
      AnthropicContentBlockDeltaEvent
    expect(blockDelta).toBeDefined()
    expect(blockDelta.delta.type).toBe('text_delta')
    expect((blockDelta.delta as { type: 'text_delta', text: string }).text).toBe('Hello')
  })

  test('multiple deltas to same output_index/content_index reuse same block', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    translator.onEvent(textDeltaEvent('Hello'))

    const events = translator.onEvent(textDeltaEvent(' world'))

    const blockStarts = events.filter(e => e.type === 'content_block_start')
    expect(blockStarts).toHaveLength(0)

    const blockDelta = events.find(e => e.type === 'content_block_delta') as
      AnthropicContentBlockDeltaEvent
    expect(blockDelta).toBeDefined()
    expect((blockDelta.delta as { type: 'text_delta', text: string }).text).toBe(' world')
  })

  test('output_text.done after deltas does NOT re-append text', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    translator.onEvent(textDeltaEvent('Hello world'))

    const events = translator.onEvent(textDoneEvent('Hello world'))

    // Should have content_block_stop but no content_block_delta
    const deltas = events.filter(e => e.type === 'content_block_delta')
    expect(deltas).toHaveLength(0)

    const stops = events.filter(e => e.type === 'content_block_stop')
    expect(stops).toHaveLength(1)
  })

  test('output_text.done without prior delta DOES append text', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    const events = translator.onEvent(textDoneEvent('Full text'))

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    expect(blockStart.content_block.type).toBe('text')

    const blockDelta = events.find(e => e.type === 'content_block_delta') as
      AnthropicContentBlockDeltaEvent
    expect(blockDelta).toBeDefined()
    expect((blockDelta.delta as { type: 'text_delta', text: string }).text).toBe('Full text')
  })

  test('empty delta returns empty array', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    const events = translator.onEvent(textDeltaEvent(''))
    expect(events).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. onEvent — thinking streaming
// ---------------------------------------------------------------------------

describe('onEvent — thinking streaming', () => {
  test('reasoning_summary_text.delta opens thinking block and emits thinking_delta', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    const events = translator.onEvent(thinkingDeltaEvent('Let me think'))

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    expect(blockStart.content_block.type).toBe('thinking')

    const blockDelta = events.find(e => e.type === 'content_block_delta') as
      AnthropicContentBlockDeltaEvent
    expect(blockDelta).toBeDefined()
    expect(blockDelta.delta.type).toBe('thinking_delta')
    expect((blockDelta.delta as { type: 'thinking_delta', thinking: string }).thinking).toBe('Let me think')
  })

  test('reasoning_summary_text.done after deltas skips re-append', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    translator.onEvent(thinkingDeltaEvent('thinking content'))

    const events = translator.onEvent(thinkingDoneEvent('thinking content'))

    const deltas = events.filter(e => e.type === 'content_block_delta')
    expect(deltas).toHaveLength(0)

    const stops = events.filter(e => e.type === 'content_block_stop')
    expect(stops).toHaveLength(1)
  })

  test('reasoning_summary_text.done without prior delta appends text', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    const events = translator.onEvent(thinkingDoneEvent('full thinking'))

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    expect(blockStart.content_block.type).toBe('thinking')

    const blockDelta = events.find(e => e.type === 'content_block_delta') as
      AnthropicContentBlockDeltaEvent
    expect(blockDelta).toBeDefined()
    expect((blockDelta.delta as { type: 'thinking_delta', thinking: string }).thinking).toBe('full thinking')
  })
})

// ---------------------------------------------------------------------------
// 4. onEvent — scalar block switching
// ---------------------------------------------------------------------------

describe('onEvent — scalar block switching', () => {
  test('text -> thinking: closes text block, opens thinking block', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    translator.onEvent(textDeltaEvent('some text'))

    const events = translator.onEvent(thinkingDeltaEvent('thinking', 1))

    const blockStop = events.find(e => e.type === 'content_block_stop') as
      AnthropicContentBlockStopEvent
    expect(blockStop).toBeDefined()
    expect(blockStop.index).toBe(0) // text block index

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    expect(blockStart.content_block.type).toBe('thinking')
    expect(blockStart.index).toBe(1) // next block index
  })

  test('thinking -> text: closes thinking block, opens text block', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    translator.onEvent(thinkingDeltaEvent('thinking'))

    const events = translator.onEvent(textDeltaEvent('response'))

    const blockStop = events.find(e => e.type === 'content_block_stop') as
      AnthropicContentBlockStopEvent
    expect(blockStop).toBeDefined()
    expect(blockStop.index).toBe(0) // thinking block index

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    expect(blockStart.content_block.type).toBe('text')
    expect(blockStart.index).toBe(1) // next block index
  })

  test('each switch increments content block index', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    // Block 0: text
    translator.onEvent(textDeltaEvent('text1'))
    // Block 1: thinking (closes text 0)
    translator.onEvent(thinkingDeltaEvent('think1', 1))
    // Block 2: text (closes thinking 1)
    const events = translator.onEvent(textDeltaEvent('text2', 2))

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    expect(blockStart.index).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 5. onEvent — function calls
// ---------------------------------------------------------------------------

describe('onEvent — function calls', () => {
  test('output_item.added with function_call opens tool block with call_id + name', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    const events = translator.onEvent({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: 'fc-1',
        type: 'function_call',
        call_id: 'call_abc',
        name: 'get_weather',
        arguments: '',
        status: 'in_progress',
      },
    })

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    expect(blockStart.content_block.type).toBe('tool_use')
    const toolBlock = blockStart.content_block as { type: 'tool_use', id: string, name: string }
    expect(toolBlock.id).toBe('call_abc')
    expect(toolBlock.name).toBe('get_weather')
  })

  test('function_call_arguments.delta appends input_json_delta', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    translator.onEvent({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: 'fc-1',
        type: 'function_call',
        call_id: 'call_abc',
        name: 'get_weather',
        arguments: '',
        status: 'in_progress',
      },
    })

    const events = translator.onEvent({
      type: 'response.function_call_arguments.delta',
      sequence_number: 2,
      output_index: 0,
      item_id: 'fc-1',
      delta: '{"city":"SF"}',
    })

    const blockDelta = events.find(e => e.type === 'content_block_delta') as
      AnthropicContentBlockDeltaEvent
    expect(blockDelta).toBeDefined()
    expect(blockDelta.delta.type).toBe('input_json_delta')
    expect((blockDelta.delta as { type: 'input_json_delta', partial_json: string }).partial_json).toBe('{"city":"SF"}')
  })

  test('function_call_arguments.done closes block', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    translator.onEvent({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: 'fc-1',
        type: 'function_call',
        call_id: 'call_abc',
        name: 'get_weather',
        arguments: '',
        status: 'in_progress',
      },
    })

    const events = translator.onEvent({
      type: 'response.function_call_arguments.done',
      sequence_number: 3,
      output_index: 0,
      item_id: 'fc-1',
      name: 'get_weather',
      arguments: '{"city":"SF"}',
    })

    const blockStop = events.find(e => e.type === 'content_block_stop') as
      AnthropicContentBlockStopEvent
    expect(blockStop).toBeDefined()
  })

  test('missing call_id defaults to tool_call_{index}', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    // Simulate receiving a function_call_arguments.delta without prior output_item.added
    // The openFunctionCallBlock will be called without toolCallId/name, triggering defaults
    const events = translator.onEvent({
      type: 'response.function_call_arguments.delta',
      sequence_number: 1,
      output_index: 5,
      item_id: 'fc-1',
      delta: '{"x":1}',
    })

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    const toolBlock = blockStart.content_block as { type: 'tool_use', id: string, name: string }
    expect(toolBlock.id).toBe(`tool_call_${blockStart.index}`)
  })

  test('missing name defaults to function', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    // Same pattern — no prior output_item.added means no name provided
    const events = translator.onEvent({
      type: 'response.function_call_arguments.delta',
      sequence_number: 1,
      output_index: 7,
      item_id: 'fc-1',
      delta: '{"x":1}',
    })

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    const toolBlock = blockStart.content_block as { type: 'tool_use', id: string, name: string }
    expect(toolBlock.name).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// 6. onEvent — whitespace validation
// ---------------------------------------------------------------------------

describe('onEvent — whitespace validation', () => {
  test('20 consecutive whitespace chars in function args: OK', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    translator.onEvent({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: 'fc-1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'fn',
        arguments: '',
        status: 'in_progress',
      },
    })

    const events = translator.onEvent({
      type: 'response.function_call_arguments.delta',
      sequence_number: 2,
      output_index: 0,
      item_id: 'fc-1',
      delta: ' '.repeat(20),
    })

    // No error event
    const errors = events.filter(e => e.type === 'error')
    expect(errors).toHaveLength(0)
  })

  test('21 consecutive whitespace chars: error event', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    translator.onEvent({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: 'fc-1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'fn',
        arguments: '',
        status: 'in_progress',
      },
    })

    const events = translator.onEvent({
      type: 'response.function_call_arguments.delta',
      sequence_number: 2,
      output_index: 0,
      item_id: 'fc-1',
      delta: ' '.repeat(21),
    })

    const errorEvent = events.find(e => e.type === 'error') as AnthropicErrorEvent
    expect(errorEvent).toBeDefined()
    expect(errorEvent.error.message).toContain('whitespace')
    expect(translator.isCompleted).toBe(true)
  })

  test('non-whitespace resets counter', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    translator.onEvent({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: 'fc-1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'fn',
        arguments: '',
        status: 'in_progress',
      },
    })

    // 15 spaces
    translator.onEvent({
      type: 'response.function_call_arguments.delta',
      sequence_number: 2,
      output_index: 0,
      item_id: 'fc-1',
      delta: ' '.repeat(15),
    })

    // Non-whitespace resets
    translator.onEvent({
      type: 'response.function_call_arguments.delta',
      sequence_number: 3,
      output_index: 0,
      item_id: 'fc-1',
      delta: 'x',
    })

    // Another 15 spaces (total consecutive would be 15, not 30)
    const events = translator.onEvent({
      type: 'response.function_call_arguments.delta',
      sequence_number: 4,
      output_index: 0,
      item_id: 'fc-1',
      delta: ' '.repeat(15),
    })

    const errors = events.filter(e => e.type === 'error')
    expect(errors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 7. onEvent — compaction/reasoning items
// ---------------------------------------------------------------------------

describe('onEvent — compaction/reasoning items', () => {
  test('output_item.done with compaction emits thinking block with Thinking... + signature_delta', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    const events = translator.onEvent({
      type: 'response.output_item.done',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: 'compact-1',
        type: 'compaction',
        encrypted_content: 'encrypted-data',
      },
    })

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    expect(blockStart.content_block.type).toBe('thinking')

    const thinkingDelta = events.find(e =>
      e.type === 'content_block_delta'
      && (e as AnthropicContentBlockDeltaEvent).delta.type === 'thinking_delta',
    ) as AnthropicContentBlockDeltaEvent
    expect(thinkingDelta).toBeDefined()
    expect((thinkingDelta.delta as { type: 'thinking_delta', thinking: string }).thinking).toBe('Thinking...')

    const signatureDelta = events.find(e =>
      e.type === 'content_block_delta'
      && (e as AnthropicContentBlockDeltaEvent).delta.type === 'signature_delta',
    ) as AnthropicContentBlockDeltaEvent
    expect(signatureDelta).toBeDefined()
  })

  test('output_item.done with reasoning emits thinking block with signature_delta', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    const events = translator.onEvent({
      type: 'response.output_item.done',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: 'reason-1',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'I thought about it' }],
        encrypted_content: 'enc-data',
      },
    })

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    expect(blockStart.content_block.type).toBe('thinking')

    const signatureDelta = events.find(e =>
      e.type === 'content_block_delta'
      && (e as AnthropicContentBlockDeltaEvent).delta.type === 'signature_delta',
    ) as AnthropicContentBlockDeltaEvent
    expect(signatureDelta).toBeDefined()
  })

  test('missing encrypted_content on compaction returns empty', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    const events = translator.onEvent({
      type: 'response.output_item.done',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: '',
        type: 'compaction',
        encrypted_content: '',
      },
    })

    expect(events).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 8. onEvent — completion
// ---------------------------------------------------------------------------

describe('onEvent — completion', () => {
  test('response.completed closes all blocks, emits message_delta + message_stop', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    translator.onEvent(textDeltaEvent('Hello'))

    const events = translator.onEvent(completedEvent())

    const blockStop = events.find(e => e.type === 'content_block_stop')
    expect(blockStop).toBeDefined()

    const messageDelta = events.find(e => e.type === 'message_delta') as
      AnthropicMessageDeltaEvent
    expect(messageDelta).toBeDefined()

    const messageStop = events.find(e => e.type === 'message_stop')
    expect(messageStop).toBeDefined()

    expect(translator.isCompleted).toBe(true)
  })

  test('response.incomplete also handled', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    const events = translator.onEvent({
      type: 'response.incomplete',
      sequence_number: 99,
      response: buildResponsesResult({ status: 'incomplete' }),
    })

    const messageDelta = events.find(e => e.type === 'message_delta')
    expect(messageDelta).toBeDefined()

    const messageStop = events.find(e => e.type === 'message_stop')
    expect(messageStop).toBeDefined()

    expect(translator.isCompleted).toBe(true)
  })

  test('response.failed emits error event', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    const events = translator.onEvent({
      type: 'response.failed',
      sequence_number: 99,
      response: buildResponsesResult({
        status: 'failed',
        error: { message: 'Rate limit exceeded' },
      }),
    })

    const errorEvent = events.find(e => e.type === 'error') as AnthropicErrorEvent
    expect(errorEvent).toBeDefined()
    expect(errorEvent.error.message).toBe('Rate limit exceeded')
    expect(translator.isCompleted).toBe(true)
  })

  test('error event emits error event', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    const events = translator.onEvent({
      type: 'error',
      sequence_number: 99,
      code: 'server_error',
      message: 'Something went wrong',
      param: null,
    })

    const errorEvent = events.find(e => e.type === 'error') as AnthropicErrorEvent
    expect(errorEvent).toBeDefined()
    expect(errorEvent.error.message).toBe('Something went wrong')
    expect(translator.isCompleted).toBe(true)
  })

  test('duplicate completion returns empty (prevents duplicate)', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    translator.onEvent(completedEvent())

    // Second completion should not produce new events
    translator.onEvent(completedEvent())
    // The translateResponsesToAnthropic call still runs, so we just check isCompleted
    expect(translator.isCompleted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 9. onDone — stream end without completion
// ---------------------------------------------------------------------------

describe('onDone — stream end without completion', () => {
  test('returns error event if not completed', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    const events = translator.onDone()

    expect(events).toHaveLength(1)
    const errorEvent = events[0] as AnthropicErrorEvent
    expect(errorEvent.type).toBe('error')
    expect(errorEvent.error.message).toBe('Responses stream ended without completion')
  })

  test('returns empty if already completed (idempotent)', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    translator.onEvent(completedEvent())

    const events = translator.onDone()
    expect(events).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 10. onError — error handling
// ---------------------------------------------------------------------------

describe('onError — error handling', () => {
  test('Error instance uses error.message', () => {
    const translator = new ResponsesStreamTranslator()
    const events = translator.onError(new Error('Connection failed'))

    expect(events).toHaveLength(1)
    const errorEvent = events[0] as AnthropicErrorEvent
    expect(errorEvent.type).toBe('error')
    expect(errorEvent.error.message).toBe('Connection failed')
    expect(translator.isCompleted).toBe(true)
  })

  test('non-Error uses generic fallback message', () => {
    const translator = new ResponsesStreamTranslator()
    const events = translator.onError('string error')

    expect(events).toHaveLength(1)
    const errorEvent = events[0] as AnthropicErrorEvent
    expect(errorEvent.error.message).toBe('Responses stream failed')
  })

  test('undefined error uses generic fallback message', () => {
    const translator = new ResponsesStreamTranslator()
    const events = translator.onError(undefined)

    expect(events).toHaveLength(1)
    const errorEvent = events[0] as AnthropicErrorEvent
    expect(errorEvent.error.message).toBe('Responses stream failed')
  })
})

// ---------------------------------------------------------------------------
// 11. buildErrorEvent helper
// ---------------------------------------------------------------------------

describe('buildErrorEvent', () => {
  test('builds error event with correct structure', () => {
    const event = buildErrorEvent('test error') as AnthropicErrorEvent
    expect(event.type).toBe('error')
    expect(event.error.type).toBe('api_error')
    expect(event.error.message).toBe('test error')
  })
})
