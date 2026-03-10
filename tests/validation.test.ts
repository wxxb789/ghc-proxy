import { describe, expect, test } from 'bun:test'

import {
  parseAnthropicCountTokensPayload,
  parseAnthropicMessagesPayload,
  parseOpenAIChatPayload,
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
