import type { ChatCompletionsPayload } from '~/types'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { AnthropicMessagesAdapter, OpenAIChatAdapter } from '~/adapters'
import { CopilotClient } from '~/clients'
import { getCachedConfig } from '~/lib/config'
import { authStore } from '~/state'
import { formatDocumentBlock } from '~/translator/anthropic/document'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { translateAnthropicToResponsesPayload } from '~/translator/responses/anthropic-to-responses'

import { anthropicToOpenAIFixtures } from './fixtures/anthropic-to-openai'
import { openAIStreamFixtures } from './fixtures/openai-stream-to-anthropic-stream'
import { openAIToAnthropicFixtures } from './fixtures/openai-to-anthropic'
import {
  clearConfig,
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

  clearConfig()
})

afterEach(() => {
  CopilotClient.prototype.createResponses = originalCreateResponses
  restoreStateSnapshot(stateSnapshot)

  const config = getCachedConfig()
  clearConfig()
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

  test('responses translator preserves file/url/base64 documents in tool_result as input_file', () => {
    const result = translateAnthropicToResponsesPayload({
      model: 'claude-opus-4.7',
      max_tokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.pdf' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
                { type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } },
                { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'inline body' } },
              ],
            },
          ],
        },
      ],
    })

    const input = result.input
    if (!Array.isArray(input)) {
      throw new TypeError('Expected responses input to be an array')
    }

    // Regression (PR #47 review): file/url/base64 tool_result documents must be
    // preserved as input_file, not gutted to a content-free "[document]".
    expect(input[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'toolu_1',
      output: [
        { type: 'input_file', file_data: 'data:application/pdf;base64,JVBERi0=' },
        { type: 'input_file', file_url: 'https://example.com/a.pdf' },
        { type: 'input_text', text: '[document]\ninline body' },
      ],
    })
  })

  test('formatDocumentBlock labels non-text document sources instead of a bare token', () => {
    expect(formatDocumentBlock({ type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } }))
      .toBe('[document: https://example.com/a.pdf]')
    expect(formatDocumentBlock({ type: 'document', source: { type: 'file', file_id: 'file_9' } }))
      .toBe('[document: file_9]')
    expect(formatDocumentBlock({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'x' } }))
      .toBe('[document: application/pdf]')
    // text/content sources still inline their text unchanged.
    expect(formatDocumentBlock({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hi' } }))
      .toBe('[document]\nhi')
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

  // Probed 2026-07-26 (scripts/probes/sampling-params.ts): every /responses
  // model accepted top_k — 9/9, including the gpt-5.x family. The previous
  // hard 400 rejected a parameter upstream actually supports.
  test('forwards top_k on the Responses path', () => {
    const translated = translateAnthropicToResponsesPayload({
      model: 'gpt-5',
      max_tokens: 256,
      top_k: 40,
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(translated.top_k).toBe(40)
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
    expect(reasoningItems).toHaveLength(0)
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
})

describe('CAPI planning', () => {
  test('Claude anthropic requests add cache checkpoints and stream usage', () => {
    const adapter = new AnthropicMessagesAdapter()
    const plan = adapter.toCapiPlan({
      model: 'claude-sonnet-4-20250514',
      system: 'You are Claude Code.',
      messages: [
        { role: 'assistant', content: 'I can help.' },
        { role: 'user', content: 'Do the thing.' },
      ],
      tools: [
        {
          name: 'read_file',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
          },
        },
        {
          name: 'write_file',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
          },
        },
      ],
      max_tokens: 512,
      stream: true,
    })

    expect(plan.profileId).toBe('claude')
    expect(plan.requestContext.interactionType).toBe('conversation-agent')
    expect(plan.payload.stream_options).toEqual({ include_usage: true })
    expect(plan.payload.messages[0]?.copilot_cache_control).toEqual({ type: 'ephemeral' })
    expect(plan.payload.messages[1]?.copilot_cache_control).toEqual({ type: 'ephemeral' })
    expect(plan.payload.tools?.[1]?.copilot_cache_control).toEqual({ type: 'ephemeral' })
  })

  test('token counting payload strips transport-only fields', () => {
    const adapter = new AnthropicMessagesAdapter()
    const payload = adapter.toTokenCountPayload({
      model: 'claude-sonnet-4-20250514',
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 64,
      stream: true,
    })

    expect(payload.messages.every(message => !('copilot_cache_control' in message))).toBe(true)
    expect(payload.tools ?? []).toEqual([])
    expect('stream_options' in payload).toBe(false)
  })

  test('planning is deterministic for the same conversation', () => {
    const adapter = new OpenAIChatAdapter()
    const payload: ChatCompletionsPayload = {
      model: 'claude-sonnet-4.5',
      stream: true,
      messages: [
        { role: 'developer', content: 'Follow repo conventions.' },
        { role: 'user', content: 'Implement feature X.' },
      ],
      tools: [
        {
          type: 'function' as const,
          function: {
            name: 'read_file',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
              },
            },
          },
        },
      ],
    }

    const firstPlan = adapter.toCapiPlan(payload)
    const secondPlan = adapter.toCapiPlan(payload)

    expect(JSON.stringify(firstPlan.payload)).toBe(JSON.stringify(secondPlan.payload))
    expect(firstPlan.requestContext.interactionId).not.toBe(secondPlan.requestContext.interactionId)
  })

  test('forwards all completion options to CAPI payload', () => {
    const adapter = new OpenAIChatAdapter()
    const plan = adapter.toCapiPlan({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      n: 2,
      frequency_penalty: 0.5,
      presence_penalty: 0.3,
      logit_bias: { 123: 1, 456: -1 },
      logprobs: true,
      response_format: { type: 'json_object' },
      seed: 42,
    })

    expect(plan.payload.n).toBe(2)
    expect(plan.payload.frequency_penalty).toBe(0.5)
    expect(plan.payload.presence_penalty).toBe(0.3)
    expect(plan.payload.logit_bias).toEqual({ 123: 1, 456: -1 })
    expect(plan.payload.logprobs).toBe(true)
    expect(plan.payload.response_format).toEqual({ type: 'json_object' })
    expect(plan.payload.seed).toBe(42)
  })

  test('explicit reasoning_effort overrides inferred value', () => {
    const adapter = new OpenAIChatAdapter()
    const plan = adapter.toCapiPlan({
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'Think hard' }],
      thinking_budget: 4000,
      reasoning_effort: 'high',
    })

    // thinking_budget 4000 would infer "low", but explicit "high" should win
    expect(plan.payload.reasoning_effort).toBe('high')
  })

  test('omits completion options when not provided or explicitly null', () => {
    const adapter = new OpenAIChatAdapter()
    const keys = ['n', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'logprobs', 'response_format', 'seed'] as const

    const omitted = adapter.toCapiPlan({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    })
    for (const key of keys) {
      expect(key in omitted.payload).toBe(false)
    }

    const nulled = adapter.toCapiPlan({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      n: null,
      frequency_penalty: null,
      response_format: null,
      seed: null,
    })
    for (const key of ['n', 'frequency_penalty', 'response_format', 'seed'] as const) {
      expect(key in nulled.payload).toBe(false)
    }
  })
})

