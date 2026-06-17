import { describe, expect, test } from 'bun:test'

import { sanitizeNativeMessagesPayloadForCopilot } from '~/routes/messages/strategies/native-messages'

describe('native messages Copilot sanitization', () => {
  test('strips top-level citations before native upstream forwarding', () => {
    const payload = sanitizeNativeMessagesPayloadForCopilot({
      model: 'claude-opus-4.7',
      max_tokens: 32,
      citations: { enabled: true },
      messages: [{ role: 'user', content: 'hello' }],
    } as Parameters<typeof sanitizeNativeMessagesPayloadForCopilot>[0] & { citations: unknown })

    expect('citations' in payload).toBe(false)
  })

  test('keeps pure search_result tool outputs for native upstream forwarding', () => {
    const payload = sanitizeNativeMessagesPayloadForCopilot({
      model: 'claude-opus-4.7',
      max_tokens: 32,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{
            type: 'search_result',
            source: 'https://example.com',
            title: 'Example',
            content: [{ type: 'text', text: 'Alpha' }],
          }],
        }],
      }],
    })

    const content = payload.messages[0].content
    expect(Array.isArray(content)).toBe(true)
    if (!Array.isArray(content)) {
      throw new TypeError('Expected content array')
    }
    expect(content[0]).toMatchObject({
      type: 'tool_result',
      content: [{ type: 'search_result' }],
    })
  })

  test('flattens mixed search_result tool outputs for native upstream forwarding', () => {
    const payload = sanitizeNativeMessagesPayloadForCopilot({
      model: 'claude-opus-4.7',
      max_tokens: 32,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [
            { type: 'text', text: 'Preface' },
            {
              type: 'search_result',
              source: 'https://example.com',
              title: 'Example',
              content: [{ type: 'text', text: 'Alpha' }],
            },
          ],
        }],
      }],
    })

    const content = payload.messages[0].content
    expect(Array.isArray(content)).toBe(true)
    if (!Array.isArray(content)) {
      throw new TypeError('Expected content array')
    }
    expect(content[0]).toMatchObject({
      type: 'tool_result',
      content: [{
        type: 'text',
        text: 'Preface\n\n[search result]\nTitle: Example\nSource: https://example.com\nContent:\nAlpha',
      }],
    })
  })
})
