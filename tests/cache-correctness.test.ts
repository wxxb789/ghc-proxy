import type { CapturedChatCall, CapturedResponsesCall } from './helpers'
import type { AnthropicResponse } from '~/translator'
import type { ResponseStreamEvent } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { parseResponsesPayload } from '~/ingest/validation'
import { modelCache } from '~/state'
import {
  buildGptModel,
  buildModelsResponse,
  createApp,
  expectCacheCheckpoints,
  mockNonStreamingResponse,
  mockResponses,
  mockStreamingResponse,
  parseSse,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

const originalCreateChatCompletions = CopilotClient.prototype.createChatCompletions
const originalCreateResponses = CopilotClient.prototype.createResponses
const originalState = saveStateSnapshot()

beforeEach(() => {
  setupDefaultTestState()
})

afterEach(() => {
  CopilotClient.prototype.createChatCompletions = originalCreateChatCompletions
  CopilotClient.prototype.createResponses = originalCreateResponses
  restoreStateSnapshot(originalState)
})

describe('cache correctness', () => {
  describe('chat completions path', () => {
    test('non-streaming: maps cached_tokens to cache_read_input_tokens and subtracts from input_tokens', async () => {
      const app = createApp()
      const calls: Array<CapturedChatCall> = []

      CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse({
        id: 'msg_cache_1',
        object: 'chat.completion',
        created: 1,
        model: 'claude-sonnet-4.5',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: 'Hello!',
          },
        }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_tokens_details: {
            cached_tokens: 80,
          },
        },
      }, calls)

      const response = await app.handle(new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      }))

      expect(response.status).toBe(200)
      const json = await response.json() as AnthropicResponse

      expect(json.usage.input_tokens).toBe(20)
      expect(json.usage.cache_read_input_tokens).toBe(80)
      expect(json.usage.output_tokens).toBe(10)
      expect((json.usage as Record<string, unknown>).cache_creation_input_tokens).toBeUndefined()
    })

    test('non-streaming: omits cache_read_input_tokens when no cache hit', async () => {
      const app = createApp()
      const calls: Array<CapturedChatCall> = []

      CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse({
        id: 'msg_cache_2',
        object: 'chat.completion',
        created: 1,
        model: 'claude-sonnet-4.5',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: 'Hello!',
          },
        }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
        },
      }, calls)

      const response = await app.handle(new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      }))

      expect(response.status).toBe(200)
      const json = await response.json() as AnthropicResponse

      expect(json.usage.input_tokens).toBe(100)
      expect(Object.hasOwn(json.usage, 'cache_read_input_tokens')).toBe(false)
    })

    test('cache checkpoint injection: injects copilot_cache_control at correct 3 sites', async () => {
      const app = createApp()
      const calls: Array<CapturedChatCall> = []

      CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse({
        id: 'msg_cache_3',
        object: 'chat.completion',
        created: 1,
        model: 'claude-sonnet-4.5',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: 'Done.',
          },
        }],
        usage: {
          prompt_tokens: 200,
          completion_tokens: 5,
          total_tokens: 205,
        },
      }, calls)

      const response = await app.handle(new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 256,
          system: 'You are Claude Code.',
          tools: [
            {
              name: 'read_file',
              input_schema: {
                type: 'object',
                properties: { path: { type: 'string' } },
              },
            },
            {
              name: 'write_file',
              input_schema: {
                type: 'object',
                properties: { path: { type: 'string' }, content: { type: 'string' } },
              },
            },
          ],
          messages: [
            { role: 'assistant', content: 'I understand the codebase.' },
            { role: 'user', content: 'Fix the bug.' },
          ],
        }),
      }))

      expect(response.status).toBe(200)
      expect(calls).toHaveLength(1)
      const payload = calls[0]!.payload

      expectCacheCheckpoints(payload)
    })

    test('streaming: cache tokens appear in message_delta usage', async () => {
      const app = createApp()
      const calls: Array<CapturedChatCall> = []

      CopilotClient.prototype.createChatCompletions = mockStreamingResponse([
        {
          id: 'stream_cache_1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'claude-sonnet-4.5',
          choices: [{
            index: 0,
            delta: { content: 'Hi!' },
            finish_reason: null,
            logprobs: null,
          }],
        },
        {
          id: 'stream_cache_1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'claude-sonnet-4.5',
          usage: {
            prompt_tokens: 90,
            completion_tokens: 5,
            total_tokens: 95,
            prompt_tokens_details: {
              cached_tokens: 50,
            },
          },
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop',
            logprobs: null,
          }],
        },
        '[DONE]',
      ], calls)

      const response = await app.handle(new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 256,
          stream: true,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      }))

      expect(response.status).toBe(200)
      const body = await response.text()
      const events = parseSse(body)

      // message_start should contain cache tokens in usage
      const messageStartEvent = events.find(e => e.event === 'message_start')
      expect(messageStartEvent).toBeDefined()

      // message_delta should contain final usage with cache tokens
      const messageDeltaEvent = events.find(e =>
        e.event === 'message_delta'
        && e.data?.includes('"cache_read_input_tokens"'),
      )
      expect(messageDeltaEvent).toBeDefined()
      if (messageDeltaEvent?.data) {
        const deltaData = JSON.parse(messageDeltaEvent.data) as {
          usage: { input_tokens: number, cache_read_input_tokens: number }
        }
        expect(deltaData.usage.input_tokens).toBe(40)
        expect(deltaData.usage.cache_read_input_tokens).toBe(50)
      }
    })
  })

  describe('responses translation path', () => {
    test('non-streaming: maps cached_tokens to cache_read_input_tokens and subtracts from input_tokens', async () => {
      const app = createApp()
      const calls: Array<CapturedResponsesCall> = []
      modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-5', { supported_endpoints: ['/responses'] })))

      CopilotClient.prototype.createResponses = mockResponses({
        id: 'resp_cache_1',
        object: 'response',
        created_at: 1,
        model: 'gpt-5',
        output: [{
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello!', annotations: [] }],
        }],
        output_text: 'Hello!',
        status: 'completed',
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          total_tokens: 105,
          input_tokens_details: {
            cached_tokens: 60,
          },
        },
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: null,
        parallel_tool_calls: true,
        temperature: null,
        tool_choice: 'auto',
        tools: [],
        top_p: null,
      }, calls)

      const response = await app.handle(new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      }))

      expect(response.status).toBe(200)
      const json = await response.json() as AnthropicResponse

      expect(json.usage.input_tokens).toBe(40)
      expect(json.usage.cache_read_input_tokens).toBe(60)
      expect(json.usage.output_tokens).toBe(5)
      expect((json.usage as Record<string, unknown>).cache_creation_input_tokens).toBeUndefined()
    })

    test('streaming: message_start contains correct cache token counts', async () => {
      const app = createApp()
      const calls: Array<CapturedResponsesCall> = []
      modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-5', { supported_endpoints: ['/responses'] })))

      CopilotClient.prototype.createResponses = mockResponses((async function* () {
        yield {
          event: 'response.created',
          data: JSON.stringify({
            type: 'response.created',
            sequence_number: 1,
            response: {
              id: 'resp_stream_cache_1',
              object: 'response',
              created_at: 1,
              model: 'gpt-5',
              output: [],
              output_text: '',
              status: 'in_progress',
              usage: {
                input_tokens: 100,
                output_tokens: 0,
                total_tokens: 100,
                input_tokens_details: {
                  cached_tokens: 70,
                },
              },
              error: null,
              incomplete_details: null,
              instructions: null,
              metadata: null,
              parallel_tool_calls: true,
              temperature: null,
              tool_choice: 'auto',
              tools: [],
              top_p: null,
            },
          } satisfies ResponseStreamEvent),
        }
        yield {
          event: 'response.output_item.added',
          data: JSON.stringify({
            type: 'response.output_item.added',
            sequence_number: 2,
            output_index: 0,
            item: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          } satisfies ResponseStreamEvent),
        }
        yield {
          event: 'response.output_text.delta',
          data: JSON.stringify({
            type: 'response.output_text.delta',
            sequence_number: 3,
            output_index: 0,
            content_index: 0,
            delta: 'Hello!',
          } as ResponseStreamEvent),
        }
        yield {
          event: 'response.output_text.done',
          data: JSON.stringify({
            type: 'response.output_text.done',
            sequence_number: 4,
            output_index: 0,
            content_index: 0,
            text: 'Hello!',
          } as ResponseStreamEvent),
        }
        yield {
          event: 'response.output_item.done',
          data: JSON.stringify({
            type: 'response.output_item.done',
            sequence_number: 5,
            output_index: 0,
            item: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Hello!', annotations: [] }],
            },
          } satisfies ResponseStreamEvent),
        }
        yield {
          event: 'response.completed',
          data: JSON.stringify({
            type: 'response.completed',
            sequence_number: 6,
            response: {
              id: 'resp_stream_cache_1',
              object: 'response',
              created_at: 1,
              model: 'gpt-5',
              output: [{
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'Hello!', annotations: [] }],
              }],
              output_text: 'Hello!',
              status: 'completed',
              usage: {
                input_tokens: 100,
                output_tokens: 5,
                total_tokens: 105,
                input_tokens_details: {
                  cached_tokens: 70,
                },
              },
              error: null,
              incomplete_details: null,
              instructions: null,
              metadata: null,
              parallel_tool_calls: true,
              temperature: null,
              tool_choice: 'auto',
              tools: [],
              top_p: null,
            },
          } satisfies ResponseStreamEvent),
        }
      })(), calls)

      const response = await app.handle(new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5',
          max_tokens: 256,
          stream: true,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      }))

      expect(response.status).toBe(200)
      const body = await response.text()
      const events = parseSse(body)

      // message_start should have cache_read_input_tokens
      const messageStartEvent = events.find(e => e.event === 'message_start')
      expect(messageStartEvent).toBeDefined()
      const startData = JSON.parse(messageStartEvent!.data!) as {
        message: { usage: { input_tokens: number, cache_read_input_tokens: number } }
      }
      expect(startData.message.usage.input_tokens).toBe(30)
      expect(startData.message.usage.cache_read_input_tokens).toBe(70)
    })

    test('non-streaming: omits cache_read_input_tokens when no cached tokens', async () => {
      const app = createApp()
      const calls: Array<CapturedResponsesCall> = []
      modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-5', { supported_endpoints: ['/responses'] })))

      CopilotClient.prototype.createResponses = mockResponses({
        id: 'resp_cache_2',
        object: 'response',
        created_at: 1,
        model: 'gpt-5',
        output: [{
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello!', annotations: [] }],
        }],
        output_text: 'Hello!',
        status: 'completed',
        usage: {
          input_tokens: 50,
          output_tokens: 5,
          total_tokens: 55,
        },
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: null,
        parallel_tool_calls: true,
        temperature: null,
        tool_choice: 'auto',
        tools: [],
        top_p: null,
      }, calls)

      const response = await app.handle(new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      }))

      expect(response.status).toBe(200)
      const json = await response.json() as AnthropicResponse

      expect(json.usage.input_tokens).toBe(50)
      expect(Object.hasOwn(json.usage, 'cache_read_input_tokens')).toBe(false)
    })
  })

  describe('non-claude models', () => {
    test('injects copilot_cache_control for GPT models via chat-completions', async () => {
      const app = createApp()
      const calls: Array<CapturedChatCall> = []
      modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-4o')))

      CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse({
        id: 'msg_gpt_1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: 'Hello!',
          },
        }],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 5,
          total_tokens: 55,
        },
      }, calls)

      const response = await app.handle(new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 256,
          system: 'You are a helpful assistant.',
          tools: [{
            name: 'read_file',
            input_schema: {
              type: 'object',
              properties: { path: { type: 'string' } },
            },
          }],
          messages: [
            { role: 'assistant', content: 'Sure.' },
            { role: 'user', content: 'Hello' },
          ],
        }),
      }))

      expect(response.status).toBe(200)
      expect(calls).toHaveLength(1)
      const payload = calls[0]!.payload

      expectCacheCheckpoints(payload)
    })
  })
})

