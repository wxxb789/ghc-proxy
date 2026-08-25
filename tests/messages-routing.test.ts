import type { CapturedChatCall, CapturedMessagesCall, CapturedResponsesCall } from './helpers'
import type { AnthropicResponse } from '~/translator'
import type { ResponseStreamEvent } from '~/types'

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { LocalModelCooldownError, TerminalUpstreamRecoveryError } from '~/clients/upstream-queue'
import { getCachedConfig } from '~/lib/config'
import { HTTPError } from '~/lib/error'
import { sanitizeNativeMessagesPayloadForCopilot } from '~/routes/messages/strategies/native-messages'
import { authStore, modelCache } from '~/state'
import { normalizeOutputConfigEffort } from '~/transform'
import { processAnthropicBetaHeader } from '~/transform/beta-headers'

import {
  buildGptModel,
  buildModel,
  buildModelsResponse,
  buildResponsesResult,
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
  test('/v1/messages keeps Anthropic error shape for a rejected local-cooldown fallback', async () => {
    const app = createApp()
    modelCache.cacheModels(buildModelsResponse(
      buildModel('source', { supported_endpoints: ['/v1/messages'] }),
      buildModel('target', { supported_endpoints: ['/v1/messages'] }),
    ))
    const config = getCachedConfig() as Record<string, unknown>
    config.overloadFallbacks = { source: 'target' }

    let calls = 0
    CopilotClient.prototype.createMessages = (async () => {
      calls++
      if (calls === 1) {
        throw new LocalModelCooldownError({
          requestId: 'messages-local-cooldown',
          retryCount: 0,
          sourceModel: 'source',
        }, '3')
      }
      throw new HTTPError(400, {
        error: { message: 'target preflight failed', type: 'invalid_request_error' },
      })
    }) as typeof CopilotClient.prototype.createMessages

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(529)
    expect(response.headers.get('retry-after')).toBe('3')
    expect(await response.json()).toEqual({
      type: 'error',
      error: {
        message: 'The selected upstream model is temporarily overloaded.',
        type: 'overloaded_error',
      },
    })
    expect(calls).toBe(2)
  })

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

  test('/v1/messages rejects server tools before Responses translation', async () => {
    const app = createApp()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))

    let upstreamCalls = 0
    CopilotClient.prototype.createResponses = (async () => {
      upstreamCalls++
      throw new Error('Responses upstream must not receive Anthropic server tools')
    }) as typeof CopilotClient.prototype.createResponses

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Search the web.' }],
        tools: [{
          type: 'web_search_future',
          name: 'web_search',
          input_schema: { type: 'object', properties: {} },
          max_uses: 3,
        }],
      }),
    }))

    const json = await response.json() as {
      type?: string
      error?: { type?: string, code?: string, message?: string }
    }
    expect(response.status).toBe(400)
    expect(json.type).toBe('error')
    expect(json.error?.type).toBe('translation_error')
    expect(json.error?.code).toBe('unsupported_server_tool')
    expect(json.error?.message).toContain('web_search_future')
    expect(upstreamCalls).toBe(0)
  })

  test('/v1/messages translates a typed custom client tool through Responses', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_custom_tool',
      model: 'gpt-5',
      status: 'completed',
      output: [],
    }), calls)

    const inputSchema = { type: 'object', properties: { value: { type: 'string' } } }
    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Run the custom tool.' }],
        tools: [{
          type: 'custom',
          name: 'custom_tool',
          input_schema: inputSchema,
        }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools).toEqual([{
      type: 'function',
      name: 'custom_tool',
      parameters: inputSchema,
    }])
  })

  test('/v1/messages translates a typed custom client tool through Chat Completions', async () => {
    const app = createApp()
    const calls: Array<CapturedChatCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('chat-only')))

    CopilotClient.prototype.createChatCompletions = mockChatCompletions({
      id: 'chat_custom_tool',
      object: 'chat.completion',
      created: 1,
      model: 'chat-only',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content: 'ok' },
      }],
    }, calls)

    const inputSchema = { type: 'object', properties: { value: { type: 'string' } } }
    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'chat-only',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Run the custom tool.' }],
        tools: [{
          type: 'custom',
          name: 'custom_tool',
          input_schema: inputSchema,
        }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'custom_tool',
        parameters: inputSchema,
      },
    })
  })

  test('/v1/messages rejects server tools before Chat Completions translation', async () => {
    const app = createApp()
    modelCache.cacheModels(buildModelsResponse(buildModel('chat-only')))

    let upstreamCalls = 0
    CopilotClient.prototype.createChatCompletions = (async () => {
      upstreamCalls++
      throw new Error('Chat Completions upstream must not receive Anthropic server tools')
    }) as typeof CopilotClient.prototype.createChatCompletions

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'chat-only',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Search the web.' }],
        tools: [{ type: 'web_search_future', name: 'web_search', max_uses: 3 }],
      }),
    }))

    const json = await response.json() as {
      type?: string
      error?: { type?: string, code?: string, message?: string }
    }
    expect(response.status).toBe(400)
    expect(json.type).toBe('error')
    expect(json.error?.type).toBe('translation_error')
    expect(json.error?.code).toBe('unsupported_server_tool')
    expect(json.error?.message).toContain('web_search_future')
    expect(upstreamCalls).toBe(0)
  })

  test('/v1/messages rejects service_tier before Chat Completions translation', async () => {
    const app = createApp()
    modelCache.cacheModels(buildModelsResponse(buildModel('chat-only')))

    let upstreamCalls = 0
    CopilotClient.prototype.createChatCompletions = (async () => {
      upstreamCalls++
      throw new Error('Chat Completions upstream must not receive Anthropic service_tier')
    }) as typeof CopilotClient.prototype.createChatCompletions

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'chat-only',
        max_tokens: 256,
        service_tier: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    const json = await response.json() as {
      type?: string
      error?: { type?: string, code?: string, message?: string }
    }
    expect(response.status).toBe(400)
    expect(json.type).toBe('error')
    expect(json.error?.type).toBe('translation_error')
    expect(json.error?.code).toBe('unsupported_service_tier')
    expect(upstreamCalls).toBe(0)
  })

  // Regression: the Anthropic -> Responses translator emits `phase` on
  // assistant messages (translator/responses/response-items.ts), but `phase`
  // is an output-only annotation that some models reject as input — this repo
  // documented it as a 400 cause in docs/investigation-responses-404.md.
  // The stripper only ran on POST /v1/responses, so this path leaked it.
  test('/v1/messages responses path strips phase from translated input items', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_phase',
      status: 'completed',
      output: [],
      output_text: '',
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        max_tokens: 256,
        messages: [
          { role: 'user', content: 'run the tool' },
          {
            // Text alongside tool_use makes resolveAssistantPhase() emit
            // 'commentary'; text alone would emit 'final_answer'. Either way
            // the field must not reach upstream.
            role: 'assistant',
            content: [
              { type: 'text', text: 'calling it now' },
              { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { cmd: 'ls' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
          },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)

    const input = calls[0]!.payload.input as Array<Record<string, unknown>>
    expect(input.length).toBeGreaterThan(0)
    for (const item of input) {
      expect(item).not.toHaveProperty('phase')
    }
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

  test('/v1/messages native path forwards a name-less server toolset unchanged', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-opus-5', { supported_endpoints: ['/v1/messages'] })))

    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native' }],
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }, calls)

    const tool = {
      type: 'browser_toolset_20260801',
    }
    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Use the browser.' }],
        tools: [tool],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.tools as unknown).toEqual([tool])
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

  test('/v1/messages native path converts enabled thinking to adaptive for adaptive-thinking models', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    // buildModel advertises adaptive_thinking: true by default.
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-sonnet-5', { supported_endpoints: ['/v1/messages'] })))

    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native' }],
      model: 'claude-sonnet-5',
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
        model: 'claude-sonnet-5',
        max_tokens: 64,
        thinking: { type: 'enabled', budget_tokens: 30000 },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))

    expect(response.status).toBe(200)
    // budget_tokens 30000 -> high; adaptive shape is what upstream accepts.
    expect(calls[0]?.payload.thinking).toEqual({ type: 'adaptive' })
    expect(calls[0]?.payload.output_config).toEqual({ effort: 'high' })
  })

  test('/v1/messages native path keeps enabled thinking for models without adaptive thinking', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-sonnet-4.6', {
      supported_endpoints: ['/v1/messages'],
      capabilities: {
        ...buildModel('claude-sonnet-4.6').capabilities,
        supports: {
          ...buildModel('claude-sonnet-4.6').capabilities.supports,
          adaptive_thinking: false,
        },
      },
    })))

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
        max_tokens: 64,
        thinking: { type: 'enabled', budget_tokens: 12000 },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.thinking).toEqual({ type: 'enabled', budget_tokens: 12000 })
    expect(calls[0]?.payload.output_config).toBeUndefined()
  })

  test('/v1/messages native path preserves explicit output_config.effort when converting enabled thinking', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-sonnet-5', { supported_endpoints: ['/v1/messages'] })))

    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native' }],
      model: 'claude-sonnet-5',
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
        model: 'claude-sonnet-5',
        max_tokens: 64,
        thinking: { type: 'enabled', budget_tokens: 30000 },
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.thinking).toEqual({ type: 'adaptive' })
    // Explicit effort must win over the budget heuristic.
    expect(calls[0]?.payload.output_config).toEqual({ effort: 'low' })
  })

  // Loosening the ingress schema only helps if the field survives the pipeline.
  // sanitizeOutputConfig used to rebuild the object as `{ effort }`, which would
  // turn a visible 400 into a silent drop — strictly worse for the caller.
  test('/v1/messages native path forwards unrecognized output_config fields to upstream', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-opus-5', { supported_endpoints: ['/v1/messages'] })))

    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native' }],
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }, calls)

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 64,
        output_config: { effort: 'high', verbosity: 'low' },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))

    expect(response.status).toBe(200)
    const forwarded = calls[0]?.payload.output_config as Record<string, unknown> | undefined
    expect(forwarded?.effort).toBe('high')
    expect(forwarded?.verbosity).toBe('low')
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
    // buildModel sets no reasoning_effort, so there is no advertised list to
    // clamp against and `max` is forwarded as sent. This used to assert
    // 'xhigh' — the old blind fallback, which downgraded models that accept
    // `max` and could still land on a level the model rejects.
    expect(calls[0]?.payload.reasoning?.effort).toBe('max')
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

    for (const effort of ['xhigh', 'max'] as const) {
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

  test('compact fallback applies one exact target after source resolution', async () => {
    const app = createApp()
    const calls: Array<CapturedChatCall> = []
    modelCache.cacheModels(buildModelsResponse(
      buildModel('claude-opus-4.6'),
      buildModel('gpt-4.1-mini'),
      buildModel('gpt-5-target'),
      buildModel('wrong-target'),
    ))
    const config = getCachedConfig() as Record<string, unknown>
    config.smallModel = 'gpt-4.1-mini'
    config.compactUseSmallModel = true
    config.overloadFallbacks = { 'gpt-4.1-mini': 'gpt-5-target' }
    config.modelRewrites = [{ from: 'gpt-5-target', to: 'wrong-target' }]

    CopilotClient.prototype.createChatCompletions = (async (payload, options) => {
      calls.push({ payload, options })
      if (calls.length === 1) {
        throw new TerminalUpstreamRecoveryError(
          new HTTPError(529, {
            error: { message: 'source overloaded', type: 'overloaded_error' },
          }, { headers: { 'retry-after': '3' } }),
          { requestId: 'messages-fallback', retryCount: 1, sourceModel: 'gpt-4.1-mini' },
        )
      }
      return {
        id: 'chat_fallback',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4.1-mini',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: { role: 'assistant', content: 'ok' },
        }],
      }
    }) as typeof CopilotClient.prototype.createChatCompletions

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 1024,
        system: 'You are a helpful AI assistant tasked with summarizing conversations for context.',
        messages: [{ role: 'user', content: 'Summarize the conversation so far.' }],
      }),
    }))
    const body = await response.json() as AnthropicResponse

    expect(response.status).toBe(200)
    expect(calls.map(call => call.payload.model)).toEqual(['gpt-4.1-mini', 'gpt-5-target'])
    expect(body.model).toBe('gpt-5-target')
  })

  test('late CAPI source resolution retains the pristine payload for fallback', async () => {
    const app = createApp()
    const calls: Array<CapturedChatCall> = []
    modelCache.cacheModels(buildModelsResponse(
      buildModel('late-source'),
      buildModel('target'),
    ))
    const config = getCachedConfig() as Record<string, unknown>
    config.modelFallback = { claudeOpus: 'late-source' }
    config.overloadFallbacks = { 'late-source': 'target' }

    CopilotClient.prototype.createChatCompletions = (async (payload, options) => {
      calls.push({ payload, options })
      if (calls.length === 1) {
        throw new TerminalUpstreamRecoveryError(
          new HTTPError(529, {
            error: { message: 'late source overloaded', type: 'overloaded_error' },
          }),
          {
            requestId: 'late-capi-fallback',
            retryCount: 1,
            sourceModel: 'late-source',
          },
        )
      }
      return {
        id: 'chat_late_fallback',
        object: 'chat.completion',
        created: 1,
        model: 'late-source',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: { role: 'assistant', content: 'ok' },
        }],
      }
    }) as typeof CopilotClient.prototype.createChatCompletions

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-unadvertised',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))
    const body = await response.json() as AnthropicResponse

    expect(response.status).toBe(200)
    expect(calls.map(call => call.payload.model)).toEqual(['late-source', 'target'])
    expect(body.model).toBe('target')
  })

  test('structured output fallback uses a Responses target without a structured_outputs flag', async () => {
    const app = createApp()
    const responsesCalls: Array<CapturedResponsesCall> = []
    const source = buildModel('claude-opus-5', {
      supported_endpoints: ['/v1/messages'],
    })
    source.capabilities.supports.structured_outputs = true
    const target = buildModel('responses-target', {
      supported_endpoints: ['/responses'],
    })
    modelCache.cacheModels(buildModelsResponse(source, target))
    const config = getCachedConfig() as Record<string, unknown>
    config.overloadFallbacks = { 'claude-opus-5': 'responses-target' }

    let sourceCalls = 0
    CopilotClient.prototype.createMessages = (async () => {
      sourceCalls++
      throw new TerminalUpstreamRecoveryError(
        new HTTPError(529, {
          error: { message: 'source overloaded', type: 'overloaded_error' },
        }),
        {
          requestId: 'structured-output-fallback',
          retryCount: 1,
          sourceModel: 'claude-opus-5',
        },
      )
    }) as typeof CopilotClient.prototype.createMessages
    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      model: 'responses-target',
      status: 'completed',
      output: [{
        id: 'msg_fallback',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '{"answer":"ok"}', annotations: [] }],
      }],
      output_text: '{"answer":"ok"}',
    }), responsesCalls)

    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    }
    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 256,
        output_config: {
          format: { type: 'json_schema', schema },
        },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(sourceCalls).toBe(1)
    expect(responsesCalls).toHaveLength(1)
    expect(responsesCalls[0]?.payload.model).toBe('responses-target')
    expect(responsesCalls[0]?.payload.text?.format).toMatchObject({
      type: 'json_schema',
      schema,
    })
  })

  test('/v1/messages preserves source 529 when target lacks parallel tool calls', async () => {
    const app = createApp()
    const source = buildModel('messages-source', {
      supported_endpoints: ['/v1/messages'],
    })
    const target = buildModel('responses-target', {
      supported_endpoints: ['/responses'],
    })
    target.capabilities.supports.parallel_tool_calls = false
    modelCache.cacheModels(buildModelsResponse(source, target))
    const config = getCachedConfig() as Record<string, unknown>
    config.overloadFallbacks = { 'messages-source': 'responses-target' }

    const sourceError = new HTTPError(529, {
      error: { message: 'source overloaded', type: 'overloaded_error' },
    }, { headers: { 'retry-after': '7' } })
    let sourceCalls = 0
    let targetCalls = 0
    CopilotClient.prototype.createMessages = (async () => {
      sourceCalls++
      throw new TerminalUpstreamRecoveryError(sourceError, {
        requestId: 'parallel-tools-fallback',
        retryCount: 1,
        sourceModel: 'messages-source',
      })
    }) as typeof CopilotClient.prototype.createMessages
    CopilotClient.prototype.createResponses = (async () => {
      targetCalls++
      return buildResponsesResult({ model: 'responses-target', status: 'completed' })
    }) as typeof CopilotClient.prototype.createResponses

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'messages-source',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'look this up' }],
        tools: [{
          name: 'lookup',
          description: 'Look up a value',
          input_schema: { type: 'object', properties: {} },
        }],
      }),
    }))

    expect(response.status).toBe(529)
    expect(response.headers.get('retry-after')).toBe('7')
    expect(await response.json()).toEqual({ type: 'error', ...sourceError.body })
    expect(sourceCalls).toBe(1)
    expect(targetCalls).toBe(0)
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

  // Regression: model rewrite and compact routing must compose on ONE request.
  // applyMessagesModelPolicy reads payload.model (request-model-policy.ts), so
  // compact routing only sees the rewritten model if the rewrite result was
  // written back to the payload before the policy runs. Testing either feature
  // alone cannot catch a break in that hand-off.
  test('compact routing evaluates the REWRITTEN model, not the requested one', async () => {
    const app = createApp()
    const chatCalls: Array<CapturedChatCall> = []
    // 'claude-opus-4.6' is NOT in the model list — only its rewrite target is.
    // If compact routing ran against the pre-rewrite id, the capability check
    // would look up an unknown model and refuse to route to the small model.
    modelCache.cacheModels(buildModelsResponse(
      buildModel('claude-opus-5'),
      buildModel('gpt-4.1-mini'),
    ))

    const config = getCachedConfig() as Record<string, unknown>
    config.modelRewrites = [{ from: 'claude-opus-4.6', to: 'claude-opus-5' }]
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
        message: { role: 'assistant', content: 'ok' },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }, chatCalls)

    const response = await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 1024,
        system: 'You are a helpful AI assistant tasked with summarizing conversations for context.',
        messages: [{ role: 'user', content: 'Summarize the conversation so far.' }],
      }),
    }))

    expect(response.status).toBe(200)
    // Both transforms applied, in order: rewrite THEN compact.
    expect(chatCalls[0]?.payload.model).toBe('gpt-4.1-mini')
  })

  // Companion to the test above: when the rewrite target cannot support the
  // request, compact routing must decline — proving the capability check reads
  // the rewritten model rather than blindly routing.
  test('compact routing declines when the rewritten model out-classes the small model', async () => {
    const app = createApp()
    const chatCalls: Array<CapturedChatCall> = []
    modelCache.cacheModels(buildModelsResponse(
      buildVisionModel('claude-opus-5'),
      buildModel('gpt-4.1-mini'),
    ))

    const config = getCachedConfig() as Record<string, unknown>
    config.modelRewrites = [{ from: 'claude-opus-4.6', to: 'claude-opus-5' }]
    config.smallModel = 'gpt-4.1-mini'
    config.compactUseSmallModel = true

    CopilotClient.prototype.createChatCompletions = mockChatCompletions({
      id: 'chat_1',
      object: 'chat.completion',
      created: 1,
      model: 'claude-opus-5',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content: 'ok' },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }, chatCalls)

    await app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 1024,
        system: 'You are a helpful AI assistant tasked with summarizing conversations for context.',
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

    // Rewrite applied; compact declined because gpt-4.1-mini lacks vision.
    expect(chatCalls[0]?.payload.model).toBe('claude-opus-5')
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
    expect(result).toBeUndefined()
  })

  test('preserves non-context betas while stripping context-*', () => {
    const result = processAnthropicBetaHeader(
      'context-1m-2025-01-01,max-tokens-3-5-sonnet-2024-07-15',
    )
    expect(result).toBe('max-tokens-3-5-sonnet-2024-07-15')
  })

  test('strips mid-conversation system beta before forwarding to Copilot', () => {
    const result = processAnthropicBetaHeader(
      'mid-conversation-system-2026-04-07,max-tokens-3-5-sonnet-2024-07-15',
    )
    expect(result).toBe('max-tokens-3-5-sonnet-2024-07-15')
  })

  test('returns undefined header when no betas provided', () => {
    const result = processAnthropicBetaHeader(null)
    expect(result).toBeUndefined()
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

  test.each([
    { type: 'browser_toolset_20260801', minimum: 7_500 },
    { type: 'computer_toolset_20260801', minimum: 4_500 },
  ])('counts $type without translating it to Chat tools', async ({ type, minimum }) => {
    modelCache.cacheModels(buildModelsResponse(buildGptModel('claude-opus-5')))
    const app = createApp('messages')

    const response = await app.handle(new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'Use the browser.' }],
        tools: [{ type }],
      }),
    }))

    expect(response.status).toBe(200)
    const json = await response.json() as { input_tokens: number }
    expect(json.input_tokens).toBeGreaterThanOrEqual(minimum)
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

