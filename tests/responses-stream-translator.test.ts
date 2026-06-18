import type { ServerSentEventMessage } from 'fetch-event-stream'
import type {
  AnthropicContentBlockDeltaEvent,
  AnthropicContentBlockStartEvent,
  AnthropicContentBlockStopEvent,
  AnthropicErrorEvent,
  AnthropicMessageDeltaEvent,
  AnthropicMessageStartEvent,
} from '~/translator/anthropic/types'
import type {
  ResponseOutputItem,
  ResponsesResult,
  ResponseStreamEvent,
} from '~/types'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { getCachedConfig } from '~/lib/config'
import { authStore, modelCache } from '~/state'
import { normalizeFunctionParametersSchemaForCopilot } from '~/translator/responses/function-schema'
import { buildErrorEvent, ResponsesStreamTranslator } from '~/translator/responses/responses-stream-translator'

import {
  buildModel,
  buildModelsResponse,
  buildResponsesResult as buildRouteResponsesResult,
  createApp,
  mockResponses,
  parseSse,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

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
    expect(errorEvent.error.type).toBe('api_error')
    expect(errorEvent.error.message).toContain('whitespace')
    expect(events.at(-1)).toBe(errorEvent)
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

  test('second response.completed re-runs (no duplicate-completion guard in onEvent)', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())
    translator.onEvent(completedEvent())

    // onEvent('response.completed') has no isCompleted guard (unlike onDone),
    // so a second completion re-runs handleResponseCompleted and re-emits the
    // terminal message_delta + message_stop pair. All blocks are already
    // closed, so no content_block_stop is produced this time.
    const secondEvents = translator.onEvent(completedEvent())

    expect(secondEvents).toHaveLength(2)
    expect(secondEvents.some(e => e.type === 'content_block_stop')).toBe(false)
    expect(secondEvents.find(e => e.type === 'message_delta')).toBeDefined()
    expect(secondEvents.at(-1)).toMatchObject({ type: 'message_stop' })
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
// 11. Bug fix: output_item.done after arguments.done must not throw
// ---------------------------------------------------------------------------

describe('function_call output_item.done after arguments.done', () => {
  test('does not throw when output_item.done arrives after arguments.done has closed the block', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    // Step 1: output_item.added opens the function call block
    translator.onEvent({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '',
      },
    })

    // Step 2: arguments delta
    translator.onEvent({
      type: 'response.function_call_arguments.delta',
      sequence_number: 2,
      output_index: 0,
      item_id: 'call_1',
      delta: '{"city":"Paris"}',
    })

    // Step 3: arguments.done closes the block
    translator.onEvent({
      type: 'response.function_call_arguments.done',
      sequence_number: 3,
      output_index: 0,
      item_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
    })

    // Step 4: output_item.done arrives — this should NOT throw
    expect(() => {
      translator.onEvent({
        type: 'response.output_item.done',
        sequence_number: 4,
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'get_weather',
          arguments: '{"city":"Paris"}',
          status: 'completed',
        },
      })
    }).not.toThrow()
  })

  test('does not duplicate content_block_stop when output_item.done follows arguments.done', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent(createdEvent())

    translator.onEvent({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '',
      },
    })

    translator.onEvent({
      type: 'response.function_call_arguments.done',
      sequence_number: 2,
      output_index: 0,
      item_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
    })

    // output_item.done after close — should produce no new content block events
    const events = translator.onEvent({
      type: 'response.output_item.done',
      sequence_number: 3,
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"Paris"}',
        status: 'completed',
      },
    })

    const blockStops = events.filter(e => e.type === 'content_block_stop')
    const blockStarts = events.filter(e => e.type === 'content_block_start')
    expect(blockStops).toHaveLength(0)
    expect(blockStarts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 12. buildErrorEvent helper
// ---------------------------------------------------------------------------

describe('buildErrorEvent', () => {
  test('builds error event with correct structure', () => {
    const event = buildErrorEvent('test error') as AnthropicErrorEvent
    expect(event.type).toBe('error')
    expect(event.error.type).toBe('api_error')
    expect(event.error.message).toBe('test error')
  })
})

// ---------------------------------------------------------------------------
// normalizeFunctionParametersSchemaForCopilot (moved from function-schema.test.ts)
// ---------------------------------------------------------------------------

describe('normalizeFunctionParametersSchemaForCopilot', () => {
  test('normalizes plugin and MCP-style object schemas for Copilot Responses validation', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      title: 'nowledge_mem_search arguments',
      properties: {
        query: {
          type: 'string',
          format: 'uri',
          examples: ['https://example.com'],
        },
        options: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              default: 10,
            },
            tags: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  value: {
                    type: 'string',
                    format: 'uri',
                  },
                },
              },
            },
          },
        },
      },
    }

    expect(normalizeFunctionParametersSchemaForCopilot(schema)).toEqual({
      type: 'object',
      properties: {
        query: {
          type: 'string',
        },
        options: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
            },
            tags: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  value: {
                    type: 'string',
                  },
                },
                required: ['value'],
                additionalProperties: false,
              },
            },
          },
          required: ['limit', 'tags'],
          additionalProperties: false,
        },
      },
      required: ['query', 'options'],
      additionalProperties: false,
    })
  })

  test('passes through nullish schemas unchanged', () => {
    expect(normalizeFunctionParametersSchemaForCopilot(undefined)).toBeUndefined()
    expect(normalizeFunctionParametersSchemaForCopilot(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Route-integration: responses stream id normalization
// (moved verbatim from responses-stream-id-normalization.test.ts)
// ---------------------------------------------------------------------------

interface StreamJsonEvent {
  event: string
  data: Record<string, unknown>
}

function createSseStream(
  chunks: Array<ServerSentEventMessage>,
): AsyncGenerator<ServerSentEventMessage, void, unknown> {
  return (async function* () {
    for (const chunk of chunks) {
      yield chunk
    }
  })()
}

function jsonChunk(event: string, data: unknown): ServerSentEventMessage {
  return {
    event,
    data: JSON.stringify(data),
  }
}

function responseLifecycleChunk(
  type: 'response.created' | 'response.completed' | 'response.incomplete' | 'response.failed',
  sequenceNumber: number,
  overrides: Record<string, unknown> = {},
): ServerSentEventMessage {
  let status: 'in_progress' | 'completed' | 'incomplete' | 'failed' = 'failed'
  if (type === 'response.created') {
    status = 'in_progress'
  }
  else if (type === 'response.completed') {
    status = 'completed'
  }
  else if (type === 'response.incomplete') {
    status = 'incomplete'
  }

  return jsonChunk(type, {
    type,
    sequence_number: sequenceNumber,
    response: buildRouteResponsesResult({
      status,
      ...overrides,
    }),
  } satisfies ResponseStreamEvent)
}

function outputItemChunk(
  type: 'response.output_item.added' | 'response.output_item.done',
  sequenceNumber: number,
  outputIndex: number,
  item: ResponseOutputItem,
): ServerSentEventMessage {
  return jsonChunk(type, {
    type,
    sequence_number: sequenceNumber,
    output_index: outputIndex,
    item,
  } satisfies ResponseStreamEvent)
}

async function collectResponsesStream(chunks: Array<ServerSentEventMessage>): Promise<Array<StreamJsonEvent>> {
  const app = createApp('responses')
  modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5.4', { supported_endpoints: ['/responses'] })))

  CopilotClient.prototype.createResponses = mockResponses(createSseStream(chunks), [])

  const response = await app.handle(new Request('http://localhost/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      stream: true,
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    }),
  }))

  expect(response.status).toBe(200)

  return parseSse(await response.text())
    .filter(event => event.event && event.data)
    .map(event => ({
      event: event.event as string,
      data: JSON.parse(event.data as string) as Record<string, unknown>,
    }))
}

describe('responses stream id normalization', () => {
  const originalCreateResponses = CopilotClient.prototype.createResponses
  const stateSnapshot = saveStateSnapshot()
  const originalConfig = structuredClone(getCachedConfig())

  beforeEach(() => {
    setupDefaultTestState()
    authStore.showToken = false
    authStore.upstreamTimeoutSeconds = undefined

    const config = getCachedConfig()
    for (const key of Object.keys(config)) {
      delete (config as Record<string, unknown>)[key]
    }
  })

  afterEach(() => {
    CopilotClient.prototype.createResponses = originalCreateResponses
    restoreStateSnapshot(stateSnapshot)

    const config = getCachedConfig()
    for (const key of Object.keys(config)) {
      delete (config as Record<string, unknown>)[key]
    }
    Object.assign(config, structuredClone(originalConfig))
  })

  test('normalizes item_id-bearing child events independently per output index', async () => {
    const events = await collectResponsesStream([
      responseLifecycleChunk('response.created', 1, { id: 'resp_stable' }),
      outputItemChunk('response.output_item.added', 2, 0, {
        id: 'msg_item_0',
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      }),
      outputItemChunk('response.output_item.added', 3, 1, {
        id: 'reasoning_item_1',
        type: 'reasoning',
        status: 'in_progress',
        summary: [],
      }),
      jsonChunk('response.content_part.added', {
        type: 'response.content_part.added',
        sequence_number: 4,
        output_index: 0,
        content_index: 0,
        item_id: 'content_part_upstream',
        part: {
          type: 'output_text',
          text: '',
        },
      } satisfies ResponseStreamEvent),
      jsonChunk('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added',
        sequence_number: 5,
        output_index: 1,
        summary_index: 0,
        item_id: 'reasoning_part_upstream',
        part: {
          type: 'summary_text',
          text: '',
        },
      } satisfies ResponseStreamEvent),
      jsonChunk('response.some_future_event', {
        type: 'response.some_future_event',
        sequence_number: 6,
        output_index: 1,
        item_id: 'future_upstream',
        metadata: { source: 'test' },
      }),
      jsonChunk('response.content_part.done', {
        type: 'response.content_part.done',
        sequence_number: 7,
        output_index: 0,
        content_index: 0,
        item_id: 'content_done_upstream',
        part: {
          type: 'output_text',
          text: 'done',
        },
      } satisfies ResponseStreamEvent),
      responseLifecycleChunk('response.completed', 8, { id: 'resp_completed_upstream' }),
    ])

    const contentPartAdded = events.find(event => event.event === 'response.content_part.added')
    expect(contentPartAdded?.data.item_id).toBe('msg_item_0')

    const contentPartDone = events.find(event => event.event === 'response.content_part.done')
    expect(contentPartDone?.data.item_id).toBe('msg_item_0')

    const reasoningPartAdded = events.find(event => event.event === 'response.reasoning_summary_part.added')
    expect(reasoningPartAdded?.data.item_id).toBe('reasoning_item_1')

    const futureEvent = events.find(event => event.event === 'response.some_future_event')
    expect(futureEvent?.data.item_id).toBe('reasoning_item_1')

    const completed = events.find(event => event.event === 'response.completed')
    expect((completed?.data.response as Record<string, unknown> | undefined)?.id).toBe('resp_stable')
  })

  test('seeds the stable id from output_item.done when added is missing', async () => {
    const events = await collectResponsesStream([
      responseLifecycleChunk('response.created', 1, { id: 'resp_stable' }),
      outputItemChunk('response.output_item.done', 2, 0, {
        id: 'seed_from_done',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [],
      }),
      jsonChunk('response.output_text.delta', {
        type: 'response.output_text.delta',
        sequence_number: 3,
        output_index: 0,
        content_index: 0,
        item_id: 'late_upstream_child',
        delta: 'hello',
      } satisfies ResponseStreamEvent),
    ])

    const outputItemDone = events.find(event => event.event === 'response.output_item.done')
    expect((outputItemDone?.data.item as Record<string, unknown> | undefined)?.id).toBe('seed_from_done')

    const outputTextDelta = events.find(event => event.event === 'response.output_text.delta')
    expect(outputTextDelta?.data.item_id).toBe('seed_from_done')
  })

  test('does not rewrite child item ids before a stable output item id exists', async () => {
    const events = await collectResponsesStream([
      responseLifecycleChunk('response.created', 1, { id: 'resp_stable' }),
      jsonChunk('response.some_future_event', {
        type: 'response.some_future_event',
        sequence_number: 2,
        output_index: 0,
        item_id: 'upstream_before_seed',
      }),
      outputItemChunk('response.output_item.added', 3, 0, {
        id: 'stable_afterwards',
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      }),
    ])

    const futureEvent = events.find(event => event.event === 'response.some_future_event')
    expect(futureEvent?.data.item_id).toBe('upstream_before_seed')
  })

  test('stabilizes response ids on incomplete lifecycle events', async () => {
    const events = await collectResponsesStream([
      responseLifecycleChunk('response.created', 1, { id: 'resp_stable' }),
      responseLifecycleChunk('response.incomplete', 2, { id: 'resp_incomplete_upstream' }),
    ])

    const incomplete = events.find(event => event.event === 'response.incomplete')
    expect((incomplete?.data.response as Record<string, unknown> | undefined)?.id).toBe('resp_stable')
  })

  test('stabilizes response ids on failed lifecycle events', async () => {
    const events = await collectResponsesStream([
      responseLifecycleChunk('response.created', 1, { id: 'resp_stable' }),
      responseLifecycleChunk('response.failed', 2, {
        id: 'resp_failed_upstream',
        error: {
          message: 'boom',
        },
      }),
    ])

    const failed = events.find(event => event.event === 'response.failed')
    expect((failed?.data.response as Record<string, unknown> | undefined)?.id).toBe('resp_stable')
  })

  test('passes malformed json chunks through unchanged', async () => {
    const app = createApp('responses')
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5.4', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(createSseStream([
      responseLifecycleChunk('response.created', 1, { id: 'resp_stable' }),
      {
        event: 'response.output_text.delta',
        data: '{not-json}',
      },
    ]), [])

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        stream: true,
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)

    const body = await response.text()
    expect(body).toContain('event: response.output_text.delta')
    expect(body).toContain('data: {not-json}')
  })
})
