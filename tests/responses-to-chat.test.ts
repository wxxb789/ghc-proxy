import type { Model, ResponsesPayload } from '~/types'

import { describe, expect, test } from 'bun:test'

import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { APPLY_PATCH_LARK_GRAMMAR } from '~/translator/responses/apply-patch-grammar'
import { translateResponsesToChat } from '~/translator/responses/responses-to-chat'

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: 'gemini-bridge',
    model_picker_enabled: true,
    name: 'gemini-bridge',
    object: 'model',
    preview: false,
    vendor: 'google',
    version: '1',
    capabilities: {
      family: 'gemini',
      limits: {
        max_context_window_tokens: 128000,
        max_output_tokens: 4096,
        max_prompt_tokens: 100000,
      },
      object: 'model_capabilities',
      supports: {
        tool_calls: true,
        parallel_tool_calls: true,
        streaming: true,
        vision: true,
      },
      tokenizer: 'o200k_base',
      type: 'chat',
    },
    ...overrides,
  }
}

describe('translateResponsesToChat', () => {
  test('maps instructions, all message roles, and data/http images without mutating input', () => {
    const payload: ResponsesPayload = {
      model: 'caller-model',
      instructions: 'Follow the system policy.',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: 'Developer guidance',
        },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Inspect these images.' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
            { type: 'input_image', image_url: 'https://example.test/image.png', detail: 'low' },
          ],
        },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will inspect them.' }] },
        { type: 'message', role: 'system', content: 'System reminder' },
      ],
    }
    const before = structuredClone(payload)

    const result = translateResponsesToChat(payload, model())

    expect(payload).toEqual(before)
    expect(result.plan.payload.model).toBe('gemini-bridge')
    expect(result.plan.payload.messages).toEqual([
      {
        role: 'system',
        content: 'Follow the system policy.',
        copilot_cache_control: { type: 'ephemeral' },
      },
      { role: 'developer', content: 'Developer guidance' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect these images.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } },
          { type: 'image_url', image_url: { url: 'https://example.test/image.png', detail: 'low' } },
        ],
      },
      { role: 'assistant', content: 'I will inspect them.' },
      {
        role: 'system',
        content: 'System reminder',
        copilot_cache_control: { type: 'ephemeral' },
      },
    ])
  })

  test('accepts replayed output metadata and preserves function schema annotations', () => {
    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string', default: 'untitled', description: 'A title' },
      },
      required: ['title'],
      $defs: { marker: { type: 'string' } },
    }
    const result = translateResponsesToChat({
      model: 'caller-model',
      tools: [{ type: 'function', name: 'annotated', parameters: schema, strict: false }],
      input: [{
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'done', annotations: [], logprobs: [] }],
      }],
    }, model())

    expect(result.plan.payload.tools?.[0]?.function.parameters).toEqual(schema)
    expect(result.plan.payload.messages).toMatchObject([{ role: 'assistant', content: 'done' }])
    expect(result.issues.map(issue => issue.kind)).toContain('lossy_response_item_metadata')
  })

  test('preserves function schemas, groups parallel calls, and restores historical namespaces', () => {
    const payload: ResponsesPayload = {
      model: 'caller-model',
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Look up a value.',
          parameters: { type: 'object', properties: { key: { type: 'string' } } },
          strict: false,
        },
        {
          type: 'function',
          name: 'lookup',
          parameters: { type: 'object' },
          namespace: 'archive',
        } as Record<string, unknown>,
      ],
      input: [
        { type: 'message', role: 'user', content: 'Use the tools.' },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"key":"a"}' },
        { type: 'function_call', call_id: 'call_2', name: 'lookup', namespace: 'archive', arguments: '{"key":"b"}' } as Record<string, unknown>,
        { type: 'function_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: 'b' }] },
        { type: 'function_call_output', call_id: 'call_1', output: 'a' },
        { type: 'function_call', call_id: 'historical', name: 'old_tool', namespace: 'old_ns', arguments: '{}' } as Record<string, unknown>,
        { type: 'function_call_output', call_id: 'historical', output: 'done' },
      ],
      parallel_tool_calls: false,
    }

    const result = translateResponsesToChat(payload, model())
    const tools = result.plan.payload.tools ?? []
    const firstAlias = tools[0]?.function.name
    const archiveAlias = tools[1]?.function.name
    expect(firstAlias).toBeTruthy()
    expect(archiveAlias).toBeTruthy()
    expect(firstAlias).not.toBe(archiveAlias)
    expect(firstAlias!.length).toBeLessThanOrEqual(64)
    expect(archiveAlias!.length).toBeLessThanOrEqual(64)
    expect(result.plan.payload.parallel_tool_calls).toBe(false)
    expect(result.toolMap.get(firstAlias!)).toEqual({ type: 'function', name: 'lookup' })
    expect(result.toolMap.get(archiveAlias!)).toEqual({ type: 'function', name: 'lookup', namespace: 'archive' })
    expect(result.toolMap.size).toBe(2)

    expect(result.plan.payload.messages).toMatchObject([
      { role: 'user', content: 'Use the tools.' },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'call_1', function: { name: firstAlias, arguments: '{"key":"a"}' } },
          { id: 'call_2', function: { name: archiveAlias, arguments: '{"key":"b"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_2', content: 'b' },
      { role: 'tool', tool_call_id: 'call_1', content: 'a' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'historical', function: { name: expect.any(String), arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'historical', content: 'done' },
    ])
  })

  test('wraps custom text tools and only tolerates apply_patch grammar when enabled', () => {
    const payload: ResponsesPayload = {
      model: 'caller-model',
      tools: [
        { type: 'custom', name: 'write_note' },
        {
          type: 'custom',
          name: 'apply_patch',
          format: { type: 'grammar', syntax: 'lark', definition: APPLY_PATCH_LARK_GRAMMAR },
        },
      ],
      input: [
        { type: 'custom_tool_call', call_id: 'custom_1', name: 'write_note', input: 'title: hello' } as Record<string, unknown>,
        { type: 'custom_tool_call_output', call_id: 'custom_1', output: 'written' } as Record<string, unknown>,
        { type: 'custom_tool_call', call_id: 'patch_1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' } as Record<string, unknown>,
        { type: 'custom_tool_call_output', call_id: 'patch_1', output: 'patched' } as Record<string, unknown>,
      ],
    }

    const result = translateResponsesToChat(payload, model(), { allowApplyPatchGrammar: true })
    expect(result.plan.payload.tools?.map(tool => tool.function.parameters)).toEqual([
      { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
      { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
    ])
    expect(result.plan.payload.messages).toMatchObject([
      { role: 'assistant', tool_calls: [{ id: 'custom_1', function: { arguments: '{"input":"title: hello"}' } }] },
      { role: 'tool', tool_call_id: 'custom_1', content: 'written' },
      { role: 'assistant', tool_calls: [{ id: 'patch_1', function: { arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' } }] },
      { role: 'tool', tool_call_id: 'patch_1', content: 'patched' },
    ])
    expect(result.issues.map(issue => issue.kind)).toContain('lossy_custom_tool_grammar')

    expect(() => translateResponsesToChat(payload, model())).toThrow(TranslationFailure)
  })

  test('accepts explicit unconstrained custom text format', () => {
    const result = translateResponsesToChat({
      model: 'caller-model',
      input: 'Write a note.',
      tools: [{ type: 'custom', name: 'write_note', format: { type: 'text' } }],
    }, model())
    expect(result.plan.payload.tools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    })
  })

  test.each(['input_text', 'output_text'] as const)('preserves empty %s blocks', (type) => {
    const result = translateResponsesToChat({
      model: 'caller-model',
      input: [{ role: type === 'input_text' ? 'user' : 'assistant', content: [{ type, text: '' }] }],
    }, model())
    expect(result.plan.payload.messages[0]?.content).toBe('')
  })

  test('records loss of accepted image output metadata', () => {
    const result = translateResponsesToChat({
      model: 'caller-model',
      input: [{ role: 'user', content: [{
        type: 'input_image',
        image_url: 'https://example.test/image.png',
        annotations: [{ type: 'source' }],
        logprobs: [{ token: 'image' }],
      }] }],
    }, model())
    expect(result.issues.map(issue => issue.kind)).toContain('lossy_response_item_metadata')
  })

  test.each(['text', 'json_object'] as const)('rejects JSON Schema fields on %s format', (type) => {
    const payload: ResponsesPayload = {
      model: 'caller-model',
      input: 'hello',
      text: { format: { type, ...{ schema: { type: 'object' }, strict: true } } },
    }
    expect(() => translateResponsesToChat(payload, model())).toThrow(TranslationFailure)
  })

  test('limits the output tool map to currently allowed tools', () => {
    const result = translateResponsesToChat({
      model: 'caller-model',
      input: 'hello',
      tools: [
        { type: 'function', name: 'allowed', parameters: { type: 'object' }, strict: false },
        { type: 'function', name: 'excluded', parameters: { type: 'object' }, strict: false },
      ],
      tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'allowed' }] },
    }, model())
    expect(Array.from(result.toolMap.values(), tool => tool.name)).toEqual(['allowed'])
  })

  test('accepts function-form apply_patch choice for a custom declaration only when the shim is enabled', () => {
    const payload: ResponsesPayload = {
      model: 'caller-model',
      input: 'hello',
      tools: [{ type: 'custom', name: 'apply_patch' }],
      tool_choice: { type: 'function', name: 'apply_patch' },
    }

    const result = translateResponsesToChat(payload, model(), { allowApplyPatchGrammar: true })
    expect(result.plan.payload.tool_choice).toEqual({ type: 'function', function: { name: 'apply_patch' } })
    expect(Array.from(result.toolMap.values())).toEqual([{ type: 'custom', name: 'apply_patch' }])

    expect(() => translateResponsesToChat(payload, model())).toThrow(TranslationFailure)
  })

  test('accepts function-form apply_patch in allowed_tools for a custom declaration when the shim is enabled', () => {
    const payload: ResponsesPayload = {
      model: 'caller-model',
      input: 'hello',
      tools: [
        { type: 'custom', name: 'apply_patch' },
        { type: 'function', name: 'other', parameters: { type: 'object' }, strict: false },
      ],
      tool_choice: {
        type: 'allowed_tools',
        mode: 'required',
        tools: [{ type: 'function', name: 'apply_patch' }],
      },
    }
    const result = translateResponsesToChat(payload, model(), { allowApplyPatchGrammar: true })

    expect(result.plan.payload.tools?.map(tool => tool.function.name)).toEqual(['apply_patch'])
    expect(Array.from(result.toolMap.values())).toEqual([{ type: 'custom', name: 'apply_patch' }])
    expect(() => translateResponsesToChat(payload, model())).toThrow(TranslationFailure)
  })

  test('classifies nameless hosted tools as unsupported rather than malformed named tools', () => {
    let failure: unknown
    try {
      translateResponsesToChat({
        model: 'caller-model',
        input: 'hello',
        tools: [{ type: 'web_search' }],
      }, model())
    }
    catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(TranslationFailure)
    expect((failure as TranslationFailure).kind).toBe('unsupported_hosted_tool')
  })

  test('maps token, stream, effort, cache, and response-format fields without losing explicit false', () => {
    const payload: ResponsesPayload = {
      model: 'caller-model',
      input: 'hello',
      max_output_tokens: 12,
      stream: true,
      parallel_tool_calls: false,
      prompt_cache_key: 'session-1',
      reasoning: { effort: 'minimal', summary: 'detailed', generate_summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      text: { format: { type: 'json_object' }, verbosity: 'high' },
    }

    const result = translateResponsesToChat(payload, model())
    expect(result.plan.payload.max_tokens).toBe(12)
    expect(result.plan.payload.stream).toBe(true)
    expect(result.plan.payload.stream_options).toEqual({ include_usage: true })
    expect(result.plan.payload.parallel_tool_calls).toBe(false)
    expect(Object.hasOwn(result.plan.payload, 'prompt_cache_key')).toBe(false)
    expect(result.plan.payload.reasoning_effort).toBe('minimal')
    expect(result.plan.payload.response_format).toEqual({ type: 'json_object' })
    expect(result.issues.map(issue => issue.kind)).toEqual(expect.arrayContaining([
      'lossy_reasoning_summary',
      'lossy_reasoning_include',
      'lossy_text_verbosity',
      'lossy_prompt_cache_key',
    ]))
  })

  test('rejects bridge requests the selected Chat model cannot execute', () => {
    expect(() => translateResponsesToChat({
      model: 'caller-model',
      input: 'hello',
      reasoning: { effort: 'high' },
    }, model())).toThrow('not advertised')

    const noVision = model({
      capabilities: {
        ...model().capabilities,
        supports: { ...model().capabilities.supports, vision: false },
      },
    })
    expect(() => translateResponsesToChat({
      model: noVision.id,
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
      }],
    }, noVision)).toThrow('does not advertise vision')

    const noParallel = model({
      capabilities: {
        ...model().capabilities,
        supports: { ...model().capabilities.supports, parallel_tool_calls: false },
      },
    })
    expect(() => translateResponsesToChat({
      model: noParallel.id,
      tools: [{ type: 'function', name: 'one', parameters: {} }, { type: 'function', name: 'two', parameters: {} }],
      input: [
        { type: 'function_call', call_id: 'one', name: 'one', arguments: '{}' },
        { type: 'function_call', call_id: 'two', name: 'two', arguments: '{}' },
        { type: 'function_call_output', call_id: 'one', output: 'ok' },
        { type: 'function_call_output', call_id: 'two', output: 'ok' },
      ],
    }, noParallel)).toThrow('does not advertise parallel tool calls')
  })

  const capabilityFailures = [
    { label: 'tools', tools: false, parallel: false, streaming: false, message: 'does not advertise Chat tool calls' },
    { label: 'parallel calls', tools: true, parallel: false, streaming: false, message: 'does not advertise parallel tool calls' },
    { label: 'streaming', tools: true, parallel: true, streaming: false, message: 'does not advertise streaming' },
    { label: 'vision', tools: true, parallel: true, streaming: true, message: 'does not advertise vision input' },
  ]

  test.each(capabilityFailures)('preserves mixed-capability error priority at $label', ({ tools, parallel, streaming, message }) => {
    const selectedModel = model({
      capabilities: {
        ...model().capabilities,
        supports: { tool_calls: tools, parallel_tool_calls: parallel, streaming, vision: false },
      },
    })
    expect(() => translateResponsesToChat({
      model: selectedModel.id,
      stream: true,
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' }, strict: false }],
      input: [
        { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
        { type: 'function_call', call_id: 'one', name: 'lookup', arguments: '{}' },
        { type: 'function_call', call_id: 'two', name: 'lookup', arguments: '{}' },
        { type: 'function_call_output', call_id: 'one', output: 'one' },
        { type: 'function_call_output', call_id: 'two', output: 'two' },
      ],
    }, selectedModel)).toThrow(message)
  })

  test('preserves JSON Schema only on a structured-capable target and rejects strict tools otherwise', () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } }
    expect(() => translateResponsesToChat({
      model: 'gemini-bridge',
      tools: [{ type: 'function', name: 'strict_tool', parameters: schema, strict: true }],
      input: 'hello',
    }, model())).toThrow('strict=true')

    const structured = model({
      capabilities: {
        ...model().capabilities,
        supports: { ...model().capabilities.supports, structured_outputs: true },
      },
    })
    const result = translateResponsesToChat({
      model: structured.id,
      text: {
        format: {
          type: 'json_schema',
          name: 'reply',
          schema,
          description: '',
          strict: true,
        },
      },
      input: 'hello',
    }, structured)
    expect(result.plan.payload.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'reply', schema, description: '', strict: true },
    })
  })

  test.each([
    ['orphan function output', [{ type: 'function_call_output', call_id: 'missing', output: 'x' }]],
    ['duplicate function call ID', [
      { type: 'function_call', call_id: 'dup', name: 'a', arguments: '{}' },
      { type: 'function_call', call_id: 'dup', name: 'b', arguments: '{}' },
    ]],
    ['encrypted reasoning history', [{ type: 'reasoning', encrypted_content: 'secret' }]],
    ['compaction history', [{ type: 'compaction', id: 'compact_1', encrypted_content: 'secret' }]],
    ['automatic truncation', []],
  ] as const)('%s is rejected before any translation mutation', (name, input) => {
    const payload: ResponsesPayload = {
      model: 'caller-model',
      input: input as unknown as ResponsesPayload['input'],
      ...(name === 'automatic truncation' ? { truncation: 'auto' } : {}),
    }
    const before = structuredClone(payload)
    expect(() => translateResponsesToChat(payload, model())).toThrow(TranslationFailure)
    expect(payload).toEqual(before)
  })
})