// ── Sampling parameters on the native path ──
//
// Probed 2026-07-26 (scripts/probes/sampling-params.ts): Copilot's
// /v1/messages rejects temperature+top_p together for non-reasoning Claude
// models with "cannot both be specified for this model". top_k, by contrast,
// was accepted by every model on every boundary.

describe('native messages sampling params', () => {
  function nativeModel() {
    modelCache.cacheModels(buildModelsResponse(
      buildModel('claude-sonnet-4.5', { supported_endpoints: ['/v1/messages'] }),
    ))
  }

  function mockNativeCapture(calls: Array<CapturedMessagesCall>) {
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
  }

  async function post(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
    return app.handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
        ...body,
      }),
    }))
  }

  test('drops top_p when temperature is also present', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    nativeModel()
    mockNativeCapture(calls)

    const response = await post(app, { temperature: 0.5, top_p: 0.9 })

    expect(response.status).toBe(200)
    const payload = calls[0]!.payload as unknown as Record<string, unknown>
    expect(payload.temperature).toBe(0.5)
    expect('top_p' in payload).toBe(false)
  })

  test('keeps top_p when temperature is absent', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    nativeModel()
    mockNativeCapture(calls)

    await post(app, { top_p: 0.9 })

    const payload = calls[0]!.payload as unknown as Record<string, unknown>
    expect(payload.top_p).toBe(0.9)
  })

  test('forwards top_k unchanged', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    nativeModel()
    mockNativeCapture(calls)

    await post(app, { top_k: 40 })

    const payload = calls[0]!.payload as unknown as Record<string, unknown>
    expect(payload.top_k).toBe(40)
  })
})

