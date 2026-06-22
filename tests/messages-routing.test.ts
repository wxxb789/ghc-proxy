import type { CapturedChatCall, CapturedMessagesCall, CapturedResponsesCall } from './helpers'
import type { AnthropicResponse } from '~/translator'
import type { ResponseStreamEvent } from '~/types'

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { getCachedConfig } from '~/lib/config'
import { sanitizeNativeMessagesPayloadForCopilot } from '~/routes/messages/strategies/native-messages'
import { authStore, modelCache } from '~/state'
import { normalizeOutputConfigEffort } from '~/transform'
import { processAnthropicBetaHeader } from '~/transform/beta-headers'

import {
  buildGptModel,
  buildModel,
  buildModelsResponse,
  buildVisionModel,
  clearConfig,
  createApp,
  mockChatCompletions,
  mockMessages,
  mockResponses,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

type CreateMessages = typeof CopilotClient.prototype.createMessages

const originalCreateResponses = CopilotClient.prototype.createResponses
const originalCreateMessages = CopilotClient.prototype.createMessages
const originalCreateChatCompletions = CopilotClient.prototype.createChatCompletions
const originalGetResponse = CopilotClient.prototype.getResponse
const originalGetResponseInputItems = CopilotClient.prototype.getResponseInputItems
const originalCreateResponseInputTokens = CopilotClient.prototype.createResponseInputTokens
const originalDeleteResponse = CopilotClient.prototype.deleteResponse
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
  CopilotClient.prototype.createMessages = originalCreateMessages
  CopilotClient.prototype.createChatCompletions = originalCreateChatCompletions
  CopilotClient.prototype.getResponse = originalGetResponse
  CopilotClient.prototype.getResponseInputItems = originalGetResponseInputItems
  CopilotClient.prototype.createResponseInputTokens = originalCreateResponseInputTokens
  CopilotClient.prototype.deleteResponse = originalDeleteResponse
  restoreStateSnapshot(stateSnapshot)
  setSystemTime()

  clearConfig()
  Object.assign(getCachedConfig(), structuredClone(originalConfig))
})

