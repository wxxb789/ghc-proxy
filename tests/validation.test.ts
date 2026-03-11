import { describe, expect, test } from 'bun:test'

import {
  parseAnthropicCountTokensPayload,
  parseAnthropicMessagesPayload,
  parseOpenAIChatPayload,
  parseResponsesInputTokensPayload,
  parseResponsesPayload,
} from '~/lib/validation'

describe('OpenAI payload validation', () => {
  test('accepts validated completion options', () => {
    const payload = parseOpenAIChatPayload({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Return JSON' }],
      n: 2,
      response_format: { type: 'json_object' },
      seed: 42,
      reasoning_effort: 'high',
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            parameters: { type: 'object' },
          },
        },
      ],
      tool_choice: {
        type: 'function',
        function: {
          name: 'read_file',
        },
      },
    })

    expect(payload.n).toBe(2)
    expect(payload.response_format).toEqual({ type: 'json_object' })
    expect(payload.seed).toBe(42)
    expect(payload.reasoning_effort).toBe('high')
  })

  test('rejects malformed completion option types', () => {
    expect(() =>
      parseOpenAIChatPayload({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello!' }],
        n: '2',
      }),
    ).toThrow('Invalid request payload')

    expect(() =>
      parseOpenAIChatPayload({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello!' }],
        seed: '42',
      }),
    ).toThrow('Invalid request payload')
  })

  test('rejects unsupported response_format shapes', () => {
    expect(() =>
      parseOpenAIChatPayload({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello!' }],
        response_format: { type: 'json_schema' },
      }),
    ).toThrow('Invalid request payload')
  })

  test('normalizes response_format to the supported JSON mode shape', () => {
    const payload = parseOpenAIChatPayload({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello!' }],
      response_format: {
        type: 'json_object',
        schema: { type: 'object' },
      },
    })

    expect(payload.response_format).toEqual({ type: 'json_object' })
  })

  test('rejects out-of-range preserved sampling controls', () => {
    expect(() =>
      parseOpenAIChatPayload({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello!' }],
        frequency_penalty: 3,
      }),
    ).toThrow('Invalid request payload')

    expect(() =>
      parseOpenAIChatPayload({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello!' }],
        logit_bias: { hello: 5 },
      }),
    ).toThrow('Invalid request payload')

    expect(() =>
      parseOpenAIChatPayload({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello!' }],
        logit_bias: { 123: 101 },
      }),
    ).toThrow('Invalid request payload')
  })

  test('tool_choice.function must reference a declared tool', () => {
    expect(() =>
      parseOpenAIChatPayload({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello!' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              parameters: { type: 'object' },
            },
          },
        ],
        tool_choice: {
          type: 'function',
          function: {
            name: 'write_file',
          },
        },
      }),
    ).toThrow('Invalid request payload')
  })
})

describe('Anthropic payload validation', () => {
  test('/v1/messages requires max_tokens', () => {
    expect(() =>
      parseAnthropicMessagesPayload({
        model: 'claude-haiku-4.5',
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    ).toThrow('Invalid request payload')
  })

  test('/v1/messages/count_tokens allows missing max_tokens', () => {
    const payload = parseAnthropicCountTokensPayload({
      model: 'claude-haiku-4.5',
      messages: [{ role: 'user', content: 'Hello!' }],
    })

    expect(payload.model).toBe('claude-haiku-4.5')
    expect(payload.messages).toHaveLength(1)
    expect(payload.max_tokens).toBeUndefined()
  })

  test('tool_choice.tool requires a declared tool name', () => {
    expect(() =>
      parseAnthropicMessagesPayload({
        model: 'claude-haiku-4.5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Hello!' }],
        tools: [
          {
            name: 'get_weather',
            input_schema: { type: 'object' },
          },
        ],
        tool_choice: { type: 'tool' },
      }),
    ).toThrow('Invalid request payload')
  })

  test('tool_choice.tool must reference a declared tool', () => {
    expect(() =>
      parseAnthropicMessagesPayload({
        model: 'claude-haiku-4.5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Hello!' }],
        tools: [
          {
            name: 'get_weather',
            input_schema: { type: 'object' },
          },
        ],
        tool_choice: { type: 'tool', name: 'missing_tool' },
      }),
    ).toThrow('Invalid request payload')
  })

  test('thinking.enabled requires a positive budget_tokens', () => {
    expect(() =>
      parseAnthropicMessagesPayload({
        model: 'claude-haiku-4.5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Hello!' }],
        thinking: { type: 'enabled', budget_tokens: 0 },
      }),
    ).toThrow('Invalid request payload')
  })

  test('user messages cannot contain thinking blocks', () => {
    expect(() =>
      parseAnthropicMessagesPayload({
        model: 'claude-haiku-4.5',
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'thinking',
                thinking: 'hidden',
              },
            ],
          },
        ],
      }),
    ).toThrow('Invalid request payload')
  })
})

