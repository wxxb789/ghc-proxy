import { describe, expect, test } from 'bun:test'

import { AnthropicTranslator } from '~/translator'
import { translateAnthropicToResponsesPayload } from '~/translator/responses/anthropic-to-responses'

import {
  anthropicToOpenAIFixtures,
} from './fixtures/anthropic-to-openai'

describe('Anthropic to OpenAI fixture matrix', () => {
  for (const fixture of anthropicToOpenAIFixtures) {
    test(fixture.name, () => {
      const translator = new AnthropicTranslator()
      const result = translator.toOpenAI(fixture.input)

      expect(result).toMatchObject(fixture.expected)
      expect(translator.getLastIssues().map(issue => issue.kind)).toEqual(
        fixture.expectedIssues,
      )
    })
  }
})

describe('Anthropic mid-conversation system messages', () => {
  test('fallback translator preserves system turns', () => {
    const translator = new AnthropicTranslator()
    const result = translator.toOpenAI({
      model: 'claude-opus-4.8',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'system', content: [{ type: 'text', text: 'Prefer concise replies.' }] },
        { role: 'user', content: 'Continue' },
      ],
    })

    expect(result.messages[1]).toMatchObject({
      role: 'system',
      content: 'Prefer concise replies.',
    })
  })

  test('responses translator preserves system turns in input order', () => {
    const result = translateAnthropicToResponsesPayload({
      model: 'gpt-5',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'system', content: 'Prefer concise replies.' },
        { role: 'user', content: 'Continue' },
      ],
    })

    expect(result.input).toEqual([
      { type: 'message', role: 'user', content: 'Hello' },
      { type: 'message', role: 'system', content: 'Prefer concise replies.' },
      { type: 'message', role: 'user', content: 'Continue' },
    ])
  })
})

describe('Anthropic extended content blocks', () => {
  test('fallback translator tolerates redacted thinking, server tools, MCP results, and documents', () => {
    const translator = new AnthropicTranslator()
    const result = translator.toOpenAI({
      model: 'claude-sonnet-4.6',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'file', file_id: 'file_123' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'encrypted' },
            { type: 'server_tool_use', id: 'srvtu_1', name: 'web_search', input: { query: 'cats' } },
            { type: 'text', text: 'done' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'mcp_tool_result', tool_use_id: 'srvtu_1', content: 'result' },
          ],
        },
      ],
    })

    expect(result.messages[0]).toMatchObject({
      role: 'user',
      content: '[document attachment omitted: file]',
    })
    expect(result.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'done',
      tool_calls: [{
        id: 'srvtu_1',
        type: 'function',
        function: {
          name: 'web_search',
          arguments: '{"query":"cats"}',
        },
      }],
    })
    expect(result.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'srvtu_1',
      content: 'result',
    })
    expect(translator.getLastIssues().map(issue => issue.kind)).toContain('lossy_thinking_omitted_from_prompt')
  })

  test('fallback translator flattens search_result blocks', () => {
    const translator = new AnthropicTranslator()
    const result = translator.toOpenAI({
      model: 'claude-opus-4.6-1m',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'search_result',
              source: 'https://example.com/a',
              title: 'Example A',
              content: [{ type: 'text', text: 'Alpha' }],
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'read_search', input: { id: 'a' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{
                type: 'search_result',
                source: 'https://example.com/b',
                title: 'Example B',
                content: [{ type: 'text', text: 'Bravo' }],
              }],
            },
          ],
        },
      ],
    })

    expect(result.messages[0]).toMatchObject({
      role: 'user',
      content: '[search result]\nTitle: Example A\nSource: https://example.com/a\nContent:\nAlpha',
    })
    expect(result.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'toolu_1',
      content: '[search result]\nTitle: Example B\nSource: https://example.com/b\nContent:\nBravo',
    })
  })

  test('responses translator flattens search_result blocks', () => {
    const result = translateAnthropicToResponsesPayload({
      model: 'claude-opus-4.6-1m',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'search_result',
              source: 'https://example.com/a',
              title: 'Example A',
              content: [{ type: 'text', text: 'Alpha' }],
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'read_search', input: { id: 'a' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{
                type: 'search_result',
                source: 'https://example.com/b',
                title: 'Example B',
                content: [{ type: 'text', text: 'Bravo' }],
              }],
            },
          ],
        },
      ],
    })

    const input = result.input
    expect(Array.isArray(input)).toBe(true)
    if (!Array.isArray(input)) {
      throw new TypeError('Expected responses input to be an array')
    }

    expect(input[0]).toMatchObject({
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: '[search result]\nTitle: Example A\nSource: https://example.com/a\nContent:\nAlpha',
      }],
    })
    expect(input[2]).toMatchObject({
      type: 'function_call_output',
      call_id: 'toolu_1',
      output: [{
        type: 'input_text',
        text: '[search result]\nTitle: Example B\nSource: https://example.com/b\nContent:\nBravo',
      }],
    })
  })
})
