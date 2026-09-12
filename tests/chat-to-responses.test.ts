import type { ResponsesChatTool } from '~/translator/responses/chat-bridge-types'
import type { ResponsesPayload, ResponseStreamEvent } from '~/types'
import { describe, expect, test } from 'bun:test'

import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import {
  ChatToResponsesStreamTranslator,
  translateChatToResponses,
} from '~/translator/responses/chat-to-responses'

function payload(overrides: Partial<ResponsesPayload> = {}): ResponsesPayload {
  return {
    model: 'chat-only',
    input: 'hello',
    ...overrides,
  }
}

function streamChunk(
  delta: Record<string, unknown>,
  options: {
    finish_reason?: string | null
    index?: number
    usage?: Record<string, unknown>
  } = {},
) {
  return {
    id: 'chatcmpl_upstream',
    object: 'chat.completion.chunk',
    created: 100,
    model: 'chat-only',
    choices: [{
      index: options.index ?? 0,
      delta,
      finish_reason: options.finish_reason ?? null,
      logprobs: null,
    }],
    ...(options.usage ? { usage: options.usage } : {}),
  }
}

function usage() {
  return {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
    prompt_tokens_details: { cached_tokens: 3 },
  }
}

function parseEvents(outputs: Array<{ data: string }>): Array<ResponseStreamEvent> {
  return outputs.map(output => JSON.parse(output.data) as ResponseStreamEvent)
}