describe('Responses payload validation', () => {
  test('accepts function tool references declared by tool_choice', () => {
    const payload = parseResponsesPayload({
      model: 'gpt-5',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      tools: [
        {
          type: 'function',
          name: 'read_file',
          parameters: { type: 'object' },
        },
      ],
      tool_choice: {
        type: 'function',
        name: 'read_file',
      },
    })

    expect(payload.tool_choice).toEqual({
      type: 'function',
      name: 'read_file',
    })
  })

  test('accepts apply_patch tool_choice when the custom-tool shim is enabled', () => {
    const payload = parseResponsesPayload({
      model: 'gpt-5',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      tools: [
        {
          type: 'custom',
          name: 'apply_patch',
        },
      ],
      tool_choice: {
        type: 'function',
        name: 'apply_patch',
      },
    })

    expect(payload.tool_choice).toEqual({
      type: 'function',
      name: 'apply_patch',
    })
  })

  test('rejects function tool_choice when the tool is not declared', () => {
    expect(() =>
      parseResponsesPayload({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [
          {
            type: 'function',
            name: 'read_file',
            parameters: { type: 'object' },
          },
        ],
        tool_choice: {
          type: 'function',
          name: 'write_file',
        },
      }),
    ).toThrow('Invalid request payload')
  })

  test('accepts explicit input_file content items', () => {
    const payload = parseResponsesPayload({
      model: 'gpt-5',
      input: [{
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_file',
            filename: 'note.txt',
            file_data: 'data:text/plain;base64,b2s=',
          },
        ],
      }],
    })

    expect(payload.input).toHaveLength(1)
  })

  test('accepts explicit previous_response_id and truncation fields', () => {
    const payload = parseResponsesPayload({
      model: 'gpt-5',
      previous_response_id: 'resp_123',
      conversation: 'none',
      truncation: 'auto',
      max_tool_calls: 4,
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      text: {
        format: {
          type: 'json_schema',
          name: 'reply_schema',
          schema: {
            type: 'object',
          },
          strict: true,
        },
        verbosity: 'high',
      },
    })

    expect(payload.previous_response_id).toBe('resp_123')
    expect(payload.conversation).toBe('none')
    expect(payload.truncation).toBe('auto')
    expect(payload.max_tool_calls).toBe(4)
    expect(payload.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'reply_schema',
        schema: {
          type: 'object',
        },
        strict: true,
      },
      verbosity: 'high',
    })
  })

  test('rejects invalid truncation values', () => {
    expect(() =>
      parseResponsesPayload({
        model: 'gpt-5',
        truncation: 'middle',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    ).toThrow('Invalid request payload')
  })

  test('input_image requires image_url or file_id', () => {
    expect(() =>
      parseResponsesPayload({
        model: 'gpt-5',
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', detail: 'low' }],
        }],
      }),
    ).toThrow('Invalid request payload')
  })

  test('input_file with file_data requires filename', () => {
    expect(() =>
      parseResponsesPayload({
        model: 'gpt-5',
        input: [{
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_file',
            file_data: 'data:text/plain;base64,b2s=',
          }],
        }],
      }),
    ).toThrow('Invalid request payload')
  })

  test('accepts explicit item_reference and input_tokens payloads', () => {
    const payload = parseResponsesInputTokensPayload({
      conversation: { id: 'conv_123' },
      input: [
        { type: 'item_reference', id: 'item_123' },
        { type: 'message', role: 'user', content: 'hello' },
      ],
    })

    expect(payload.conversation).toEqual({ id: 'conv_123' })
    expect(payload.input).toHaveLength(2)
  })

  test('rejects invalid responses text format and retrieve booleans', () => {
    expect(() =>
      parseResponsesPayload({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        text: {
          format: {
            type: 'json_schema',
            schema: { type: 'object' },
          },
        },
      }),
    ).toThrow('Invalid request payload')
  })
})