// ── GPT-5.6 explicit prompt caching ──
//
// Probed 2026-07-26 (scripts/probes/prompt-caching.ts). The decisive contrast,
// with a cold prefix unique per run so the first call actually writes:
//
//   gpt-5.5        cold[cached=0 write=0]     warm[cached=1792 write=0]
//   gpt-5.6-terra  cold[cached=0 write=2246]  warm[cached=2244 write=0]
//
// Only gpt-5.6 ever reports cache_write_tokens > 0, and only gpt-5.6 accepts
// prompt_cache_options / prompt_cache_breakpoint — earlier models return
// 400 "not supported on this model".

describe('gpt-5.6 explicit prompt caching', () => {
  const originalCreateResponses = CopilotClient.prototype.createResponses
  const stateSnapshot = saveStateSnapshot()

  beforeEach(() => {
    setupDefaultTestState()
  })

  afterEach(() => {
    CopilotClient.prototype.createResponses = originalCreateResponses
    restoreStateSnapshot(stateSnapshot)
  })

  function mockWithUsage(
    usage: Record<string, unknown>,
    calls: Array<CapturedResponsesCall>,
  ) {
    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_cw',
      object: 'response',
      created_at: 1,
      model: 'gpt-5.6-terra',
      output: [{
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      }],
      output_text: 'ok',
      status: 'completed',
      usage,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
    } as never, calls)
  }

  test('maps cache_write_tokens to Anthropic cache_creation_input_tokens', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(
      buildGptModel('gpt-5.6-terra', { supported_endpoints: ['/responses'] }),
    ))
    mockWithUsage({
      input_tokens: 2249,
      output_tokens: 3,
      total_tokens: 2252,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 2246 },
    }, calls)

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-terra',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    const json = await response.json() as AnthropicResponse
    expect(json.usage.cache_creation_input_tokens).toBe(2246)
  })

  test('omits cache_creation_input_tokens when nothing was written', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(
      buildGptModel('gpt-5.6-terra', { supported_endpoints: ['/responses'] }),
    ))
    mockWithUsage({
      input_tokens: 2247,
      output_tokens: 3,
      total_tokens: 2250,
      input_tokens_details: { cached_tokens: 2244, cache_write_tokens: 0 },
    }, calls)

    await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-terra',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    const json = await (await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-terra',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))).json() as AnthropicResponse

    // A zero write is not a write — reporting 0 would imply a cache miss cost
    // the caller never paid.
    expect(json.usage.cache_creation_input_tokens).toBeUndefined()
    expect(json.usage.cache_read_input_tokens).toBe(2244)
  })

  test('forwards prompt_cache_options and breakpoints to upstream', async () => {
    const app = createApp('responses')
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(
      buildGptModel('gpt-5.6-terra', { supported_endpoints: ['/responses'] }),
    ))
    mockWithUsage({ input_tokens: 10, output_tokens: 1, total_tokens: 11 }, calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-terra',
        max_output_tokens: 16,
        prompt_cache_key: 'session-42',
        prompt_cache_options: { mode: 'explicit', ttl: '30m' },
        input: [{
          type: 'message',
          role: 'system',
          content: [{
            type: 'input_text',
            text: 'reference material',
            prompt_cache_breakpoint: { mode: 'explicit' },
          }],
        }],
      }),
    }))

    expect(response.status).toBe(200)
    const payload = calls[0]!.payload as unknown as Record<string, unknown>
    expect(payload.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' })
    expect(payload.prompt_cache_key).toBe('session-42')

    const input = payload.input as Array<{ content: Array<Record<string, unknown>> }>
    expect(input[0]!.content[0]!.prompt_cache_breakpoint).toEqual({ mode: 'explicit' })
  })

  test('rejects a ttl upstream does not accept', () => {
    // Upstream returns "Invalid value: '1h'. Supported values are: '30m'."
    // Validating locally turns a wasted round-trip into an immediate 400.
    expect(() => parseResponsesPayload({
      model: 'gpt-5.6-terra',
      max_output_tokens: 16,
      prompt_cache_options: { mode: 'implicit', ttl: '1h' },
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    })).toThrow()
  })

  test('accepts the one ttl upstream supports', () => {
    const parsed = parseResponsesPayload({
      model: 'gpt-5.6-terra',
      max_output_tokens: 16,
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    }) as Record<string, unknown>

    expect(parsed.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' })
  })

  test('rejects an unknown prompt_cache_options mode', () => {
    expect(() => parseResponsesPayload({
      model: 'gpt-5.6-terra',
      max_output_tokens: 16,
      prompt_cache_options: { mode: 'aggressive' },
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    })).toThrow()
  })
})