// ── Sampling parameters — grounded in scripts/probes/sampling-params.ts ──
//
// Probed 2026-07-26 across all three upstream boundaries. Findings that drove
// these tests, each contradicting a prior assumption:
//   1. top_k accepted by 30/30 model-boundary pairs. The proxy had dropped it
//      on the chat path and 400'd it on the Responses path since #5/#6,
//      without ever probing.
//   2. temperature and top_p are mutually exclusive on /v1/messages for
//      non-reasoning Claude models (sonnet-4.5, haiku-4.5) — a real upstream
//      400 the proxy did not model.

describe('sampling parameters', () => {
  test('top_k survives Anthropic -> CAPI planning', () => {
    const adapter = new AnthropicMessagesAdapter()
    const plan = adapter.toCapiPlan({
      model: 'claude-sonnet-4.5',
      max_tokens: 256,
      top_k: 40,
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(plan.payload.top_k).toBe(40)
  })

  test('top_k is omitted when the caller did not send it', () => {
    const adapter = new AnthropicMessagesAdapter()
    const plan = adapter.toCapiPlan({
      model: 'claude-sonnet-4.5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect('top_k' in plan.payload).toBe(false)
  })

  test('top_k no longer records an unsupported issue', () => {
    const adapter = new AnthropicMessagesAdapter()
    adapter.toCapiPlan({
      model: 'claude-sonnet-4.5',
      max_tokens: 256,
      top_k: 40,
      messages: [{ role: 'user', content: 'hello' }],
    })

    const kinds = adapter.getLastIssues().map(issue => issue.kind)
    expect(kinds).not.toContain('unsupported_top_k')
  })
})

// ── reasoning effort: max ──
//
// Probed 2026-07-26 (scripts/probes/effort-and-tokens.ts): gpt-5.6-luna/sol/
// terra accept reasoning.effort='max' (200); every other gpt-5.x returns
// 400 "Invalid value: 'max'". Claude accepts it on both the messages and
// chat-completions boundaries. In every case the model's advertised
// `capabilities.supports.reasoning_effort` matched its actual behavior, so
// the advertised list is authoritative and the effort must not be downgraded
// blindly.

describe('reasoning effort max', () => {
  test('max is preserved for a model that advertises it', () => {
    const translated = translateAnthropicToResponsesPayload({
      model: 'gpt-5.6-luna',
      max_tokens: 256,
      output_config: { effort: 'max' },
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    })

    expect(translated.reasoning?.effort).toBe('max')
  })

  test('max is clamped to the highest level a model actually advertises', () => {
    const translated = translateAnthropicToResponsesPayload({
      model: 'gpt-5.4',
      max_tokens: 256,
      output_config: { effort: 'max' },
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    })

    expect(translated.reasoning?.effort).toBe('xhigh')
  })

  // Behavior change (was: clamped to xhigh). `xhigh` was the safe fallback
  // before gpt-5.6 existed; it is now wrong in both directions — an unknown
  // model may be a gpt-5.6 that accepts `max`, or an opus-4.6 that rejects
  // `xhigh` outright. With no advertised list there is nothing to derive from,
  // so forward what the caller asked for and let upstream answer.
  test('max passes through unchanged when the model list is unknown', () => {
    const translated = translateAnthropicToResponsesPayload({
      model: 'gpt-5.4',
      max_tokens: 256,
      output_config: { effort: 'max' },
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(translated.reasoning?.effort).toBe('max')
  })

  // Regression: the old mapper only special-cased `max`, so `xhigh` reached a
  // model that rejects it. Live opus-4.6 / sonnet-4.6 advertise max but NOT
  // xhigh (probed 2026-07-26) — the exact shape that used to 400 upstream.
  test('xhigh is clamped to max for a model that advertises max but not xhigh', () => {
    const translated = translateAnthropicToResponsesPayload({
      model: 'claude-opus-4.6',
      max_tokens: 256,
      output_config: { effort: 'xhigh' },
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      supportedEfforts: ['low', 'medium', 'high', 'max'],
    })

    expect(translated.reasoning?.effort).toBe('max')
  })

  // The three newest families accept every level they advertise, so a `max`
  // request must reach them untouched — no downgrade at all.
  for (const model of ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.6-sol']) {
    test(`max reaches ${model} without downgrade`, () => {
      const translated = translateAnthropicToResponsesPayload({
        model,
        max_tokens: 256,
        output_config: { effort: 'max' },
        messages: [{ role: 'user', content: 'hello' }],
      }, {
        supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      })

      expect(translated.reasoning?.effort).toBe('max')
    })
  }
})

// Regression: only the output_config.effort branch was clamped. The three
// sibling branches each produced a candidate the caller never named — a
// hardcoded tier or a config default — and forwarded it unchecked, so a model
// that does not advertise that level returned 400.
describe('reasoning effort clamping covers every branch', () => {
  const base = {
    model: 'claude-opus-4.6',
    max_tokens: 256,
    messages: [{ role: 'user' as const, content: 'hello' }],
  }

  test('thinking:adaptive clamps its hardcoded medium to an advertised level', () => {
    const translated = translateAnthropicToResponsesPayload({
      ...base,
      thinking: { type: 'adaptive' },
    }, {
      supportedEfforts: ['high', 'xhigh', 'max'],
    })

    // Was 'medium' — not advertised, an upstream 400.
    expect(translated.reasoning?.effort).toBe('max')
  })

  test('thinking:enabled clamps the configured default', () => {
    const translated = translateAnthropicToResponsesPayload({
      ...base,
      thinking: { type: 'enabled', budget_tokens: 32000 },
    }, {
      reasoningEffortResolver: () => 'xhigh',
      supportedEfforts: ['low', 'medium', 'high', 'max'],
    })

    // opus-4.6 shape: advertises max but not xhigh.
    expect(translated.reasoning?.effort).toBe('max')
  })

  test('thinking:disabled keeps none rather than clamping it upward', () => {
    const translated = translateAnthropicToResponsesPayload({
      ...base,
      thinking: { type: 'disabled' },
    }, {
      supportedEfforts: ['low', 'medium', 'high', 'max'],
    })

    // `none` means "do not reason" — ranking it against the ladder would
    // invert the caller's intent into maximum reasoning.
    expect(translated.reasoning?.effort).toBe('none')
  })
})

// Regression: output_config.effort was dropped entirely on the chat-completions
// fallback — normalizeAnthropicRequest never read it, and no TranslationPolicy
// issue was recorded either. Not a 400, a silent capability loss: the caller
// asked for `max` and got whatever the budget heuristic produced ('high' at
// most). Copilot does accept reasoning_effort here (probed 2026-07-26).
describe('output_config.effort on the chat-completions fallback', () => {
  test('an explicit effort wins over the budget heuristic', () => {
    const translator = new AnthropicMessagesAdapter()
    const payload = translator.toCapiPlan({
      model: 'claude-opus-5',
      max_tokens: 256,
      thinking: { type: 'enabled', budget_tokens: 4000 },
      output_config: { effort: 'max' },
      messages: [{ role: 'user', content: 'hello' }],
    }).payload

    // budget 4000 infers 'low'; the caller named 'max'.
    expect(payload.reasoning_effort).toBe('max')
  })

  test('an explicit effort applies without any thinking config', () => {
    const translator = new AnthropicMessagesAdapter()
    const payload = translator.toCapiPlan({
      model: 'claude-opus-5',
      max_tokens: 256,
      output_config: { effort: 'xhigh' },
      messages: [{ role: 'user', content: 'hello' }],
    }).payload

    expect(payload.reasoning_effort).toBe('xhigh')
  })

  test('the budget heuristic still applies when no effort is named', () => {
    const translator = new AnthropicMessagesAdapter()
    const payload = translator.toCapiPlan({
      model: 'claude-opus-5',
      max_tokens: 256,
      thinking: { type: 'enabled', budget_tokens: 4000 },
      messages: [{ role: 'user', content: 'hello' }],
    }).payload

    expect(payload.reasoning_effort).toBe('low')
  })

  test('thinking:disabled sends no effort even when one is named', () => {
    const translator = new AnthropicMessagesAdapter()
    const payload = translator.toCapiPlan({
      model: 'claude-opus-5',
      max_tokens: 256,
      thinking: { type: 'disabled' },
      output_config: { effort: 'max' },
      messages: [{ role: 'user', content: 'hello' }],
    }).payload

    expect(payload.reasoning_effort).toBeUndefined()
  })
})