describe('messages routing', () => {
  test('/v1/messages uses responses translation path for responses-only models', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-5',
      output: [{
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'translated', annotations: [] }],
      }],
      output_text: 'translated',
      status: 'completed',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
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
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    const json = await response.json() as AnthropicResponse
    expect(response.status).toBe(200)
    expect(json.content[0]).toMatchObject({ type: 'text', text: 'translated' })
    expect(calls[0]?.payload.model).toBe('gpt-5')
    expect(calls[0]?.payload.context_management).toBeUndefined()
  })

  test('/v1/messages accepts system messages before model rewrite', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    const config = getCachedConfig() as Record<string, unknown>
    config.modelRewrites = [{ from: 'claude-opus-4-8', to: 'gpt-5' }]
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-5',
      output: [{
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'translated', annotations: [] }],
      }],
      output_text: 'translated',
      status: 'completed',
      usage: null,
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

    const response = await app.handle(new Request('http://localhost/v1/messages?beta=true', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 256,
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'system', content: [{ type: 'text', text: 'Prefer concise replies.' }] },
          { role: 'user', content: 'continue' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.model).toBe('gpt-5')
    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Prefer concise replies.' }] },
      { type: 'message', role: 'user', content: 'continue' },
    ])
  })

  test('/v1/messages uses native messages path when model supports it', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-sonnet-4.5', { supported_endpoints: ['/v1/messages'] })))

    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native' }],
      model: 'claude-sonnet-4.5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    }, calls)

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  test('/v1/messages native path does not inject thinking or output_config', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-sonnet-4.5', { supported_endpoints: ['/v1/messages'] })))

    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native' }],
      model: 'claude-sonnet-4.5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    }, calls)

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.thinking).toBeUndefined()
    expect(calls[0]?.payload.output_config).toBeUndefined()
  })

  test('/v1/messages native messages path preserves explicit thinking configuration', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-sonnet-4.6', { supported_endpoints: ['/v1/messages'] })))

    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native' }],
      model: 'claude-sonnet-4.6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    }, calls)

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.6',
        max_tokens: 256,
        thinking: { type: 'disabled' },
        output_config: { effort: 'max' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.thinking).toEqual({ type: 'disabled' })
    expect(calls[0]?.payload.output_config).toEqual({ effort: 'max' })
  })

  test('/v1/messages routes structured output_config format through Responses when available', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-opus-4.7', { supported_endpoints: ['/v1/messages', '/responses'] })))

    CopilotClient.prototype.createMessages = (() => {
      throw new Error('native messages should not receive structured output_config.format')
    }) as CreateMessages
    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'claude-opus-4.7',
      output: [{
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '{"title":"native"}', annotations: [] }],
      }],
      output_text: '{"title":"native"}',
      status: 'completed',
      usage: null,
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

    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    }
    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.7',
        max_tokens: 256,
        output_config: {
          effort: 'max',
          format: {
            type: 'json_schema',
            schema,
          },
        },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'anthropic_output',
        schema,
      },
    })
    expect(calls[0]?.payload.reasoning?.effort).toBe('xhigh')
  })

  test('/v1/messages rejects structured output_config format when Responses is unavailable', async () => {
    const app = createApp()
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-opus-4.7', { supported_endpoints: ['/v1/messages'] })))

    CopilotClient.prototype.createMessages = (() => {
      throw new Error('unsupported structured output should fail before upstream native messages')
    }) as CreateMessages

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.7',
        max_tokens: 256,
        output_config: {
          effort: 'max',
          format: {
            type: 'json_schema',
            schema: { type: 'object' },
          },
        },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))
    const json = await response.json() as { error?: { code?: string, param?: string } }

    expect(response.status).toBe(400)
    expect(json.error?.code).toBe('unsupported_output_config_format')
    expect(json.error?.param).toBe('output_config.format')
  })
  test('/v1/messages native path drops nullable output_config effort before upstream', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-opus-4.6', { supported_endpoints: ['/v1/messages'] })))

    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native' }],
      model: 'claude-opus-4.6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    }, calls)

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 256,
        output_config: { effort: null },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.output_config).toBeUndefined()
  })

  test('/v1/messages native path clamps unsupported high-end output_config effort', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    const model = buildModel('claude-opus-4.6', { supported_endpoints: ['/v1/messages'] })
    model.capabilities.supports.reasoning_effort = ['low', 'medium', 'high']
    modelCache.cacheModels(buildModelsResponse(model))

    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native' }],
      model: 'claude-opus-4.6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    }, calls)

    for (const effort of ['max', 'xhigh'] as const) {
      const response = await app.handle(new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4.6',
          max_tokens: 256,
          output_config: { effort },
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }))

      expect(response.status).toBe(200)
    }

    expect(calls.map(call => call.payload.output_config?.effort)).toEqual(['high', 'high'])
  })

  test('/v1/messages native path uses highest advertised output_config effort', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    const model = buildModel('claude-opus-4.7', { supported_endpoints: ['/v1/messages'] })
    model.capabilities.supports.reasoning_effort = ['medium']
    modelCache.cacheModels(buildModelsResponse(model))

    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native' }],
      model: 'claude-opus-4.7',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    }, calls)

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.7',
        max_tokens: 256,
        output_config: { effort: 'xhigh' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.output_config?.effort).toBe('medium')
  })

  test('/v1/messages native path preserves output_config effort without model metadata', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-sonnet-4.6', { supported_endpoints: ['/v1/messages'] })))

    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native' }],
      model: 'claude-sonnet-4.6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    }, calls)

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.6',
        max_tokens: 256,
        output_config: { effort: 'xhigh' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.output_config?.effort).toBe('xhigh')
  })

  test('/v1/messages native path strips output_config for models in deny-list', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-sonnet-4.5', { supported_endpoints: ['/v1/messages'] })))

    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native' }],
      model: 'claude-sonnet-4.5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    }, calls)

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        max_tokens: 256,
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.output_config).toBeUndefined()
  })

  test('/v1/messages native path strips cache_control.scope from system, messages, and tools', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-sonnet-4.5', { supported_endpoints: ['/v1/messages'] })))

    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model: 'claude-sonnet-4.5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }, calls)

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        max_tokens: 256,
        system: [
          { type: 'text', text: 'System prompt', cache_control: { type: 'ephemeral', scope: 'turn' } },
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello', cache_control: { type: 'ephemeral', scope: 'session' } },
            ],
            cache_control: { type: 'ephemeral', scope: 'turn' },
          },
        ],
        tools: [
          {
            name: 'Bash',
            input_schema: { type: 'object', properties: { cmd: { type: 'string' } } },
            cache_control: { type: 'ephemeral', scope: 'turn' },
          },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)

    const payload = calls[0]!.payload as unknown as Record<string, unknown>

    const system = payload.system as Array<Record<string, unknown>>
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' })

    const messages = payload.messages as Array<Record<string, unknown>>
    expect(messages[0]!.cache_control).toEqual({ type: 'ephemeral' })

    const content = messages[0]!.content as Array<Record<string, unknown>>
    expect(content[0]!.cache_control).toEqual({ type: 'ephemeral' })

    const tools = payload.tools as Array<Record<string, unknown>>
    expect(tools[0]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('compact routing can move /v1/messages to configured small model', async () => {
    const app = createApp()
    const chatCalls: Array<CapturedChatCall> = []
    modelCache.cacheModels(buildModelsResponse(
      buildModel('claude-opus-4.6'),
      buildModel('gpt-4.1-mini'),
    ))

    const config = getCachedConfig()
    config.smallModel = 'gpt-4.1-mini'
    config.compactUseSmallModel = true

    CopilotClient.prototype.createChatCompletions = mockChatCompletions({
      id: 'chat_1',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4.1-mini',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content: 'ok',
        },
      }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }, chatCalls)

    await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 1024,
        system: 'You are a helpful AI assistant tasked with summarizing conversations for context.',
        messages: [{ role: 'user', content: 'Summarize the conversation so far.' }],
      }),
    }))

    expect(chatCalls[0]?.payload.model).toBe('gpt-4.1-mini')
  })

  test('small-model routing preserves vision capability requirements', async () => {
    const app = createApp()
    const chatCalls: Array<CapturedChatCall> = []
    modelCache.cacheModels(buildModelsResponse(
      buildVisionModel('claude-opus-4.6'),
      buildModel('gpt-4.1-mini'),
    ))

    const config = getCachedConfig()
    config.smallModel = 'gpt-4.1-mini'
    config.compactUseSmallModel = true

    CopilotClient.prototype.createChatCompletions = mockChatCompletions({
      id: 'chat_vision_1',
      object: 'chat.completion',
      created: 1,
      model: 'claude-opus-4.6',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content: 'ok',
        },
      }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }, chatCalls)

    await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 128,
        system: 'You are a helpful AI assistant tasked with summarizing conversations',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'summarize this image' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zs6QAAAAASUVORK5CYII=',
              },
            },
          ],
        }],
      }),
    }))

    expect(chatCalls[0]?.payload.model).toBe('claude-opus-4.6')
  })

  test('/v1/messages responses streaming path emits anthropic error event on malformed upstream chunk', async () => {
    const app = createApp()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses((async function* () {
      yield {
        event: 'response.created',
        data: JSON.stringify({
          type: 'response.created',
          sequence_number: 1,
          response: {
            id: 'resp_1',
            object: 'response',
            created_at: 1,
            model: 'gpt-5',
            output: [],
            output_text: '',
            status: 'in_progress',
            usage: {
              input_tokens: 1,
              output_tokens: 0,
              total_tokens: 1,
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
        event: 'response.output_text.delta',
        data: '{not-json}',
      }
    })(), [])

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        max_tokens: 256,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('event: error')
    expect(body).toContain('"type":"error"')
  })
})

// ---------------------------------------------------------------------------
// native messages Copilot sanitization (moved from messages-native-sanitization.test.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// processAnthropicBetaHeader (moved from messages-handler.test.ts)
// ---------------------------------------------------------------------------

// ── processAnthropicBetaHeader ──
//
// Copilot rejects `context-*` beta values, so the proxy always strips them
// before forwarding. There is no longer any model upgrade tied to the header.

describe('processAnthropicBetaHeader', () => {
  test('strips context-* beta', () => {
    const result = processAnthropicBetaHeader('context-1m-2025-01-01')
    expect(result.header).toBeUndefined()
  })

  test('preserves non-context betas while stripping context-*', () => {
    const result = processAnthropicBetaHeader(
      'context-1m-2025-01-01,max-tokens-3-5-sonnet-2024-07-15',
    )
    expect(result.header).toBe('max-tokens-3-5-sonnet-2024-07-15')
  })

  test('strips mid-conversation system beta before forwarding to Copilot', () => {
    const result = processAnthropicBetaHeader(
      'mid-conversation-system-2026-04-07,max-tokens-3-5-sonnet-2024-07-15',
    )
    expect(result.header).toBe('max-tokens-3-5-sonnet-2024-07-15')
  })

  test('returns undefined header when no betas provided', () => {
    const result = processAnthropicBetaHeader(null)
    expect(result.header).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// normalizeOutputConfigEffort (moved from sanitize-output-config.test.ts)
// ---------------------------------------------------------------------------

function modelWithEfforts(efforts: Array<string>) {
  const model = buildModel('claude-test', { supported_endpoints: ['/v1/messages'] })
  model.capabilities.supports.reasoning_effort = efforts
  return model
}

describe('normalizeOutputConfigEffort', () => {
  test('passes through a supported effort unchanged', () => {
    const model = modelWithEfforts(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(normalizeOutputConfigEffort('xhigh', model)).toBe('xhigh')
    expect(normalizeOutputConfigEffort('max', model)).toBe('max')
  })

  test('clamps an unsupported effort to the highest advertised level', () => {
    // Canonical ordering low < medium < high < xhigh < max: when both max and
    // xhigh are advertised, the highest is max — not xhigh.
    const model = modelWithEfforts(['xhigh', 'max'])
    expect(normalizeOutputConfigEffort('low', model)).toBe('max')
  })

  test('treats max as higher than xhigh when clamping', () => {
    const model = modelWithEfforts(['high', 'xhigh', 'max'])
    expect(normalizeOutputConfigEffort('medium', model)).toBe('max')
  })

  test('clamps to xhigh when max is not advertised', () => {
    // Mirrors live opus-4.6 / sonnet-4.6, which advertise no xhigh — here the
    // inverse: a model that tops out at xhigh must clamp down to xhigh.
    const model = modelWithEfforts(['low', 'medium', 'high', 'xhigh'])
    expect(normalizeOutputConfigEffort('max', model)).toBe('xhigh')
  })

  test('returns undefined when the model advertises no reasoning_effort', () => {
    const model = buildModel('claude-test', { supported_endpoints: ['/v1/messages'] })
    expect(normalizeOutputConfigEffort('high', model)).toBeUndefined()
  })

  test('returns undefined when model metadata is missing', () => {
    expect(normalizeOutputConfigEffort('high', undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// POST /v1/messages/count_tokens (moved from messages-count-tokens-handler.test.ts)
// ---------------------------------------------------------------------------

describe('POST /v1/messages/count_tokens', () => {
  const originalModels = modelCache.getModels()

  beforeEach(() => {
    modelCache.clearModels()
  })

  afterEach(() => {
    if (originalModels !== undefined) {
      modelCache.cacheModels(originalModels)
    }
    else {
      modelCache.clearModels()
    }
  })

  test('accepts payload without max_tokens and returns token count', async () => {
    modelCache.cacheModels(buildModelsResponse(buildGptModel('claude-haiku-4.5')))
    const app = createApp('messages')

    const response = await app.handle(new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    }))

    expect(response.status).toBe(200)
    const json = (await response.json()) as { input_tokens: number }
    expect(typeof json.input_tokens).toBe('number')
    expect(json.input_tokens).toBeGreaterThan(0)
  })

  test('returns 400 on invalid payload instead of fake success', async () => {
    modelCache.cacheModels(buildModelsResponse(buildGptModel('claude-haiku-4.5')))
    const app = createApp('messages')

    const response = await app.handle(new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
      }),
    }))

    expect(response.status).toBe(400)
    const json = (await response.json()) as {
      error: { message: string, type: string }
    }
    expect(json.error.message).toContain('Invalid request payload')
  })

  test('GPT model with tools gets higher count than raw tokenizer output', async () => {
    // Test that GPT models receive tool overhead + estimation factor
    // by comparing against a known baseline.
    // Without the fix, GPT models get 0 overhead and 1.0x factor.
    // With the fix, they should get overhead + factor applied.
    modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-5.4-mini')))
    const app = createApp('messages')

    // Request WITHOUT tools — gives us raw tokenized count
    const noToolsRes = await app.handle(new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Hello world, this is a test message for token counting.' }],
      }),
    }))
    expect(noToolsRes.status).toBe(200)
    const noToolsJson = (await noToolsRes.json()) as { input_tokens: number }
    const rawCount = noToolsJson.input_tokens

    // Request WITH tools
    const withToolsRes = await app.handle(new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Hello world, this is a test message for token counting.' }],
        tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: {} } }],
      }),
    }))
    expect(withToolsRes.status).toBe(200)
    const withToolsJson = (await withToolsRes.json()) as { input_tokens: number }

    // The difference should include both tool overhead constant AND estimation factor.
    // Without fix: diff = just tokenizer's tool token count (small, ~20-30 tokens)
    // With fix: diff = tokenizer tool tokens + GPT_TOOL_OVERHEAD_TOKENS (~346) * factor
    // We check that the with-tools count exceeds no-tools by at least 200 tokens,
    // which can only happen if the overhead constant is being added.
    const diff = withToolsJson.input_tokens - rawCount
    expect(diff).toBeGreaterThanOrEqual(200)
  })

  test('returns 400 when model cannot be resolved', async () => {
    modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-4.1')))
    const app = createApp('messages')

    const response = await app.handle(new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    }))

    expect(response.status).toBe(400)
    const json = (await response.json()) as {
      error: { message: string, type: string }
    }
    expect(json.error.message).toContain('The selected model could not be resolved')
  })
})
