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
})
