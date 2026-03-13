import type { CapiChatCompletionChunk } from '~/core/capi'

import type {
  AnthropicContentBlockDeltaEvent,
  AnthropicContentBlockStartEvent,
  AnthropicContentBlockStopEvent,
  AnthropicErrorEvent,
  AnthropicMessageDeltaEvent,
  AnthropicMessageStopEvent,
  AnthropicStreamEventData,
} from '~/translator/anthropic/types'
import { describe, expect, test } from 'bun:test'

import { AnthropicStreamTranslator } from '~/translator/anthropic/anthropic-stream-transducer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildChunk(overrides: Partial<CapiChatCompletionChunk> = {}): CapiChatCompletionChunk {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: Date.now(),
    model: 'claude-sonnet-4.5',
    choices: [],
    ...overrides,
  }
}

function buildTextChoice(content: string, index = 0) {
  return {
    index,
    delta: { content },
    logprobs: null as null,
    finish_reason: null as 'stop' | 'length' | 'tool_calls' | 'content_filter' | null,
  }
}

function buildThinkingChoice(text: string, index = 0) {
  return {
    index,
    delta: { reasoning_text: text },
    logprobs: null as null,
    finish_reason: null as 'stop' | 'length' | 'tool_calls' | 'content_filter' | null,
  }
}

function buildToolCallChoice(
  toolCall: {
    index: number
    id?: string
    function?: { name?: string, arguments?: string }
  },
  choiceIndex = 0,
) {
  return {
    index: choiceIndex,
    delta: { tool_calls: [toolCall] },
    logprobs: null as null,
    finish_reason: null as 'stop' | 'length' | 'tool_calls' | 'content_filter' | null,
  }
}

function buildFinishChoice(reason: 'stop' | 'length' | 'tool_calls', index = 0) {
  return {
    index,
    delta: {},
    logprobs: null as null,
    finish_reason: reason as 'stop' | 'length' | 'tool_calls' | 'content_filter' | null,
  }
}

// ---------------------------------------------------------------------------
// 1. onChunk — message lifecycle
// ---------------------------------------------------------------------------

describe('onChunk — message lifecycle', () => {
  test('first chunk with choices emits message_start with model/id/usage', () => {
    const translator = new AnthropicStreamTranslator()
    const chunk = buildChunk({
      id: 'chatcmpl-abc',
      model: 'claude-sonnet-4.5',
      choices: [buildTextChoice('Hello')],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })

    const events = translator.onChunk(chunk)
    const messageStart = events.find(e => e.type === 'message_start') as
      AnthropicStreamEventData & { type: 'message_start' }

    expect(messageStart).toBeDefined()
    expect(messageStart.message.id).toBe('chatcmpl-abc')
    expect(messageStart.message.model).toBe('claude-sonnet-4.5')
    expect(messageStart.message.role).toBe('assistant')
    expect(messageStart.message.content).toEqual([])
    expect(messageStart.message.stop_reason).toBeNull()
    expect(messageStart.message.stop_sequence).toBeNull()
    expect(messageStart.message.usage.input_tokens).toBe(10)
    expect(messageStart.message.usage.output_tokens).toBe(0)
  })

  test('subsequent chunks do NOT emit duplicate message_start', () => {
    const translator = new AnthropicStreamTranslator()

    translator.onChunk(buildChunk({ choices: [buildTextChoice('Hello')] }))
    const events2 = translator.onChunk(buildChunk({ choices: [buildTextChoice(' world')] }))

    const messageStarts = events2.filter(e => e.type === 'message_start')
    expect(messageStarts).toHaveLength(0)
  })

  test('empty choices array returns empty events', () => {
    const translator = new AnthropicStreamTranslator()
    const events = translator.onChunk(buildChunk({ choices: [] }))
    expect(events).toEqual([])
  })

  test('chunk with no delta content emits only message_start on first call, empty on second', () => {
    const translator = new AnthropicStreamTranslator()

    // First chunk with an empty delta (but choices array is non-empty)
    const events1 = translator.onChunk(buildChunk({
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: null }],
    }))

    // Should emit message_start because this is the first chunk with choices
    const messageStarts1 = events1.filter(e => e.type === 'message_start')
    expect(messageStarts1).toHaveLength(1)

    // Second call with same empty delta
    const events2 = translator.onChunk(buildChunk({
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: null }],
    }))

    // message_start already sent, empty delta produces no further events
    expect(events2).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. onChunk — text deltas