// Copilot's native /v1/messages enforces its output ceiling (probed 2026-07-26:
// `max_tokens: 64001 > 64000` returns 400), unlike /responses where the
// advertised value is advisory. The model record already carries the bound, so
// forwarding an over-ceiling value leaks a 400 the proxy could have absorbed.
describe('/v1/messages native path clamps max_tokens to the advertised ceiling', () => {
  function cacheModelWithCeiling(ceiling: number) {
    const model = buildModel('claude-opus-5', { supported_endpoints: ['/v1/messages'] })
    model.capabilities.limits.max_output_tokens = ceiling
    modelCache.cacheModels(buildModelsResponse(model))
  }

  async function sendMaxTokens(maxTokens: number, calls: Array<CapturedMessagesCall>) {
    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }, calls)

    return createApp().handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))
  }

  test('lowers an over-ceiling max_tokens to the advertised limit', async () => {
    cacheModelWithCeiling(64000)
    const calls: Array<CapturedMessagesCall> = []

    const response = await sendMaxTokens(64001, calls)

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.max_tokens).toBe(64000)
  })

  test('leaves a within-ceiling max_tokens untouched', async () => {
    cacheModelWithCeiling(64000)
    const calls: Array<CapturedMessagesCall> = []

    await sendMaxTokens(1024, calls)

    expect(calls[0]?.payload.max_tokens).toBe(1024)
  })

  test('does not clamp when the model advertises no ceiling', async () => {
    const model = buildModel('claude-opus-5', { supported_endpoints: ['/v1/messages'] })
    delete (model.capabilities.limits as { max_output_tokens?: number }).max_output_tokens
    modelCache.cacheModels(buildModelsResponse(model))
    const calls: Array<CapturedMessagesCall> = []

    // An unknown bound is not a reason to guess one.
    await sendMaxTokens(999999, calls)

    expect(calls[0]?.payload.max_tokens).toBe(999999)
  })
})

