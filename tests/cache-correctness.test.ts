import type { CapturedChatCall, CapturedResponsesCall } from './helpers'
import type { AnthropicResponse } from '~/translator'
import type { ResponseStreamEvent } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { state } from '~/lib/state'
import {
  buildGptModel,
  buildModelsResponse,
  createApp,
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

      // Site 1: first system/developer message
      expect(payload.messages[0]?.copilot_cache_control).toEqual({ type: 'ephemeral' })

      // Site 2: last tool definition
      expect(payload.tools?.at(-1)?.copilot_cache_control).toEqual({ type: 'ephemeral' })

      // Site 3: last non-user message (the assistant message)
      const assistantMessage = payload.messages.find(m => m.role === 'assistant')
      expect(assistantMessage?.copilot_cache_control).toEqual({ type: 'ephemeral' })
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
      state.cache.models = buildModelsResponse(
        buildGptModel('gpt-5', { supported_endpoints: ['/responses'] }),
      )

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
      state.cache.models = buildModelsResponse(
        buildGptModel('gpt-5', { supported_endpoints: ['/responses'] }),
      )

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
      state.cache.models = buildModelsResponse(
        buildGptModel('gpt-5', { supported_endpoints: ['/responses'] }),
      )

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
    test('does not inject copilot_cache_control for GPT models', async () => {
      const app = createApp()
      const calls: Array<CapturedChatCall> = []
      state.cache.models = buildModelsResponse(buildGptModel('gpt-4o'))

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

      // No copilot_cache_control on any message
      for (const message of payload.messages) {
        expect(message.copilot_cache_control).toBeUndefined()
      }

      // No copilot_cache_control on any tool
      if (payload.tools) {
        for (const tool of payload.tools) {
          expect(tool.copilot_cache_control).toBeUndefined()
        }
      }
    })
  })
})