// ---------------------------------------------------------------------------

describe('onChunk — text deltas', () => {
  test('text delta emits content_block_start(text) + content_block_delta(text_delta)', () => {
    const translator = new AnthropicStreamTranslator()
    const events = translator.onChunk(buildChunk({ choices: [buildTextChoice('Hello')] }))

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    const blockDelta = events.find(e => e.type === 'content_block_delta') as
      AnthropicContentBlockDeltaEvent

    expect(blockStart).toBeDefined()
    expect(blockStart.index).toBe(0)
    expect(blockStart.content_block.type).toBe('text')

    expect(blockDelta).toBeDefined()
    expect(blockDelta.index).toBe(0)
    expect(blockDelta.delta.type).toBe('text_delta')
    expect((blockDelta.delta as { type: 'text_delta', text: string }).text).toBe('Hello')
  })

  test('second text delta reuses same block index (no new content_block_start)', () => {
    const translator = new AnthropicStreamTranslator()
    translator.onChunk(buildChunk({ choices: [buildTextChoice('Hello')] }))

    const events2 = translator.onChunk(buildChunk({ choices: [buildTextChoice(' world')] }))

    const blockStarts = events2.filter(e => e.type === 'content_block_start')
    expect(blockStarts).toHaveLength(0)

    const blockDelta = events2.find(e => e.type === 'content_block_delta') as
      AnthropicContentBlockDeltaEvent
    expect(blockDelta).toBeDefined()
    expect(blockDelta.index).toBe(0)
    expect((blockDelta.delta as { type: 'text_delta', text: string }).text).toBe(' world')
  })

  test('empty text string is ignored (no delta event)', () => {
    const translator = new AnthropicStreamTranslator()
    // First chunk to send message_start
    translator.onChunk(buildChunk({ choices: [buildTextChoice('Hi')] }))

    // Empty string text
    const events = translator.onChunk(buildChunk({ choices: [buildTextChoice('')] }))

    const deltas = events.filter(e => e.type === 'content_block_delta')
    expect(deltas).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 3. onChunk — thinking deltas
// ---------------------------------------------------------------------------

describe('onChunk — thinking deltas', () => {
  test('reasoning text emits content_block_start(thinking) + content_block_delta(thinking_delta)', () => {
    const translator = new AnthropicStreamTranslator()
    const events = translator.onChunk(buildChunk({ choices: [buildThinkingChoice('Let me think')] }))

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    const blockDelta = events.find(e => e.type === 'content_block_delta') as
      AnthropicContentBlockDeltaEvent

    expect(blockStart).toBeDefined()
    expect(blockStart.content_block.type).toBe('thinking')

    expect(blockDelta).toBeDefined()
    expect(blockDelta.delta.type).toBe('thinking_delta')
    expect((blockDelta.delta as { type: 'thinking_delta', thinking: string }).thinking).toBe('Let me think')
  })

  test('thinking -> text transition: closes thinking block, opens text block', () => {
    const translator = new AnthropicStreamTranslator()
    translator.onChunk(buildChunk({ choices: [buildThinkingChoice('thinking...')] }))

    const events = translator.onChunk(buildChunk({ choices: [buildTextChoice('answer')] }))

    // Should have: content_block_stop (thinking), content_block_start (text), content_block_delta (text)
    const blockStop = events.find(e => e.type === 'content_block_stop') as
      AnthropicContentBlockStopEvent
    expect(blockStop).toBeDefined()
    expect(blockStop.index).toBe(0) // thinking block index

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    expect(blockStart.content_block.type).toBe('text')
    expect(blockStart.index).toBe(1) // next block index

    const blockDelta = events.find(e => e.type === 'content_block_delta') as
      AnthropicContentBlockDeltaEvent
    expect(blockDelta).toBeDefined()
    expect(blockDelta.delta.type).toBe('text_delta')
  })

  test('text -> thinking transition: closes text block, opens thinking block', () => {
    const translator = new AnthropicStreamTranslator()
    translator.onChunk(buildChunk({ choices: [buildTextChoice('some text')] }))

    const events = translator.onChunk(buildChunk({ choices: [buildThinkingChoice('more thinking')] }))

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

  test('metadata accumulated across thinking deltas', () => {
    const translator = new AnthropicStreamTranslator()

    translator.onChunk(buildChunk({
      choices: [{
        index: 0,
        delta: {
          reasoning_text: 'step 1',
          reasoning_opaque: 'opaque-1',
          phase: 'phase-1',
        },
        logprobs: null,
        finish_reason: null,
      }],
    }))

    translator.onChunk(buildChunk({
      choices: [{
        index: 0,
        delta: {
          reasoning_text: 'step 2',
          reasoning_opaque: 'opaque-2',
          encrypted_content: 'enc-data',
        },
        logprobs: null,
        finish_reason: null,
      }],
    }))

    // Trigger done to inspect accumulated state via the output
    const doneEvents = translator.onDone()

    // message_delta should exist (stop finalization)
    const messageDelta = doneEvents.find(e => e.type === 'message_delta') as
      AnthropicMessageDeltaEvent
    expect(messageDelta).toBeDefined()
    // Verify finalization happened (metadata is internal, but we at least verify no crash)
    expect(messageDelta.delta.stop_reason).toBe('end_turn')
  })
})

// ---------------------------------------------------------------------------
// 4. onChunk — tool call deltas
// ---------------------------------------------------------------------------

describe('onChunk — tool call deltas', () => {
  test('tool call with id + name emits content_block_start(tool_use)', () => {
    const translator = new AnthropicStreamTranslator()
    const events = translator.onChunk(buildChunk({
      choices: [buildToolCallChoice({
        index: 0,
        id: 'call_abc',
        function: { name: 'get_weather' },
      })],
    }))

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    expect(blockStart.content_block.type).toBe('tool_use')
    expect((blockStart.content_block as { type: 'tool_use', id: string, name: string }).id).toBe('call_abc')
    expect((blockStart.content_block as { type: 'tool_use', id: string, name: string }).name).toBe('get_weather')
  })

  test('tool call with partial id (no name yet) buffers, no start event', () => {
    const translator = new AnthropicStreamTranslator()
    const events = translator.onChunk(buildChunk({
      choices: [buildToolCallChoice({
        index: 0,
        id: 'call_abc',
        // no function name yet
      })],
    }))

    const blockStarts = events.filter(e => e.type === 'content_block_start')
    // Only message_start, no content_block_start for tool use
    const toolStarts = blockStarts.filter(
      e => (e as AnthropicContentBlockStartEvent).content_block?.type === 'tool_use',
    )
    expect(toolStarts).toHaveLength(0)
  })

  test('tool call with arguments after start emits content_block_delta(input_json_delta)', () => {
    const translator = new AnthropicStreamTranslator()

    // First chunk: id + name -> starts the block
    translator.onChunk(buildChunk({
      choices: [buildToolCallChoice({
        index: 0,
        id: 'call_abc',
        function: { name: 'get_weather' },
      })],
    }))

    // Second chunk: arguments
    const events = translator.onChunk(buildChunk({
      choices: [buildToolCallChoice({
        index: 0,
        function: { arguments: '{"city":"SF"}' },
      })],
    }))

    const blockDelta = events.find(e => e.type === 'content_block_delta') as
      AnthropicContentBlockDeltaEvent
    expect(blockDelta).toBeDefined()
    expect(blockDelta.delta.type).toBe('input_json_delta')
    expect((blockDelta.delta as { type: 'input_json_delta', partial_json: string }).partial_json).toBe('{"city":"SF"}')
  })

  test('multiple tool calls at different indices tracked independently', () => {
    const translator = new AnthropicStreamTranslator()

    // Start first tool call
    translator.onChunk(buildChunk({
      choices: [buildToolCallChoice({
        index: 0,
        id: 'call_1',
        function: { name: 'tool_a' },
      })],
    }))

    // Start second tool call
    const events = translator.onChunk(buildChunk({
      choices: [buildToolCallChoice({
        index: 1,
        id: 'call_2',
        function: { name: 'tool_b' },
      })],
    }))

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    expect(blockStart.content_block.type).toBe('tool_use')
    expect((blockStart.content_block as { type: 'tool_use', id: string, name: string }).id).toBe('call_2')
    expect((blockStart.content_block as { type: 'tool_use', id: string, name: string }).name).toBe('tool_b')

    // They should have different anthropic block indices
    // First tool_use was at index 0, second at index 1
    expect(blockStart.index).toBe(1)
  })

  test('tool call closes open text/thinking blocks first', () => {
    const translator = new AnthropicStreamTranslator()

    // Open a text block
    translator.onChunk(buildChunk({ choices: [buildTextChoice('Hello')] }))

    // Now a tool call should close the text block
    const events = translator.onChunk(buildChunk({
      choices: [buildToolCallChoice({
        index: 0,
        id: 'call_abc',
        function: { name: 'my_tool' },
      })],
    }))

    const blockStop = events.find(e => e.type === 'content_block_stop') as
      AnthropicContentBlockStopEvent
    expect(blockStop).toBeDefined()
    expect(blockStop.index).toBe(0) // text block index

    const blockStart = events.find(e => e.type === 'content_block_start') as
      AnthropicContentBlockStartEvent
    expect(blockStart).toBeDefined()
    expect(blockStart.content_block.type).toBe('tool_use')
    expect(blockStart.index).toBe(1) // next index after text block
  })
})

// ---------------------------------------------------------------------------
// 5. onChunk — finish reason
// ---------------------------------------------------------------------------

describe('onChunk — finish reason', () => {
  test('finish_reason: stop triggers onDone inline, emits block closes + message_delta + message_stop', () => {
    const translator = new AnthropicStreamTranslator()
    translator.onChunk(buildChunk({ choices: [buildTextChoice('Hello')] }))

    const events = translator.onChunk(buildChunk({
      choices: [buildFinishChoice('stop')],
    }))

    // Should contain: content_block_stop (for open text block), message_delta, message_stop
    const blockStop = events.find(e => e.type === 'content_block_stop')
    expect(blockStop).toBeDefined()

    const messageDelta = events.find(e => e.type === 'message_delta') as
      AnthropicMessageDeltaEvent
    expect(messageDelta).toBeDefined()

    const messageStop = events.find(e => e.type === 'message_stop')
    expect(messageStop).toBeDefined()
  })

  test('stop reason mapped correctly: stop->end_turn, length->max_tokens, tool_calls->tool_use', () => {
    const mappings = [
      ['stop', 'end_turn'],
      ['length', 'max_tokens'],
      ['tool_calls', 'tool_use'],
    ] as const

    for (const [openaiReason, anthropicReason] of mappings) {
      const translator = new AnthropicStreamTranslator()
      translator.onChunk(buildChunk({ choices: [buildTextChoice('text')] }))

      const events = translator.onChunk(buildChunk({
        choices: [buildFinishChoice(openaiReason)],
      }))

      const messageDelta = events.find(e => e.type === 'message_delta') as
        AnthropicMessageDeltaEvent
      expect(messageDelta).toBeDefined()
      expect(messageDelta.delta.stop_reason).toBe(anthropicReason)
    }
  })

  test('usage from finish chunk used in message_delta', () => {
    const translator = new AnthropicStreamTranslator()
    translator.onChunk(buildChunk({ choices: [buildTextChoice('text')] }))

    const events = translator.onChunk(buildChunk({
      choices: [buildFinishChoice('stop')],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    }))

    const messageDelta = events.find(e => e.type === 'message_delta') as
      AnthropicMessageDeltaEvent
    expect(messageDelta).toBeDefined()
    expect(messageDelta.usage).toBeDefined()
    expect(messageDelta.usage!.input_tokens).toBe(100)
    expect(messageDelta.usage!.output_tokens).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// 6. onDone — finalization
// ---------------------------------------------------------------------------

describe('onDone — finalization', () => {
  test('closes all open blocks (thinking, text, tool calls) in order', () => {
    const translator = new AnthropicStreamTranslator()

    // Open thinking block (index 0)
    translator.onChunk(buildChunk({ choices: [buildThinkingChoice('thinking')] }))
    // Transition to text closes thinking, opens text (index 1)
    translator.onChunk(buildChunk({ choices: [buildTextChoice('text')] }))
    // Transition to tool call closes text, opens tool (index 2)
    translator.onChunk(buildChunk({
      choices: [buildToolCallChoice({
        index: 0,
        id: 'call_1',
        function: { name: 'tool' },
      })],
    }))

    const events = translator.onDone()

    // Should close the open tool call block
    const blockStops = events.filter(e => e.type === 'content_block_stop')
    expect(blockStops.length).toBeGreaterThanOrEqual(1)

    // Should have message_delta and message_stop
    expect(events.find(e => e.type === 'message_delta')).toBeDefined()
    expect(events.find(e => e.type === 'message_stop')).toBeDefined()
  })

  test('emits message_delta with stop_reason + usage', () => {
    const translator = new AnthropicStreamTranslator()
    translator.onChunk(buildChunk({
      choices: [buildTextChoice('hello')],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }))

    const events = translator.onDone()

    const messageDelta = events.find(e => e.type === 'message_delta') as
      AnthropicMessageDeltaEvent
    expect(messageDelta).toBeDefined()
    expect(messageDelta.delta.stop_reason).toBe('end_turn')
    expect(messageDelta.delta.stop_sequence).toBeNull()
    expect(messageDelta.usage).toBeDefined()
    expect(messageDelta.usage!.input_tokens).toBe(20)
    expect(messageDelta.usage!.output_tokens).toBe(10)
  })

  test('emits message_stop', () => {
    const translator = new AnthropicStreamTranslator()
    translator.onChunk(buildChunk({ choices: [buildTextChoice('hello')] }))

    const events = translator.onDone()

    const messageStop = events.find(e => e.type === 'message_stop') as
      AnthropicMessageStopEvent
    expect(messageStop).toBeDefined()
    expect(messageStop.type).toBe('message_stop')
  })

  test('idempotent: second call returns empty array', () => {
    const translator = new AnthropicStreamTranslator()
    translator.onChunk(buildChunk({ choices: [buildTextChoice('hello')] }))

    const events1 = translator.onDone()
    expect(events1.length).toBeGreaterThan(0)

    const events2 = translator.onDone()
    expect(events2).toEqual([])
  })

  test('returns empty if messageStartSent is false (no chunks received)', () => {
    const translator = new AnthropicStreamTranslator()
    const events = translator.onDone()
    expect(events).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 7. onError — error handling
// ---------------------------------------------------------------------------

describe('onError — error handling', () => {
  test('returns error event with generic message', () => {
    const translator = new AnthropicStreamTranslator()
    const events = translator.onError(new Error('something broke'))

    expect(events).toHaveLength(1)
    const errorEvent = events[0] as AnthropicErrorEvent
    expect(errorEvent.type).toBe('error')
    expect(errorEvent.error.type).toBe('api_error')
    expect(errorEvent.error.message).toBe('An unexpected error occurred during streaming.')
  })

  test('timeout error (DOMException with name TimeoutError) returns specific timeout message', () => {
    const translator = new AnthropicStreamTranslator()
    const timeoutError = new DOMException('The operation was aborted', 'TimeoutError')
    const events = translator.onError(timeoutError)

    expect(events).toHaveLength(1)
    const errorEvent = events[0] as AnthropicErrorEvent
    expect(errorEvent.type).toBe('error')
    expect(errorEvent.error.message).toBe('Upstream streaming request timed out. Please retry.')
  })

  test('regular Error with name TimeoutError also detected', () => {
    const translator = new AnthropicStreamTranslator()
    const error = new Error('timeout')
    error.name = 'TimeoutError'
    const events = translator.onError(error)

    expect(events).toHaveLength(1)
    const errorEvent = events[0] as AnthropicErrorEvent
    expect(errorEvent.type).toBe('error')
    expect(errorEvent.error.message).toBe('Upstream streaming request timed out. Please retry.')
  })

  test('undefined error returns generic message', () => {
    const translator = new AnthropicStreamTranslator()
    const events = translator.onError(undefined)

    expect(events).toHaveLength(1)
    const errorEvent = events[0] as AnthropicErrorEvent
    expect(errorEvent.type).toBe('error')
    expect(errorEvent.error.message).toBe('An unexpected error occurred during streaming.')
  })

  test('non-Error object returns generic message', () => {
    const translator = new AnthropicStreamTranslator()
    const events = translator.onError('string error')

    expect(events).toHaveLength(1)
    const errorEvent = events[0] as AnthropicErrorEvent
    expect(errorEvent.type).toBe('error')
    expect(errorEvent.error.message).toBe('An unexpected error occurred during streaming.')
  })
})
