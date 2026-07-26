import { describe, expect, test } from 'bun:test'

import {
  parseAnthropicCountTokensPayload,
  parseAnthropicMessagesPayload,
  parseEmbeddingRequest,
  parseOpenAIChatPayload,
  parseResponsesInputTokensPayload,
  parseResponsesPayload,
} from '~/ingest/validation'
import { HTTPError } from '~/lib/error'
import { REASONING_EFFORT_VALUES } from '~/types'

describe('OpenAI payload validation', () => {
  test('accepts optional embedding fields', () => {
    const payload = parseEmbeddingRequest({
      model: 'text-embedding-3-small',
      input: 'hello',
      dimensions: 256,
      encoding_format: 'base64',
      user: 'user-123',
    })

    expect(payload).toEqual({
      model: 'text-embedding-3-small',
      input: 'hello',
      dimensions: 256,
      encoding_format: 'base64',
      user: 'user-123',
    })
  })

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

  test('logit_bias key regex mismatch surfaces inner detail (zod invalid_key recursion)', () => {
    try {
      parseOpenAIChatPayload({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello!' }],
        logit_bias: { hello: 5 },
      })
    }
    catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
      const details = (error as HTTPError).body.error.details ?? []
      // The inner regex-mismatch detail should reach the wire — not just
      // the outer generic "Invalid key in record" — so clients know
      // which constraint (digits-only) they violated.
      expect(details.some(detail =>
        Array.isArray(detail.path)
        && detail.path.includes('logit_bias')
        && detail.path.includes('hello')
        && /pattern|regex|\d/.test(detail.message),
      )).toBe(true)
      return
    }

    throw new Error('Expected validation to fail')
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

  test('accepts output_config effort values', () => {
    for (const effort of ['low', 'medium', 'high', 'max', 'xhigh'] as const) {
      const payload = parseAnthropicMessagesPayload({
        model: 'claude-haiku-4.5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Hello!' }],
        output_config: { effort },
      })

      expect(payload.output_config?.effort).toBe(effort)
    }
  })

  test('accepts nullable output_config effort values', () => {
    const payload = parseAnthropicMessagesPayload({
      model: 'claude-haiku-4.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Hello!' }],
      output_config: { effort: null },
    })

    expect(payload.output_config?.effort).toBeNull()
  })

  test('accepts structured output_config format values', () => {
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    }
    const payload = parseAnthropicMessagesPayload({
      model: 'claude-opus-4-8',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Hello!' }],
      output_config: {
        effort: 'max',
        format: {
          type: 'json_schema',
          schema,
        },
      },
    })

    expect(payload.output_config?.format).toEqual({
      type: 'json_schema',
      schema,
    })
  })

  test('rejects unsupported output_config fields explicitly', () => {
    expect(() =>
      parseAnthropicMessagesPayload({
        model: 'claude-opus-4-8',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Hello!' }],
        output_config: {
          effort: 'max',
          unsupported: true,
        },
      }),
    ).toThrow('Invalid request payload')
  })
  test('accepts mid-conversation system messages', () => {
    const payload = parseAnthropicMessagesPayload({
      model: 'claude-opus-4-8',
      max_tokens: 16,
      messages: [
        { role: 'user', content: 'Hello!' },
        { role: 'system', content: [{ type: 'text', text: 'Follow repository conventions.' }] },
        { role: 'user', content: 'Continue.' },
      ],
    })

    expect(payload.messages[1]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'Follow repository conventions.' }],
    })
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

  test('accepts extended assistant content blocks', () => {
    const payload = parseAnthropicMessagesPayload({
      model: 'claude-sonnet-4.6',
      max_tokens: 100,
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig_1' },
          { type: 'redacted_thinking', data: 'encrypted' },
          { type: 'server_tool_use', id: 'srvtu_1', name: 'web_search', input: { query: 'cats' } },
          { type: 'mcp_tool_use', id: 'mcptoolu_1', name: 'echo', server_name: 'example-mcp', input: { text: 'hi' } },
          { type: 'web_search_tool_result', tool_use_id: 'srvtu_1', content: [{ type: 'web_search_result', title: 'Cats', url: 'https://example.com' }] },
          { type: 'mcp_tool_result', tool_use_id: 'mcptoolu_1', content: [{ type: 'text', text: 'hi' }] },
          { type: 'text', text: 'done' },
        ],
      }],
    })

    expect(payload.messages).toHaveLength(1)
  })

  test('accepts document and provider tool result blocks in user messages', () => {
    const payload = parseAnthropicMessagesPayload({
      model: 'claude-sonnet-4.6',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'file', file_id: 'file_123' } },
          { type: 'server_tool_result', tool_use_id: 'srvtu_1', content: 'result' },
          { type: 'mcp_tool_result', tool_use_id: 'mcptoolu_1', content: 'mcp result', is_error: false },
        ],
      }],
    })

    expect(payload.messages).toHaveLength(1)
  })

  test('accepts search_result blocks in user messages and tool results', () => {
    const payload = parseAnthropicMessagesPayload({
      model: 'claude-opus-4.7',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'search_result',
            source: 'https://example.com/a',
            title: 'Example A',
            content: [{ type: 'text', text: 'Alpha' }],
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [
              { type: 'text', text: 'Preface' },
              {
                type: 'search_result',
                source: 'https://example.com/b',
                title: 'Example B',
                content: [{ type: 'text', text: 'Bravo' }],
              },
            ],
          },
          {
            type: 'mcp_tool_result',
            tool_use_id: 'mcptoolu_1',
            content: [
              {
                type: 'search_result',
                source: 'https://example.com/c',
                title: 'Example C',
                content: [{ type: 'text', text: 'Charlie' }],
              },
            ],
          },
        ],
      }],
    })

    expect(payload.messages).toHaveLength(1)
  })

  test('accepts document blocks inside tool_result content (Anthropic-compatible set)', () => {
    // Regression for issue #45 (jpsamuelson report): Anthropic allows
    // text | image | search_result | document inside tool_result.content.
    // The proxy previously rejected document there with a 400.
    const payload = parseAnthropicMessagesPayload({
      model: 'claude-sonnet-5',
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [
            { type: 'text', text: 'Preface' },
            { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'file body' } },
          ],
        }],
      }],
    })

    expect(payload.messages).toHaveLength(1)
  })

  test('rejects unknown block types inside tool_result content (matches Anthropic)', () => {
    // tool_reference is NOT a valid tool_result content type; the real
    // Anthropic API rejects it too (anthropics/claude-code#28870), so the
    // proxy must stay compatible and reject rather than fake-accept it.
    expect(() =>
      parseAnthropicMessagesPayload({
        model: 'claude-sonnet-5',
        max_tokens: 64,
        messages: [{
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'tool_reference', tool_name: 'Skill' }],
          }],
        }],
      }),
    ).toThrow('Invalid request payload')
  })

  test('validation details expand nested union errors', () => {
    try {
      parseAnthropicMessagesPayload({
        model: 'claude-opus-4.7',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{
              type: 'search_result',
              source: 'https://example.com',
              title: 'Broken',
              content: [{ type: 'text' }],
            }],
          }],
        }],
      })
    }
    catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
      const details = (error as HTTPError).body.error.details ?? []
      expect(details.some(detail =>
        Array.isArray(detail.path)
        && detail.path.includes('content')
        && detail.message.includes('expected string'),
      )).toBe(true)
      return
    }

    throw new Error('Expected validation to fail')
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

  test('accepts official responses tool_choice variants', () => {
    const allowedToolsPayload = parseResponsesPayload({
      model: 'gpt-5',
      tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
      tool_choice: {
        type: 'allowed_tools',
        mode: 'required',
        tools: [{ type: 'function', name: 'get_weather' }],
      },
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    })

    const mcpPayload = parseResponsesPayload({
      model: 'gpt-5',
      tool_choice: {
        type: 'mcp',
        server_label: 'deepwiki',
        name: 'search_docs',
      },
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    })

    expect(allowedToolsPayload.tool_choice).toEqual({
      type: 'allowed_tools',
      mode: 'required',
      tools: [{ type: 'function', name: 'get_weather' }],
    })
    expect(mcpPayload.tool_choice).toEqual({
      type: 'mcp',
      server_label: 'deepwiki',
      name: 'search_docs',
    })
  })

  test('accepts prompt objects and rejects prompt strings', () => {
    const payload = parseResponsesPayload({
      model: 'gpt-5',
      prompt: {
        id: 'pmpt_123',
        variables: {
          city: 'San Francisco',
        },
      },
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    })

    expect(payload.prompt).toEqual({
      id: 'pmpt_123',
      variables: {
        city: 'San Francisco',
      },
    })

    expect(() =>
      parseResponsesPayload({
        model: 'gpt-5',
        prompt: 'pmpt_123',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    ).toThrow('Invalid request payload')
  })

  test('accepts official stream, caching, and service tier parameters', () => {
    const payload = parseResponsesPayload({
      model: 'gpt-5',
      background: true,
      stream: true,
      stream_options: {
        include_obfuscation: true,
      },
      prompt_cache_key: 'cache-key',
      prompt_cache_retention: '24h',
      service_tier: 'priority',
      reasoning: {
        effort: 'high',
        generate_summary: 'concise',
        summary: 'detailed',
      },
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    })

    expect(payload.background).toBe(true)
    expect(payload.stream_options).toEqual({ include_obfuscation: true })
    expect(payload.prompt_cache_retention).toBe('24h')
    expect(payload.service_tier).toBe('priority')
    expect(payload.reasoning).toEqual({
      effort: 'high',
      generate_summary: 'concise',
      summary: 'detailed',
    })
  })

  // Regression: the /responses ingress schema hardcoded its own effort enum
  // and was never extended when `max` shipped (PR #63), so gpt-5.6 and the
  // Claude family were rejected at the proxy boundary with a local 400 —
  // before the request ever reached a model that advertises `max`.
  for (const effort of REASONING_EFFORT_VALUES) {
    test(`accepts reasoning.effort "${effort}"`, () => {
      const payload = parseResponsesPayload({
        model: 'gpt-5.6-sol',
        reasoning: { effort },
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      })

      expect(payload.reasoning?.effort).toBe(effort)
    })
  }

  test('rejects previous_response_id together with conversation', () => {
    expect(() =>
      parseResponsesPayload({
        model: 'gpt-5',
        previous_response_id: 'resp_123',
        conversation: 'conv_123',
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

  test('conversation object form requires a non-empty id', () => {
    expect(() =>
      parseResponsesPayload({
        model: 'gpt-5',
        conversation: {},
        input: [{ type: 'message', role: 'user', content: 'hello' }],
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
