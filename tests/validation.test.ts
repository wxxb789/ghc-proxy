import { describe, expect, test } from 'bun:test'

import {
  parseAnthropicCountTokensPayload,
  parseAnthropicMessagesPayload,
} from '~/lib/validation'

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