describe('Chat to Responses translation', () => {
  test('translates fragmented parallel function and custom calls with stable IDs', () => {
    const tools = new Map<string, ResponsesChatTool>([
      ['internal_weather', { type: 'function', name: 'weather', namespace: 'tools' }],
      ['internal_patch', { type: 'custom', name: 'apply_patch', namespace: 'codex' }],
    ])
    const translator = new ChatToResponsesStreamTranslator(payload({ max_output_tokens: 100 }), tools)

    const outputs = translator.onChunk(streamChunk({
      role: 'assistant',
      tool_calls: [
        { index: 0, id: 'upstream-weather', function: { name: 'internal_weather', arguments: '{"city": ' } },
        { index: 1, function: { arguments: '{"input":"line\\n' } },
      ],
    }))
    outputs.push(...translator.onChunk(streamChunk({
      tool_calls: [
        { index: 0, function: { arguments: '"Paris"}   ' } },
        { index: 1, id: 'upstream-patch', function: { name: 'internal_patch', arguments: ' one\\"two"}' } },
      ],
    })))
    outputs.push(...translator.onChunk(streamChunk({}, {
      finish_reason: 'tool_calls',
      usage: usage(),
    })))

    outputs.push(...translator.onDone())
    const events = parseEvents(outputs)
    const terminal = events.find(event => event.type === 'response.completed')
    expect(terminal?.type).toBe('response.completed')
    if (!terminal || terminal.type !== 'response.completed')
      throw new Error('expected response.completed')

    expect(terminal.response.id).toMatch(/^resp_/)
    expect(terminal.response.status).toBe('completed')
    expect(events.slice(0, 2).map(event => event.type)).toEqual([
      'response.created',
      'response.in_progress',
    ])
    expect(terminal.response.usage).toEqual({
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 3 },
    })
    expect(terminal.response.output).toHaveLength(2)
    expect(terminal.response.output[0]).toMatchObject({
      type: 'function_call',
      call_id: 'upstream-weather',
      name: 'weather',
      namespace: 'tools',
      arguments: '{"city": "Paris"}   ',
    })
    expect(terminal.response.output[0]?.id).toMatch(/^fc_/)
    expect(terminal.response.output[1]).toMatchObject({
      type: 'custom_tool_call',
      call_id: 'upstream-patch',
      name: 'apply_patch',
      namespace: 'codex',
      input: 'line\n one"two',
    })
    expect(terminal.response.output[1]?.id).toMatch(/^ctc_/)
    expect(JSON.stringify(terminal.response)).not.toContain('internal_patch')

    const sequenceNumbers = events.map(event => event.sequence_number)
    expect(sequenceNumbers).toEqual(sequenceNumbers.toSorted((a, b) => a - b))
    expect(new Set(sequenceNumbers).size).toBe(sequenceNumbers.length)
  })

  test('maps text and refusal without inventing opaque reasoning state', () => {
    const issues: Array<string> = []
    const result = translateChatToResponses({
      id: 'chatcmpl_1',
      object: 'chat.completion',
      created: 100,
      model: 'chat-only',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content: 'answer',
          reasoning_text: 'thinking',
          reasoning_opaque: 'private-provider-state',
          encrypted_content: 'unverified-provider-encoding',
          refusal: 'nope',
        },
      }],
    }, payload(), new Map(), {
      onTranslationIssue: (issue) => { issues.push(issue.kind) },
    })

    expect(result.output_text).toBe('answer')
    expect(result.output).toEqual([{
      id: expect.stringMatching(/^msg_/),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        { type: 'output_text', text: 'answer', annotations: [] },
        { type: 'refusal', refusal: 'nope' },
      ],
    }])
    expect(result.output.some(item => item.type === 'reasoning')).toBe(false)
    expect(JSON.stringify(result)).not.toContain('private-provider-state')
    expect(issues).toEqual(['lossy_reasoning_omitted'])
  })

  test('streams refusal deltas and preserves a validated message phase', () => {
    const translator = new ChatToResponsesStreamTranslator(payload(), new Map())
    const outputs = translator.onChunk(streamChunk({
      phase: 'commentary',
      refusal: 'Cannot ',
    }))
    outputs.push(...translator.onChunk(streamChunk({ refusal: 'comply.' }, { finish_reason: 'stop' })))
    outputs.push(...translator.onDone())

    const events = parseEvents(outputs)
    const responseItemAdded = events.find(event => event.type === 'response.output_item.added')
    expect(responseItemAdded?.type).toBe('response.output_item.added')
    if (!responseItemAdded || responseItemAdded.type !== 'response.output_item.added')
      throw new Error('expected response.output_item.added')
    expect(responseItemAdded.item).toMatchObject({ type: 'message', phase: 'commentary' })

    const refusalDeltas = events.filter(event => event.type === 'response.refusal.delta')
    expect(refusalDeltas.map(event => event.delta)).toEqual(['Cannot ', 'comply.'])
    const refusalDone = events.find(event => event.type === 'response.refusal.done')
    expect(refusalDone).toMatchObject({ refusal: 'Cannot comply.' })
    expect(events.findIndex(event => event.type === 'response.refusal.done')).toBeLessThan(
      events.findIndex(event => event.type === 'response.content_part.done'),
    )

    const terminal = events.find(event => event.type === 'response.completed')
    expect(terminal?.type).toBe('response.completed')
    if (!terminal || terminal.type !== 'response.completed')
      throw new Error('expected response.completed')
    expect(terminal.response.output[0]).toMatchObject({ type: 'message', phase: 'commentary' })
  })

  test('treats nullable Chat output fields as absent while rejecting malformed values', () => {
    const translator = new ChatToResponsesStreamTranslator(payload(), new Map())
    translator.onChunk(streamChunk({ content: 'ok', tool_calls: null }, {
      finish_reason: 'stop',
      usage: {
        prompt_tokens: 11,
        completion_tokens: null,
        total_tokens: 11,
        prompt_tokens_details: null,
        completion_tokens_details: { reasoning_tokens: null },
      },
    }))
    translator.onDone()

    expect(translator.terminalResponse).toMatchObject({
      status: 'completed',
      usage: { input_tokens: 11, total_tokens: 11 },
    })
    expect(translator.terminalResponse?.usage?.output_tokens).toBeUndefined()

    const missingCounters = new ChatToResponsesStreamTranslator(payload(), new Map())
    missingCounters.onChunk(streamChunk({ content: 'ok' }, {
      finish_reason: 'stop',
      usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null },
    }))
    missingCounters.onDone()
    expect(missingCounters.terminalResponse).toMatchObject({ status: 'completed', usage: null })

    const retainedUsage = new ChatToResponsesStreamTranslator(payload(), new Map())
    retainedUsage.onChunk(streamChunk({ content: 'ok' }, { usage: usage() }))
    retainedUsage.onChunk(streamChunk({}, {
      finish_reason: 'stop',
      usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null },
    }))
    retainedUsage.onDone()
    expect(retainedUsage.terminalResponse?.usage).toEqual({
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 3 },
    })

    const malformed = new ChatToResponsesStreamTranslator(payload(), new Map())
    malformed.onChunk(streamChunk({ tool_calls: 42 }))
    expect(malformed.terminalResponse?.status).toBe('failed')
    expect(malformed.translationFailure?.kind).toBe('invalid_upstream_tool_calls')

    const malformedUsage = new ChatToResponsesStreamTranslator(payload(), new Map())
    malformedUsage.onChunk(streamChunk({ content: 'ok' }, {
      finish_reason: 'stop',
      usage: { prompt_tokens: 'eleven', completion_tokens: 0, total_tokens: 0 },
    }))
    expect(malformedUsage.terminalResponse?.status).toBe('failed')
    expect(malformedUsage.translationFailure?.kind).toBe('invalid_prompt_tokens')
  })

  test.each(['reasoning_text', 'reasoning_content', 'reasoning_opaque', 'encrypted_content'])('reports %s loss once after empty chunks', (field) => {
    const issues: Array<string> = []
    const translator = new ChatToResponsesStreamTranslator(payload(), new Map(), {
      onTranslationIssue: issue => issues.push(issue.kind),
    })
    translator.onChunk(streamChunk({ [field]: null }))
    translator.onChunk(streamChunk({ [field]: '' }))
    expect(issues).toEqual([])
    translator.onChunk(streamChunk({ [field]: 'provider-private-state' }))
    translator.onChunk(streamChunk({ [field]: 'later-private-state' }))
    translator.onChunk(streamChunk({}, { finish_reason: 'stop' }))
    translator.onDone()
    expect(issues).toEqual(['lossy_reasoning_omitted'])
    expect(translator.terminalResponse?.status).toBe('completed')
    expect(JSON.stringify(translator.terminalResponse)).not.toContain('private-state')
  })

  test('keeps missing usage as null and reports an EOF without finish as failed', () => {
    let eofCalls = 0
    let terminalCalls = 0
    const translator = new ChatToResponsesStreamTranslator(payload(), new Map(), {
      onStreamEndWithoutTerminal: () => { eofCalls++ },
      onTerminalResponse: () => { terminalCalls++ },
    })

    translator.onChunk(streamChunk({ content: 'partial' }))
    const events = parseEvents(translator.onDone())
    const terminal = events.at(-1)
    expect(terminal?.type).toBe('response.failed')
    if (!terminal || terminal.type !== 'response.failed')
      throw new Error('expected response.failed')
    expect(events.some(event => event.type === 'error')).toBe(true)
    expect(terminal.response.status).toBe('failed')
    expect(terminal.response.usage).toBeNull()
    expect(eofCalls).toBe(1)
    expect(terminalCalls).toBe(1)
    expect(translator.onDone()).toEqual([])
    expect(terminalCalls).toBe(1)
  })

  test('does not reject partial arguments for an incomplete length terminal', () => {
    const translator = new ChatToResponsesStreamTranslator(
      payload(),
      new Map([['weather', { type: 'function', name: 'weather' }]]),
    )
    translator.onChunk(streamChunk({
      tool_calls: [{ index: 0, id: 'call-weather', function: { name: 'weather', arguments: '{"city":' } }],
    }))
    translator.onChunk(streamChunk({}, { finish_reason: 'length' }))

    const events = parseEvents(translator.onDone())
    const terminal = events.at(-1)
    expect(terminal?.type).toBe('response.incomplete')
    if (!terminal || terminal.type !== 'response.incomplete')
      throw new Error('expected response.incomplete')
    expect(terminal.response.output[0]).toMatchObject({
      type: 'function_call',
      arguments: '{"city":',
      status: 'incomplete',
    })
    expect(events.some(event => event.type === 'response.output_item.done'
      && 'item' in event
      && event.item.type === 'function_call')).toBe(false)
  })

  test('buffers an incomplete custom wrapper without surfacing an executable done item', () => {
    const translator = new ChatToResponsesStreamTranslator(
      payload(),
      new Map([['patch', { type: 'custom', name: 'apply_patch', namespace: 'codex' }]]),
    )
    const outputs = translator.onChunk(streamChunk({
      tool_calls: [{ index: 0, id: 'call-patch', function: { name: 'patch', arguments: '{"input":"partial' } }],
    }))
    outputs.push(...translator.onChunk(streamChunk({}, { finish_reason: 'content_filter' })))
    outputs.push(...translator.onDone())

    const events = parseEvents(outputs)
    const terminal = events.at(-1)
    expect(terminal?.type).toBe('response.incomplete')
    expect(events.some(event => event.type === 'response.output_item.done'
      && 'item' in event
      && event.item.type === 'custom_tool_call')).toBe(false)
  })

  test('rejects malformed successful tool arguments as a 502 translation failure', () => {
    expect(() => translateChatToResponses({
      id: 'chatcmpl_bad',
      object: 'chat.completion',
      created: 100,
      model: 'chat-only',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-bad',
            type: 'function',
            function: { name: 'weather', arguments: '{bad' },
          }],
        },
      }],
    }, payload(), new Map([['weather', { type: 'function', name: 'weather' }]]))).toThrow(
      TranslationFailure,
    )
  })

  test('accepts standard non-streaming tool calls without a delta index', () => {
    const result = translateChatToResponses({
      id: 'chatcmpl_json_tool',
      object: 'chat.completion',
      created: 100,
      model: 'chat-only',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-json',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Paris"}' },
          }],
        },
      }],
    }, payload(), new Map([['weather', { type: 'function', name: 'weather' }]]))

    expect(result.status).toBe('completed')
    expect(result.output[0]).toMatchObject({
      type: 'function_call',
      name: 'weather',
      arguments: '{"city":"Paris"}',
    })
  })

  test('fails closed when the request forbids parallel or all tool calls', () => {
    const base = {
      id: 'chatcmpl_parallel_violation',
      object: 'chat.completion',
      created: 100,
      model: 'chat-only',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call-a', type: 'function', function: { name: 'a', arguments: '{}' } },
            { id: 'call-b', type: 'function', function: { name: 'b', arguments: '{}' } },
          ],
        },
      }],
    }
    const tools = new Map([
      ['a', { type: 'function' as const, name: 'a' }],
      ['b', { type: 'function' as const, name: 'b' }],
    ])

    expect(() => translateChatToResponses(base, payload({ parallel_tool_calls: false }), tools))
      .toThrow(TranslationFailure)
    expect(() => translateChatToResponses({
      ...base,
      choices: [{
        ...base.choices[0],
        message: { ...base.choices[0].message, tool_calls: [base.choices[0].message.tool_calls[0]] },
      }],
    }, payload({ tool_choice: 'none' }), tools)).toThrow(TranslationFailure)
  })

  test('rejects unexpected tool calls when no translated tools exist', () => {
    expect(() => translateChatToResponses({
      id: 'chatcmpl_unknown',
      object: 'chat.completion',
      created: 100,
      model: 'chat-only',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-unknown',
            type: 'function',
            function: { name: 'unknown', arguments: '{}' },
          }],
        },
      }],
    }, payload(), new Map())).toThrow(TranslationFailure)
  })

  test('rejects duplicate upstream call IDs instead of synthesizing ambiguous tool history', () => {
    const tools = new Map<string, ResponsesChatTool>([['lookup', { type: 'function', name: 'lookup' }]])
    expect(() => translateChatToResponses({
      id: 'chat_duplicate',
      object: 'chat.completion',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'duplicate', type: 'function', function: { name: 'lookup', arguments: '{}' } },
            { id: 'duplicate', type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
        },
      }],
    }, payload(), tools)).toThrow('duplicate tool call IDs')
  })

  test('does not publish executable tools for a length-limited turn even when arguments parse', () => {
    const tools = new Map<string, ResponsesChatTool>([['lookup', { type: 'function', name: 'lookup' }]])
    const translator = new ChatToResponsesStreamTranslator(payload(), tools)
    const outputs = translator.onChunk(streamChunk({
      tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{}' } }],
    }))
    outputs.push(...translator.onChunk(streamChunk({}, { finish_reason: 'length' })))
    outputs.push(...translator.onDone())
    const events = parseEvents(outputs)
    expect(events.filter(event => event.type === 'response.output_item.done')).toHaveLength(0)
    expect(events.at(-1)?.type).toBe('response.incomplete')
  })

  test('preserves the created lifecycle when a first chunk fails after envelope parsing', () => {
    let terminalCalls = 0
    const translator = new ChatToResponsesStreamTranslator(payload(), new Map(), {
      onTerminalResponse: () => { terminalCalls++ },
    })
    const events = parseEvents(translator.onChunk(streamChunk({ content: 17 })))
    expect(events.map(event => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'error',
      'response.failed',
    ])
    expect(events.map(event => event.sequence_number)).toEqual([0, 1, 2, 3])
    expect(terminalCalls).toBe(1)
    expect(translator.onDone()).toEqual([])
  })

  test('emits a safe failed event for streaming errors', () => {
    const translator = new ChatToResponsesStreamTranslator(payload(), new Map())
    const events = parseEvents(translator.onError(new Error('secret upstream payload')))
    expect(events.map(event => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'error',
      'response.failed',
    ])
    expect(events.map(event => event.sequence_number)).toEqual([0, 1, 2, 3])
    const terminal = events.at(-1)
    expect(terminal?.type).toBe('response.failed')
    if (!terminal || terminal.type !== 'response.failed')
      throw new Error('expected response.failed')
    expect(terminal.response.error?.message).not.toContain('secret upstream payload')
  })

  const choices: Array<{
    label: string
    choice: NonNullable<ResponsesPayload['tool_choice']>
    toolName?: string
    custom?: boolean
  }> = [
    { label: 'forced function', choice: { type: 'function', name: 'a' }, toolName: 'b' },
    { label: 'forced custom', choice: { type: 'custom', name: 'a' }, toolName: 'b', custom: true },
    { label: 'allowed subset', choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'a' }] }, toolName: 'b' },
    { label: 'required', choice: 'required' },
    { label: 'required subset', choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'a' }] } },
    { label: 'missing forced call', choice: { type: 'function', name: 'a' } },
  ]
  test.each(choices)('rejects a completion violating $label tool choice', ({ choice, toolName, custom }) => {
    const tools = new Map<string, ResponsesChatTool>([
      ['a', { type: custom ? 'custom' : 'function', name: 'a' }],
      ['b', { type: custom ? 'custom' : 'function', name: 'b' }],
    ])
    const translator = new ChatToResponsesStreamTranslator(payload({ tool_choice: choice }), tools)
    const outputs = translator.onChunk(streamChunk(toolName
      ? { tool_calls: [{ index: 0, id: 'call_1', function: { name: toolName, arguments: custom ? '{"input":"noop"}' : '{}' } }] }
      : { content: 'No tool was called.' }))
    outputs.push(...translator.onChunk(streamChunk({}, { finish_reason: toolName ? 'tool_calls' : 'stop' })))
    outputs.push(...translator.onDone())
    expect(translator.terminalResponse?.status).toBe('failed')
    expect(parseEvents(outputs).some(event => event.type === 'response.output_item.done'
      && 'item' in event && (event.item.type === 'function_call' || event.item.type === 'custom_tool_call'))).toBe(false)
  })

  test('does not assume a 4096-token output budget when the caller omits it', () => {
    const translator = new ChatToResponsesStreamTranslator(payload(), new Map([
      ['write', { type: 'function', name: 'write' }],
    ]))
    translator.onChunk(streamChunk({
      tool_calls: [{ index: 0, id: 'call_write', function: { name: 'write', arguments: JSON.stringify({ text: 'x'.repeat(70_000) }) } }],
    }))
    translator.onChunk(streamChunk({}, { finish_reason: 'tool_calls' }))
    translator.onDone()
    expect(translator.terminalResponse?.status).toBe('completed')
  })

  test('rejects forbidden parallel calls even when the response is incomplete', () => {
    const translator = new ChatToResponsesStreamTranslator(payload({ parallel_tool_calls: false }), new Map([
      ['lookup', { type: 'function', name: 'lookup' }],
    ]))
    translator.onChunk(streamChunk({
      tool_calls: [
        { index: 0, id: 'call_a', function: { name: 'lookup', arguments: '{}' } },
        { index: 1, id: 'call_b', function: { name: 'lookup', arguments: '{}' } },
      ],
    }))
    translator.onChunk(streamChunk({}, { finish_reason: 'length' }))
    const events = parseEvents(translator.onDone())
    expect(translator.terminalResponse?.status).toBe('failed')
    expect(translator.translationFailure?.kind).toBe('parallel_tool_calls_violation')
    expect(events.some(event => event.type === 'response.output_item.done')).toBe(false)
  })

  test('bounds aggregate tool arguments across separate call lanes', () => {
    const translator = new ChatToResponsesStreamTranslator(payload({ max_output_tokens: 128_000 }), new Map([
      ['write', { type: 'function', name: 'write' }],
    ]))
    for (let index = 0; index < 2; index++) {
      translator.onChunk(streamChunk({
        tool_calls: [{ index, id: `call_${index}`, function: { name: 'write', arguments: JSON.stringify({ text: 'x'.repeat(1_100_000) }) } }],
      }))
      if (index === 0)
        expect(translator.isDone).toBe(false)
    }
    expect(translator.terminalResponse?.status).toBe('failed')
    expect(translator.translationFailure?.kind).toBe('upstream_output_too_large')
  })

  test.each(['content', 'refusal'])('bounds aggregate %s fragments', (key) => {
    const translator = new ChatToResponsesStreamTranslator(payload({ max_output_tokens: 128_000 }), new Map())
    translator.onChunk(streamChunk({ [key]: 'x'.repeat(1_100_000) }))
    expect(translator.isDone).toBe(false)
    translator.onChunk(streamChunk({ [key]: 'x'.repeat(1_100_000) }))
    expect(translator.terminalResponse?.status).toBe('failed')
    expect(translator.translationFailure?.kind).toBe('upstream_output_too_large')
  })

  test('bounds the number of upstream tool-call lanes', () => {
    const translator = new ChatToResponsesStreamTranslator(payload(), new Map([
      ['lookup', { type: 'function', name: 'lookup' }],
    ]))
    translator.onChunk(streamChunk({
      tool_calls: Array.from({ length: 1025 }, (_, index) => ({
        index,
        id: `call_${index}`,
        function: { name: 'lookup', arguments: '{}' },
      })),
    }))
    expect(translator.terminalResponse?.status).toBe('failed')
    expect(translator.translationFailure?.kind).toBe('upstream_output_too_large')
  })

  test('rejects a second full JSON completion instead of merging it', () => {
    const translator = new ChatToResponsesStreamTranslator(payload(), new Map())
    const completion = { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'first' } }] }
    translator.onChunk(completion)
    translator.onChunk(completion)
    expect(translator.terminalResponse?.status).toBe('failed')
  })
})