// Regression for a reported 400 on claude-opus-5: any Messages request carrying
// output_config.format was routed away from the native path, and opus-5 has no
// /responses endpoint, so it fell through to the chat-completions guard and was
// rejected locally. The routing rule generalized one 2026-06-02 observation
// (Vertex refusing structured_outputs for claude-opus-4-7) into a permanent rule
// for every model. Probed 2026-07-26: 6 of 8 Messages models serve a bare
// { type, schema } natively (scripts/probes/messages/output-format.ts).
describe('/v1/messages serves structured output natively when the model supports it', () => {
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  }

  function cacheModel(id: string, structuredOutputs: boolean) {
    const model = buildModel(id, { supported_endpoints: ['/v1/messages'] })
    model.capabilities.supports.structured_outputs = structuredOutputs
    modelCache.cacheModels(buildModelsResponse(model))
    return model
  }

  function mockNative(id: string, calls: Array<CapturedMessagesCall>) {
    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '{"answer":"ok"}' }],
      model: id,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }, calls)
  }

  async function send(body: Record<string, unknown>) {
    return createApp().handle(new Request('http://localhost/v1/messages?beta=true', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
  }

  test('forwards a bare format to native rather than rejecting it', async () => {
    cacheModel('claude-opus-5', true)
    const calls: Array<CapturedMessagesCall> = []
    mockNative('claude-opus-5', calls)

    const response = await send({
      model: 'claude-opus-5',
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.output_config?.format).toEqual({ type: 'json_schema', schema })
  })

  test('strips name, a pure label native rejects as an extra input', async () => {
    cacheModel('claude-opus-5', true)
    const calls: Array<CapturedMessagesCall> = []
    mockNative('claude-opus-5', calls)

    await send({
      model: 'claude-opus-5',
      max_tokens: 256,
      output_config: {
        format: { type: 'json_schema', schema, name: 'my_output' },
      },
      messages: [{ role: 'user', content: 'hi' }],
    })

    // Anthropic documents no effect on the reply, and the Responses translator
    // has to invent one when the caller omits it — dropping it costs nothing.
    expect(calls[0]?.payload.output_config?.format).toEqual({ type: 'json_schema', schema })
  })

  test('leaves description requests off the native path rather than stripping them', async () => {
    // Native rejects `description` as an extra input (probed 2026-07-26), but
    // unlike `name` it steers the model's output — so reducing it silently
    // would change the reply the caller gets.
    cacheModel('claude-opus-5', true)

    const response = await send({
      model: 'claude-opus-5',
      max_tokens: 256,
      output_config: {
        format: { type: 'json_schema', schema, description: 'Answer in one word.' },
      },
      messages: [{ role: 'user', content: 'hi' }],
    })

    const json = await response.json() as { error?: { code?: string } }
    expect(response.status).toBe(400)
    expect(json.error?.code).toBe('unsupported_output_config_format')
  })

  test('keeps output_config.format when no effort is set', async () => {
    // sanitizeOutputConfig deletes the container on a null effort. A structured
    // output request usually sends no effort at all, so that path would have
    // dropped the schema silently.
    cacheModel('claude-opus-5', true)
    const calls: Array<CapturedMessagesCall> = []
    mockNative('claude-opus-5', calls)

    await send({
      model: 'claude-opus-5',
      max_tokens: 256,
      output_config: { effort: null, format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(calls[0]?.payload.output_config?.format).toEqual({ type: 'json_schema', schema })
    expect(calls[0]?.payload.output_config?.effort).toBeUndefined()
  })

  test('leaves strict requests off the native path', async () => {
    // `strict` is a promise about the reply, and native rejects the key. Serving
    // it natively would mean silently dropping the guarantee, so the request
    // stays for a path that can carry it — here none, so the explicit 400 holds.
    cacheModel('claude-opus-5', true)

    const response = await send({
      model: 'claude-opus-5',
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema, strict: true } },
      messages: [{ role: 'user', content: 'hi' }],
    })

    const json = await response.json() as { error?: { code?: string } }
    expect(response.status).toBe(400)
    expect(json.error?.code).toBe('unsupported_output_config_format')
  })

  test('does not use native for a model that does not advertise structured_outputs', async () => {
    cacheModel('claude-legacy', false)

    const response = await send({
      model: 'claude-legacy',
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.status).toBe(400)
  })
})

describe('supportsStructuredOutputs excludes Vertex-blocked models', () => {
  // claude-opus-4.7 and claude-sonnet-4.6 advertise structured_outputs: true,
  // but a GCP organization policy blocks the feature for their Vertex-served
  // deployment (probed 2026-07-26). The advertised flag alone would route them
  // onto a path that 400s upstream.
  test('returns false for a model blocked by the Vertex org policy', () => {
    const blocked = buildModel('claude-opus-4.7', { supported_endpoints: ['/v1/messages'] })
    blocked.capabilities.supports.structured_outputs = true

    expect(modelCache.supportsStructuredOutputs(blocked)).toBe(false)
  })

  test('returns true for a model that advertises it and is not blocked', () => {
    const allowed = buildModel('claude-opus-5', { supported_endpoints: ['/v1/messages'] })
    allowed.capabilities.supports.structured_outputs = true

    expect(modelCache.supportsStructuredOutputs(allowed)).toBe(true)
  })

  test('returns false when the model does not advertise it', () => {
    const plain = buildModel('claude-legacy', { supported_endpoints: ['/v1/messages'] })
    plain.capabilities.supports.structured_outputs = false

    expect(modelCache.supportsStructuredOutputs(plain)).toBe(false)
  })
})
