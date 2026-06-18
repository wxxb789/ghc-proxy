import type { CapturedResponsesCall } from './helpers'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { AnthropicMessagesAdapter } from '~/adapters'
import { CopilotClient } from '~/clients'
import { getCachedConfig } from '~/lib/config'
import { authStore, modelCache } from '~/state'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { translateAnthropicToResponsesPayload } from '~/translator/responses/anthropic-to-responses'

import { anthropicToOpenAIFixtures } from './fixtures/anthropic-to-openai'
import { openAIStreamFixtures } from './fixtures/openai-stream-to-anthropic-stream'
import { openAIToAnthropicFixtures } from './fixtures/openai-to-anthropic'
import {
  buildModel,
  buildModelsResponse,
  buildResponsesResult,
  createApp,
  mockResponses,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

const originalCreateResponses = CopilotClient.prototype.createResponses
const stateSnapshot = saveStateSnapshot()
const originalConfig = structuredClone(getCachedConfig())

beforeEach(() => {
  setupDefaultTestState()
  authStore.showToken = false
  authStore.upstreamTimeoutSeconds = undefined

  const config = getCachedConfig()
  for (const key of Object.keys(config)) {
    delete (config as Record<string, unknown>)[key]
  }
})

afterEach(() => {
  CopilotClient.prototype.createResponses = originalCreateResponses
  restoreStateSnapshot(stateSnapshot)

  const config = getCachedConfig()
  for (const key of Object.keys(config)) {
    delete (config as Record<string, unknown>)[key]
  }
  Object.assign(config, structuredClone(originalConfig))
})

describe('Anthropic to OpenAI fixture matrix', () => {
  for (const fixture of anthropicToOpenAIFixtures) {
    test(fixture.name, () => {
      const translator = new AnthropicMessagesAdapter()
      const result = translator.toCapiPlan(fixture.input).payload

      expect(result).toMatchObject(fixture.expected)
      expect(translator.getLastIssues().map(issue => issue.kind)).toEqual(
        fixture.expectedIssues,
      )
    })
  }
})

describe('Anthropic mid-conversation system messages', () => {
  test('fallback translator preserves system turns', () => {
    const translator = new AnthropicMessagesAdapter()
    const result = translator.toCapiPlan({
      model: 'claude-opus-4.8',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'system', content: [{ type: 'text', text: 'Prefer concise replies.' }] },
        { role: 'user', content: 'Continue' },
      ],
    }).payload

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
    const translator = new AnthropicMessagesAdapter()
    const result = translator.toCapiPlan({
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
    }).payload

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
    const translator = new AnthropicMessagesAdapter()
    const result = translator.toCapiPlan({
      model: 'claude-opus-4.7',
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
    }).payload

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
      model: 'claude-opus-4.7',
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

describe('OpenAI to Anthropic non-stream fixture matrix', () => {
  for (const fixture of openAIToAnthropicFixtures) {
    test(fixture.name, () => {
      const translator = new AnthropicMessagesAdapter()

      if (fixture.expectedError) {
        expect(() => translator.fromCapiResponse(fixture.input)).toThrow(TranslationFailure)
        try {
          translator.fromCapiResponse(fixture.input)
        }
        catch (error) {
          expect(error).toBeInstanceOf(TranslationFailure)
          const translationError = error as TranslationFailure
          expect(translationError.kind).toBe(fixture.expectedError.kind)
          expect(translationError.status).toBe(fixture.expectedError.status)
        }
        return
      }

      const result = translator.fromCapiResponse(fixture.input)
      expect(result).toMatchObject(fixture.expected!)
      expect(translator.getLastIssues().map(issue => issue.kind)).toEqual(
        fixture.expectedIssues,
      )
    })
  }
})

describe('OpenAI stream to Anthropic stream fixture matrix', () => {
  for (const fixture of openAIStreamFixtures) {
    test(fixture.name, () => {
      const translator = new AnthropicMessagesAdapter()
      const streamTranslator = translator.createStreamSerializer()
      const events = fixture.chunks.flatMap(chunk => streamTranslator.onChunk(chunk))
      events.push(...streamTranslator.onDone())

      expect(events).toEqual(fixture.expectedEvents)
    })
  }
})

describe('responses translation policy', () => {
  test('preserves Anthropic sampling and output token limits on the Responses path', () => {
    const translated = translateAnthropicToResponsesPayload({
      model: 'gpt-5',
      max_tokens: 256,
      temperature: 0.4,
      top_p: 0.8,
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(translated.temperature).toBe(0.4)
    expect(translated.top_p).toBe(0.8)
    expect(translated.max_output_tokens).toBe(256)
    expect(translated.reasoning).toBeUndefined()
  })

  test('maps Anthropic structured output_config format to Responses text format', () => {
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    }
    const translated = translateAnthropicToResponsesPayload({
      model: 'gpt-5',
      max_tokens: 256,
      output_config: {
        format: {
          type: 'json_schema',
          schema,
          strict: true,
        },
      },
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(translated.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'anthropic_output',
        schema,
        strict: true,
      },
    })
  })
  test('rejects Anthropic fields that cannot be preserved on the Responses path', () => {
    expect(() =>
      translateAnthropicToResponsesPayload({
        model: 'gpt-5',
        max_tokens: 256,
        stop_sequences: ['STOP'],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).toThrow(TranslationFailure)
  })

  test('thinking blocks without a valid signature do not produce reasoning items with empty id', () => {
    // Simulate round-trip: upstream returned reasoning with empty id,
    // which got encoded as "encrypted_content@" (trailing @, truthy signature,
    // isReasoningSignature = true, but decoded id = '')
    const translated = translateAnthropicToResponsesPayload({
      model: 'gpt-5.4-mini',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think...', signature: 'some_encrypted@' },
            { type: 'text', text: 'Hi there!' },
          ],
        },
        { role: 'user', content: 'follow up' },
      ],
    })

    const input = translated.input as Array<any>
    const reasoningItems = input.filter(
      (item: any) => item.type === 'reasoning',
    )
    for (const item of reasoningItems) {
      expect((item as any).id).toBeTruthy()
    }
  })

  test('thinking blocks without signature are skipped on the Responses path', () => {
    const translated = translateAnthropicToResponsesPayload({
      model: 'gpt-5.4-mini',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Some thinking' },
            { type: 'text', text: 'Response text' },
          ],
        },
        { role: 'user', content: 'next' },
      ],
    })

    const input = translated.input as Array<any>
    const reasoningItems = input.filter(
      (item: any) => item.type === 'reasoning',
    )
    expect(reasoningItems).toHaveLength(0)
  })

  test('normalizes Anthropic tool schemas for Copilot Responses compatibility', () => {
    const translated = translateAnthropicToResponsesPayload({
      model: 'gpt-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'Bash',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout: { type: 'number' },
            options: {
              type: 'object',
              properties: {
                cwd: { type: 'string' },
              },
            },
          },
          required: ['command'],
        },
      }],
    })

    expect(translated.tools).toEqual([{
      type: 'function',
      name: 'Bash',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          timeout: { type: 'number' },
          options: {
            type: 'object',
            properties: {
              cwd: { type: 'string' },
            },
            additionalProperties: false,
            required: ['cwd'],
          },
        },
        required: ['command', 'timeout', 'options'],
      },
      strict: false,
    }])
  })

  test('strips JSON Schema format annotations from Anthropic tool schemas on the Responses path', () => {
    const translated = translateAnthropicToResponsesPayload({
      model: 'gpt-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'WebFetch',
        input_schema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              format: 'uri',
            },
          },
          required: ['url'],
        },
      }],
    })

    expect(translated.tools).toEqual([{
      type: 'function',
      name: 'WebFetch',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: {
            type: 'string',
          },
        },
        required: ['url'],
      },
      strict: false,
    }])
  })

  test('strips upstream-incompatible schema metadata from Anthropic tool schemas on the Responses path', () => {
    const translated = translateAnthropicToResponsesPayload({
      model: 'gpt-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'WebFetch',
        input_schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            url: {
              type: 'string',
              title: 'URL',
              description: 'Fetch target',
              format: 'uri',
              example: 'https://example.com',
              examples: ['https://example.com'],
              default: 'https://example.com',
            },
          },
        },
      }],
    })

    expect(translated.tools).toEqual([{
      type: 'function',
      name: 'WebFetch',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: {
            type: 'string',
            description: 'Fetch target',
          },
        },
        required: ['url'],
      },
      strict: false,
    }])
  })

  test('adds additionalProperties false to object tool schemas on both direct and translated Responses paths', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_1',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [{
          type: 'function',
          name: 'plugin--nowledge-mem--nowledge_mem_search',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              options: {
                type: 'object',
                properties: {
                  limit: { type: 'integer' },
                },
              },
            },
          },
        }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
      type: 'function',
      name: 'plugin--nowledge-mem--nowledge_mem_search',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          options: {
            type: 'object',
            additionalProperties: false,
            properties: {
              limit: { type: 'integer' },
            },
            required: ['limit'],
          },
        },
        required: ['query', 'options'],
      },
    })
  })
})
