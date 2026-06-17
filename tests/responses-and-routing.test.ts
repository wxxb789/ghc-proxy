import type { ServerSentEventMessage } from 'fetch-event-stream'
import type { CapturedChatCall, CapturedMessagesCall, CapturedResponsesCall } from './helpers'
import type { CapiChatCompletionResponse } from '~/core/capi'
import type { AnthropicResponse } from '~/translator'
import type { ResponsesResult, ResponseStreamEvent } from '~/types'

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { getCachedConfig } from '~/lib/config'
import { HTTPError } from '~/lib/error'
import { authStore, modelCache, responsesEmulatorState } from '~/state'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { translateAnthropicToResponsesPayload } from '~/translator/responses/anthropic-to-responses'

import { ResponsesStreamTranslator } from '~/translator/responses/responses-stream-translator'

import {
  buildModel,
  buildModelsResponse,
  buildResponsesResult,
  buildVisionModel,
  createApp,
  mockMessages,
  mockResponses,
  parseSse,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

// ── Types unique to this test file ──

type CreateMessages = typeof CopilotClient.prototype.createMessages
type CreateChatCompletions = typeof CopilotClient.prototype.createChatCompletions
type CreateResponses = typeof CopilotClient.prototype.createResponses
type GetResponse = typeof CopilotClient.prototype.getResponse
type GetResponseInputItems = typeof CopilotClient.prototype.getResponseInputItems
type CreateResponseInputTokens = typeof CopilotClient.prototype.createResponseInputTokens
type DeleteResponse = typeof CopilotClient.prototype.deleteResponse

interface CapturedGetResponseCall {
  responseId: string
  params?: Record<string, unknown>
}

interface CapturedGetResponseInputItemsCall {
  responseId: string
  params?: {
    after?: string
    include?: Array<string>
    limit?: number
    order?: 'asc' | 'desc'
  }
}

interface CapturedCreateResponseInputTokensCall {
  payload: Record<string, unknown>
}

interface CapturedDeleteResponseCall {
  responseId: string
}

// ── Mock factories unique to this test file ──

function mockChatCompletions(
  response: CapiChatCompletionResponse,
  calls: Array<CapturedChatCall>,
): CreateChatCompletions {
  return ((payload) => {
    calls.push({ payload })
    return Promise.resolve(response)
  }) as CreateChatCompletions
}

function mockGetResponse(
  response: Record<string, unknown>,
  calls: Array<CapturedGetResponseCall>,
): GetResponse {
  return ((responseId, options) => {
    calls.push({ responseId, params: options?.params as Record<string, unknown> | undefined })
    return Promise.resolve(response)
  }) as GetResponse
}

function mockGetResponseInputItems(
  response: Record<string, unknown>,
  calls: Array<CapturedGetResponseInputItemsCall>,
): GetResponseInputItems {
  return ((responseId, params) => {
    calls.push({ responseId, params })
    return Promise.resolve(response)
  }) as GetResponseInputItems
}

function mockCreateResponseInputTokens(
  response: Record<string, unknown>,
  calls: Array<CapturedCreateResponseInputTokensCall>,
): CreateResponseInputTokens {
  return ((payload) => {
    calls.push({ payload: payload as Record<string, unknown> })
    return Promise.resolve(response)
  }) as CreateResponseInputTokens
}

function mockDeleteResponse(
  response: Record<string, unknown>,
  calls: Array<CapturedDeleteResponseCall>,
): DeleteResponse {
  return ((responseId) => {
    calls.push({ responseId })
    return Promise.resolve(response)
  }) as DeleteResponse
}

function enableOfficialResponsesEmulator(ttlSeconds = 4 * 60 * 60) {
  const config = getCachedConfig() as Record<string, unknown>
  config.responsesOfficialEmulator = true
  config.responsesOfficialEmulatorTtlSeconds = ttlSeconds
}

function rejectUnexpectedEmulatorResourceCalls() {
  const reject = (method: string) => {
    throw new Error(`Unexpected upstream ${method} call while responsesOfficialEmulator is enabled`)
  }

  CopilotClient.prototype.getResponse = ((..._args: Array<unknown>) => reject('getResponse')) as GetResponse
  CopilotClient.prototype.getResponseInputItems = ((..._args: Array<unknown>) => reject('getResponseInputItems')) as GetResponseInputItems
  CopilotClient.prototype.createResponseInputTokens = ((..._args: Array<unknown>) => reject('createResponseInputTokens')) as CreateResponseInputTokens
  CopilotClient.prototype.deleteResponse = ((..._args: Array<unknown>) => reject('deleteResponse')) as DeleteResponse
}

function mockEmulatorCreateResponses(
  responses: Array<Partial<ResponsesResult> | AsyncGenerator<ServerSentEventMessage, void, unknown>>,
  calls: Array<CapturedResponsesCall>,
): CreateResponses {
  return ((payload: CapturedResponsesCall['payload'], options?: CapturedResponsesCall['options']) => {
    calls.push({ payload, options })
    const next = responses.shift()
    if (!next) {
      throw new Error('No mocked emulator response left for createResponses')
    }
    if (isServerSentEventStream(next)) {
      return Promise.resolve(next)
    }
    return Promise.resolve(buildResponsesResult(next as Partial<ResponsesResult>))
  }) as unknown as CreateResponses
}

function isServerSentEventStream(
  value: unknown,
): value is AsyncGenerator<ServerSentEventMessage, void, unknown> {
  return typeof value === 'object'
    && value !== null
    && 'next' in value
    && typeof value.next === 'function'
}

// ── State setup / teardown ──

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

  const config = getCachedConfig()
  for (const key of Object.keys(config)) {
    delete (config as Record<string, unknown>)[key]
  }
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

  const config = getCachedConfig()
  for (const key of Object.keys(config)) {
    delete (config as Record<string, unknown>)[key]
  }
  Object.assign(config, structuredClone(originalConfig))
})

describe('responses and routing', () => {
  test('/v1/responses transforms apply_patch before forwarding', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
      output: [],
      output_text: 'ok',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [
          { type: 'custom', name: 'apply_patch' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools).toHaveLength(1)
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
      type: 'function',
      name: 'apply_patch',
      strict: false,
    })
  })

  test('/v1/responses defaults function tool strict to true', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
      output: [],
      output_text: 'ok',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [
          {
            type: 'function',
            name: 'get_weather',
            parameters: { type: 'object' },
          },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
      type: 'function',
      name: 'get_weather',
      strict: true,
    })
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
      parameters: {
        type: 'object',
        required: [],
      },
    })
  })

  test('/v1/responses normalizes function parameter required arrays for Copilot', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
      output: [],
      output_text: 'ok',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [
          {
            type: 'function',
            name: 'Bash',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string' },
                timeout: { type: 'number' },
              },
              required: ['command'],
            },
          },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
      type: 'function',
      name: 'Bash',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          timeout: { type: 'number' },
        },
        required: ['command', 'timeout'],
      },
      strict: true,
    })
  })

  test('/v1/responses strips unsupported JSON Schema format annotations from function tools', async () => {
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
          name: 'WebFetch',
          parameters: {
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
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
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
    })
    expect(JSON.stringify(calls[0]?.payload.tools?.[0])).not.toContain('"format"')
  })

  test('/v1/responses strips upstream-incompatible schema metadata from function tools', async () => {
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
          name: 'WebFetch',
          parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
              url: {
                type: 'string',
                title: 'URL',
                description: 'Fetch target',
                example: 'https://example.com',
                examples: ['https://example.com'],
                default: 'https://example.com',
                deprecated: false,
                readOnly: false,
                writeOnly: false,
                contentEncoding: 'utf-8',
                contentMediaType: 'text/plain',
              },
            },
          },
        }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
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
    })

    const serialized = JSON.stringify(calls[0]?.payload.tools?.[0])
    expect(serialized).not.toContain('"$schema"')
    expect(serialized).not.toContain('"title"')
    expect(serialized).not.toContain('"example"')
    expect(serialized).not.toContain('"examples"')
    expect(serialized).not.toContain('"default"')
    expect(serialized).not.toContain('"deprecated"')
    expect(serialized).not.toContain('"readOnly"')
    expect(serialized).not.toContain('"writeOnly"')
    expect(serialized).not.toContain('"contentEncoding"')
    expect(serialized).not.toContain('"contentMediaType"')
  })

  test('/v1/responses does not auto-inject context_management by default', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    const config = getCachedConfig()
    config.responsesApiContextManagementModels = ['gpt-4.1']
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
      output: [],
      output_text: 'ok',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.context_management).toBeUndefined()
  })

  test('/v1/responses auto-injects context_management only when explicitly enabled', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    const config = getCachedConfig()
    config.responsesApiAutoContextManagement = true
    config.responsesApiContextManagementModels = ['gpt-4.1']
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', {
      supported_endpoints: ['/responses'],
      capabilities: {
        family: 'gpt',
        limits: {
          max_context_window_tokens: 200000,
          max_output_tokens: 8192,
          max_prompt_tokens: 120000,
        },
        object: 'model_capabilities',
        supports: {
          tool_calls: true,
          parallel_tool_calls: true,
          adaptive_thinking: true,
        },
        tokenizer: 'o200k_base',
        type: 'chat',
      },
    })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
      output: [],
      output_text: 'ok',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.context_management).toEqual([{
      type: 'compaction',
      compact_threshold: 108000,
    }])
  })

  test('/v1/responses does not compact input by latest compaction by default', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
      output: [],
      output_text: 'ok',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: 'before' },
          { type: 'compaction', id: 'cmp_1', encrypted_content: 'enc_1' },
          { type: 'message', role: 'user', content: 'after' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'before' },
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'enc_1' },
      { type: 'message', role: 'user', content: 'after' },
    ])
  })

  test('/v1/responses compacts input by latest compaction only when explicitly enabled', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    const config = getCachedConfig()
    config.responsesApiAutoCompactInput = true
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
      output: [],
      output_text: 'ok',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: 'before' },
          { type: 'compaction', id: 'cmp_1', encrypted_content: 'enc_1' },
          { type: 'message', role: 'user', content: 'after' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.input).toEqual([
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'enc_1' },
      { type: 'message', role: 'user', content: 'after' },
    ])
  })

  test('/v1/responses rejects unsupported builtin tools explicitly', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_unused',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
      output: [],
      output_text: '',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [
          { type: 'web_search', name: 'web_search_preview' },
        ],
      }),
    }))

    const json = await response.json() as {
      error?: { code?: string, param?: string }
    }
    expect(response.status).toBe(400)
    expect(json.error?.code).toBe('unsupported_tool_web_search')
    expect(json.error?.param).toBe('tools')
    expect(calls).toHaveLength(0)
  })

  test('/v1/responses rejects unsupported web_search tool_choice explicitly', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_unused',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
      output: [],
      output_text: '',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tool_choice: { type: 'web_search_preview' },
      }),
    }))

    const json = await response.json() as {
      error?: { code?: string, param?: string }
    }
    expect(response.status).toBe(400)
    expect(json.error?.code).toBe('unsupported_tool_web_search')
    expect(json.error?.param).toBe('tool_choice')
    expect(calls).toHaveLength(0)
  })

  test('/v1/responses rejects external image URLs explicitly', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildVisionModel('gpt-5', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_unused',
      object: 'response',
      created_at: 1,
      model: 'gpt-5',
      output: [],
      output_text: '',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe this image' },
            { type: 'input_image', image_url: 'https://example.com/image.png', detail: 'low' },
          ],
        }],
      }),
    }))

    const json = await response.json() as {
      error?: { code?: string, param?: string }
    }
    expect(response.status).toBe(400)
    expect(json.error?.code).toBe('unsupported_input_image_remote_url')
    expect(json.error?.param).toBe('input')
    expect(calls).toHaveLength(0)
  })

  test('/v1/responses validates payload shape before mutation', async () => {
    const app = createApp()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: '',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(400)
  })

  test('/v1/responses forces store=false on all upstream requests', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_store',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    // Client sends store=true, but the proxy must override to false
    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        store: true,
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.store).toBe(false)
  })

  test('/v1/responses forces store=false even when client omits it', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_store_default',
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
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.store).toBe(false)
  })

  test('/v1/responses strips item_reference items from input', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_strip_ref',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: 'hello' },
          { type: 'item_reference', id: 'msg_fake_ref_001' },
          { type: 'item_reference', id: 'msg_fake_ref_002' },
          { type: 'message', role: 'user', content: 'follow up' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'user', content: 'follow up' },
    ])
  })

  test('/v1/responses strips orphaned function_call_output items from input', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_strip_orphan',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: 'hello' },
          // This function_call has a matching output — both should survive
          { type: 'function_call', call_id: 'call_1', name: 'test', arguments: '{}', status: 'completed' },
          { type: 'function_call_output', call_id: 'call_1', output: 'result 1' },
          // This output has no matching function_call — should be stripped
          { type: 'function_call_output', call_id: 'call_orphan', output: 'orphan result' },
          { type: 'message', role: 'user', content: 'continue' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'function_call', call_id: 'call_1', name: 'test', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result 1' },
      { type: 'message', role: 'user', content: 'continue' },
    ])
  })

  test('/v1/responses strips both item_reference and orphaned function_call_output together', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_strip_combo',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: 'hello' },
          { type: 'item_reference', id: 'msg_ref_1' },
          { type: 'function_call_output', call_id: 'call_gone', output: 'stale' },
          { type: 'message', role: 'user', content: 'continue' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'user', content: 'continue' },
    ])
  })

  test('/v1/responses strips phase field from input message items', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_strip_phase',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: 'hello', phase: 'commentary' },
          { type: 'message', role: 'assistant', content: 'hi', phase: 'final_answer' },
          { type: 'message', role: 'user', content: 'follow up' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    const forwardedInput = calls[0]?.payload.input as Array<Record<string, unknown>>
    expect(forwardedInput).toHaveLength(3)
    // phase should be stripped from all items that had it
    for (const item of forwardedInput) {
      expect(item).not.toHaveProperty('phase')
    }
    // Other fields should be preserved
    expect(forwardedInput[0]).toMatchObject({ type: 'message', role: 'user', content: 'hello' })
    expect(forwardedInput[1]).toMatchObject({ type: 'message', role: 'assistant', content: 'hi' })
    expect(forwardedInput[2]).toMatchObject({ type: 'message', role: 'user', content: 'follow up' })
  })

  test('/v1/responses preserves input when no stripping is needed', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_no_strip',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: 'hello' },
          { type: 'function_call', call_id: 'call_1', name: 'test', arguments: '{}', status: 'completed' },
          { type: 'function_call_output', call_id: 'call_1', output: 'result' },
          { type: 'message', role: 'user', content: 'next' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'function_call', call_id: 'call_1', name: 'test', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
      { type: 'message', role: 'user', content: 'next' },
    ])
  })

  test('/v1/responses surfaces upstream 400 errors without requiring payload dumps', async () => {
    const app = createApp()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    // Mock createResponses to throw HTTPError(400) so the route still surfaces
    // the upstream error when failed payload dumps are disabled by default.
    CopilotClient.prototype.createResponses = (() => {
      throw new HTTPError(400, {
        error: { message: 'Invalid request', type: 'invalid_request_error' },
      })
    }) as typeof CopilotClient.prototype.createResponses

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(400)
    const json = await response.json() as { error?: { message?: string } }
    expect(json.error?.message).toBe('Invalid request')
  })

  test('/v1/responses consumes subagent markers and forwards root session context', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
      output: [],
      output_text: 'ok',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': 'root-session-1',
      },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{
          type: 'message',
          role: 'user',
          content: `<system-reminder>\nSubagentStart hook additional context: __SUBAGENT_MARKER__{"session_id":"subagent-session-1","agent_id":"subagent-session-1","agent_type":"opencode-subagent"}\n</system-reminder>\nhello`,
        }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options?.initiator).toBe('agent')
    expect(calls[0]?.options?.requestContext).toMatchObject({
      interactionType: 'conversation-subagent',
      agentTaskId: 'subagent-session-1',
      clientSessionId: 'root-session-1',
    })
    expect(calls[0]?.payload.input).toEqual([{
      type: 'message',
      role: 'user',
      content: 'hello',
    }])
  })

  test('/v1/responses supports retrieve/input_items/delete/input_tokens operations', async () => {
    const app = createApp()
    const inputItemsCalls: Array<CapturedGetResponseInputItemsCall> = []
    const inputTokensCalls: Array<CapturedCreateResponseInputTokensCall> = []
    const getCalls: Array<CapturedGetResponseCall> = []
    const deleteCalls: Array<CapturedDeleteResponseCall> = []

    CopilotClient.prototype.getResponseInputItems = mockGetResponseInputItems({
      object: 'list',
      data: [{ type: 'message', role: 'user', content: 'hello' }],
      has_more: false,
    }, inputItemsCalls)
    CopilotClient.prototype.createResponseInputTokens = mockCreateResponseInputTokens({
      object: 'response.input_tokens',
      input_tokens: 12,
    }, inputTokensCalls)
    CopilotClient.prototype.getResponse = mockGetResponse({
      id: 'resp_123',
      object: 'response',
      status: 'completed',
      model: 'gpt-5',
      created_at: 1,
      output: [],
      output_text: '',
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
    }, getCalls)
    CopilotClient.prototype.deleteResponse = mockDeleteResponse({
      id: 'resp_123',
      object: 'response.deleted',
      deleted: true,
    }, deleteCalls)

    const inputItemsResponse = await app.handle(new Request('http://localhost/v1/responses/resp_123/input_items?limit=2&order=desc&include=reasoning.encrypted_content,file_search_call.results', {
      method: 'GET',
    }))
    expect(inputItemsResponse.status).toBe(200)
    expect(inputItemsCalls[0]).toEqual({
      responseId: 'resp_123',
      params: {
        include: ['reasoning.encrypted_content', 'file_search_call.results'],
        limit: 2,
        order: 'desc',
        after: undefined,
      },
    })

    const getResponse = await app.handle(new Request('http://localhost/v1/responses/resp_123?include=reasoning.encrypted_content&include_obfuscation=true&starting_after=3&stream=false', {
      method: 'GET',
    }))
    expect(getResponse.status).toBe(200)
    expect(getCalls[0]).toEqual({
      responseId: 'resp_123',
      params: {
        include: ['reasoning.encrypted_content'],
        include_obfuscation: true,
        starting_after: 3,
        stream: false,
      },
    })

    const inputTokensResponse = await app.handle(new Request('http://localhost/v1/responses/input_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))
    expect(inputTokensResponse.status).toBe(200)
    expect(inputTokensCalls[0]?.payload).toMatchObject({
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    })

    const deleteResponse = await app.handle(new Request('http://localhost/v1/responses/resp_123', {
      method: 'DELETE',
    }))
    expect(deleteResponse.status).toBe(200)
    expect(deleteCalls[0]).toEqual({
      responseId: 'resp_123',
    })
  })

  test('/v1/responses resource validation rejects invalid query parameters', async () => {
    const app = createApp()

    const limitResponse = await app.handle(new Request('http://localhost/v1/responses/resp_123/input_items?limit=0', {
      method: 'GET',
    }))
    expect(limitResponse.status).toBe(400)

    const orderResponse = await app.handle(new Request('http://localhost/v1/responses/resp_123/input_items?order=sideways', {
      method: 'GET',
    }))
    expect(orderResponse.status).toBe(400)

    const startingAfterResponse = await app.handle(new Request('http://localhost/v1/responses/resp_123?starting_after=-1', {
      method: 'GET',
    }))
    expect(startingAfterResponse.status).toBe(400)

    const booleanResponse = await app.handle(new Request('http://localhost/v1/responses/resp_123?stream=maybe', {
      method: 'GET',
    }))
    expect(booleanResponse.status).toBe(400)
  })

  test('/v1/responses official emulator persists create, retrieve, and input_items state', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    const createCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_emu_1',
        model: 'gpt-5',
        status: 'completed',
        output: [{
          id: 'msg_emu_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'world', annotations: [] }],
        }],
        output_text: 'world',
        usage: null,
      }),
    ], createCalls)

    const createResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    const created = await createResponse.json() as ResponsesResult
    expect(createResponse.status).toBe(200)
    expect(created).toMatchObject({
      id: 'resp_emu_1',
      object: 'response',
      model: 'gpt-5',
      previous_response_id: null,
      store: true,
    })
    expect(created.conversation).toBeTruthy()
    expect(createCalls[0]?.payload.input).toEqual([{
      type: 'message',
      role: 'user',
      content: 'hello',
    }])
    expect(createCalls[0]?.payload.previous_response_id).toBeUndefined()
    expect(createCalls[0]?.payload.conversation).toBeUndefined()

    const retrieveResponse = await app.handle(new Request('http://localhost/v1/responses/resp_emu_1', {
      method: 'GET',
    }))

    const retrieved = await retrieveResponse.json() as ResponsesResult
    expect(retrieveResponse.status).toBe(200)
    expect(retrieved.id).toBe('resp_emu_1')
    expect(retrieved.conversation).toEqual(created.conversation)

    const inputItemsResponse = await app.handle(new Request('http://localhost/v1/responses/resp_emu_1/input_items?limit=10&order=asc', {
      method: 'GET',
    }))

    const inputItems = await inputItemsResponse.json() as {
      object?: string
      data?: Array<{ type?: string, role?: string, content?: string }>
      first_id?: string | null
      last_id?: string | null
      has_more?: boolean
    }
    expect(inputItemsResponse.status).toBe(200)
    expect(inputItems).toEqual({
      object: 'list',
      data: [{
        type: 'message',
        role: 'user',
        content: 'hello',
      }],
      first_id: null,
      last_id: null,
      has_more: false,
    })
  })

  test('/v1/responses official emulator returns decorated create results even when store=false', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_emu_nostore',
        model: 'gpt-5',
        status: 'completed',
        output_text: 'ok',
        usage: null,
      }),
    ], [])

    const createResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        store: false,
        input: [{ type: 'message', role: 'user', content: 'ephemeral' }],
      }),
    }))

    const created = await createResponse.json() as ResponsesResult
    expect(createResponse.status).toBe(200)
    expect(created).toMatchObject({
      id: 'resp_emu_nostore',
      previous_response_id: null,
      store: false,
    })
    expect(created.conversation).toBeTruthy()

    const retrieveResponse = await app.handle(new Request('http://localhost/v1/responses/resp_emu_nostore', {
      method: 'GET',
    }))
    const inputItemsResponse = await app.handle(new Request('http://localhost/v1/responses/resp_emu_nostore/input_items', {
      method: 'GET',
    }))
    expect(retrieveResponse.status).toBe(404)
    expect(inputItemsResponse.status).toBe(404)
  })

  test('/v1/responses official emulator persists streamed terminal responses for later retrieval', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    const createCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([(
      async function* () {
        yield {
          event: 'response.created',
          data: JSON.stringify({
            type: 'response.created',
            sequence_number: 1,
            response: buildResponsesResult({
              id: 'resp_stream_1',
              model: 'gpt-5',
              status: 'in_progress',
              output_text: '',
              usage: {
                input_tokens: 1,
                output_tokens: 0,
                total_tokens: 1,
              },
            }),
          } satisfies ResponseStreamEvent),
        }
        yield {
          event: 'response.completed',
          data: JSON.stringify({
            type: 'response.completed',
            sequence_number: 2,
            response: buildResponsesResult({
              id: 'resp_stream_1',
              model: 'gpt-5',
              status: 'completed',
              output: [{
                id: 'msg_stream_1',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'streamed', annotations: [] }],
              }],
              output_text: 'streamed',
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                total_tokens: 2,
              },
            }),
          } satisfies ResponseStreamEvent),
        }
      }
    )()], createCalls)

    const createResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        stream: true,
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    const body = await createResponse.text()
    expect(createResponse.status).toBe(200)
    const events = parseSse(body)
    const createdEvent = events.find(event => event.event === 'response.created')
    const completedEvent = events.find(event => event.event === 'response.completed')
    const createdPayload = createdEvent?.data ? JSON.parse(createdEvent.data) as ResponseStreamEvent : undefined
    const completedPayload = completedEvent?.data ? JSON.parse(completedEvent.data) as ResponseStreamEvent : undefined
    expect(createdPayload?.type).toBe('response.created')
    expect(completedPayload?.type).toBe('response.completed')
    expect((createdPayload as Extract<ResponseStreamEvent, { type: 'response.created' }>)?.response.conversation).toBeTruthy()
    expect((createdPayload as Extract<ResponseStreamEvent, { type: 'response.created' }>)?.response.conversation).toEqual(
      (completedPayload as Extract<ResponseStreamEvent, { type: 'response.completed' }>)?.response.conversation,
    )
    expect((completedPayload as Extract<ResponseStreamEvent, { type: 'response.completed' }>)?.response.store).toBe(true)

    const retrieveResponse = await app.handle(new Request('http://localhost/v1/responses/resp_stream_1', {
      method: 'GET',
    }))
    const retrieved = await retrieveResponse.json() as ResponsesResult

    expect(retrieveResponse.status).toBe(200)
    expect(retrieved.id).toBe('resp_stream_1')
    expect(retrieved.output_text).toBe('streamed')
    expect(retrieved.status).toBe('completed')
    expect(retrieved.conversation).toEqual(
      (createdPayload as Extract<ResponseStreamEvent, { type: 'response.created' }>)?.response.conversation,
    )
    expect(createCalls).toHaveLength(1)
  })

  test('/v1/responses official emulator allows continuing from the conversation emitted in streamed created events', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    const createCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      (
        async function* () {
          yield {
            event: 'response.created',
            data: JSON.stringify({
              type: 'response.created',
              sequence_number: 0,
              response: buildResponsesResult({
                id: 'resp_stream_continue_1',
                model: 'gpt-5',
                status: 'in_progress',
                usage: null,
              }),
            } satisfies ResponseStreamEvent),
          }
          yield {
            event: 'response.completed',
            data: JSON.stringify({
              type: 'response.completed',
              sequence_number: 1,
              response: buildResponsesResult({
                id: 'resp_stream_continue_1',
                model: 'gpt-5',
                status: 'completed',
                output: [{
                  id: 'msg_stream_continue_1',
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'streamed first', annotations: [] }],
                }],
                output_text: 'streamed first',
                usage: null,
              }),
            } satisfies ResponseStreamEvent),
          }
        }
      )(),
      buildResponsesResult({
        id: 'resp_stream_continue_2',
        model: 'gpt-5',
        status: 'completed',
        output_text: 'streamed second',
        usage: null,
      }),
    ], createCalls)

    const firstResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        stream: true,
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))
    const firstEvents = parseSse(await firstResponse.text())
    const createdEvent = firstEvents.find(event => event.event === 'response.created')
    const createdPayload = createdEvent?.data ? JSON.parse(createdEvent.data) as Extract<ResponseStreamEvent, { type: 'response.created' }> : undefined

    expect(createdPayload?.response.conversation).toBeTruthy()

    const secondResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        conversation: createdPayload?.response.conversation,
        input: [{ type: 'message', role: 'user', content: 'follow up' }],
      }),
    }))
    const second = await secondResponse.json() as ResponsesResult

    expect(secondResponse.status).toBe(200)
    expect(second.conversation).toEqual(createdPayload?.response.conversation)
    expect(createCalls[1]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'streamed first' }],
      },
      { type: 'message', role: 'user', content: 'follow up' },
    ])
  })

  test('/v1/responses official emulator continues from previous_response_id', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    const createCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_emu_1',
        model: 'gpt-5',
        status: 'completed',
        output: [{
          id: 'msg_prev_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello back', annotations: [] }],
        }],
        output_text: 'hello back',
        usage: null,
      }),
      buildResponsesResult({
        id: 'resp_emu_2',
        model: 'gpt-5',
        status: 'completed',
        output_text: 'done',
        usage: null,
      }),
    ], createCalls)

    const firstResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))
    const first = await firstResponse.json() as ResponsesResult

    const secondResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        previous_response_id: first.id,
        input: [{ type: 'message', role: 'user', content: 'follow up' }],
      }),
    }))

    const second = await secondResponse.json() as ResponsesResult
    expect(secondResponse.status).toBe(200)
    expect(second.previous_response_id).toBe(first.id)
    expect(second.id).toBe('resp_emu_2')
    expect(second.conversation).toEqual(first.conversation)
    expect(createCalls[1]?.payload.previous_response_id).toBeUndefined()
    expect(createCalls[1]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hello back' }],
      },
      { type: 'message', role: 'user', content: 'follow up' },
    ])

    const inputItemsResponse = await app.handle(new Request('http://localhost/v1/responses/resp_emu_2/input_items?order=asc', {
      method: 'GET',
    }))
    const inputItems = await inputItemsResponse.json() as {
      data?: Array<unknown>
    }

    expect(inputItemsResponse.status).toBe(200)
    expect(inputItems.data).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hello back' }],
      },
      { type: 'message', role: 'user', content: 'follow up' },
    ])
  })

  test('/v1/responses official emulator continues from conversation head when conversation is provided', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    const createCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_conv_1',
        model: 'gpt-5',
        status: 'completed',
        output: [{
          id: 'msg_conv_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'first reply', annotations: [] }],
        }],
        output_text: 'first reply',
        usage: null,
      }),
      buildResponsesResult({
        id: 'resp_conv_2',
        model: 'gpt-5',
        status: 'completed',
        output_text: 'second reply',
        usage: null,
      }),
    ], createCalls)

    const firstResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'turn one' }],
      }),
    }))
    const first = await firstResponse.json() as ResponsesResult

    const secondResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        conversation: first.conversation,
        input: [{ type: 'message', role: 'user', content: 'turn two' }],
      }),
    }))
    const second = await secondResponse.json() as ResponsesResult

    expect(secondResponse.status).toBe(200)
    expect(second.previous_response_id).toBeNull()
    expect(second.conversation).toEqual(first.conversation)
    expect(createCalls[1]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'turn one' },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'first reply' }],
      },
      { type: 'message', role: 'user', content: 'turn two' },
    ])
  })

  test('/v1/responses official emulator rejects unknown previous_response_id before any upstream call', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    const createCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([], createCalls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        previous_response_id: 'resp_missing',
        input: [{ type: 'message', role: 'user', content: 'follow up' }],
      }),
    }))

    expect(response.status).toBe(400)
    expect(createCalls).toHaveLength(0)
  })

  test('/v1/responses official emulator delete semantics remove stored state', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_emu_1',
        model: 'gpt-5',
        status: 'completed',
        usage: null,
      }),
    ], [])

    const createResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))
    const created = await createResponse.json() as ResponsesResult

    const deleteResponse = await app.handle(new Request(`http://localhost/v1/responses/${created.id}`, {
      method: 'DELETE',
    }))
    const deleted = await deleteResponse.json() as {
      id?: string
      object?: string
      deleted?: boolean
    }

    expect(deleteResponse.status).toBe(200)
    expect(deleted).toEqual({
      id: created.id,
      object: 'response.deleted',
      deleted: true,
    })

    const retrieveAfterDelete = await app.handle(new Request(`http://localhost/v1/responses/${created.id}`, {
      method: 'GET',
    }))
    const inputItemsAfterDelete = await app.handle(new Request(`http://localhost/v1/responses/${created.id}/input_items`, {
      method: 'GET',
    }))
    expect(retrieveAfterDelete.status).toBe(404)
    expect(inputItemsAfterDelete.status).toBe(404)
  })

  test('/v1/responses official emulator expires responses after the configured 4h TTL', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator(4 * 60 * 60)
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_emu_1',
        model: 'gpt-5',
        status: 'completed',
        usage: null,
      }),
    ], [])

    const baseTime = new Date('2026-04-02T00:00:00.000Z')
    setSystemTime(baseTime)

    const createResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))
    const created = await createResponse.json() as ResponsesResult

    const deleteBeforeTtl = await app.handle(new Request(`http://localhost/v1/responses/${created.id}`, {
      method: 'GET',
    }))
    expect(deleteBeforeTtl.status).toBe(200)

    setSystemTime(new Date(baseTime.getTime() + (4 * 60 * 60 * 1000) + 1))

    const retrieveAfterTtl = await app.handle(new Request(`http://localhost/v1/responses/${created.id}`, {
      method: 'GET',
    }))
    const inputItemsAfterTtl = await app.handle(new Request(`http://localhost/v1/responses/${created.id}/input_items`, {
      method: 'GET',
    }))

    expect(retrieveAfterTtl.status).toBe(404)
    expect(inputItemsAfterTtl.status).toBe(404)
  })

  test('/v1/responses official emulator rejects background mode explicitly', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        background: true,
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(400)
  })

  test('/v1/responses official emulator paginates input_items after sorting for descending queries', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))

    responsesEmulatorState.setResponse(buildResponsesResult({
      id: 'resp_desc_page',
      model: 'gpt-5',
      conversation: { id: 'conv_desc_page' },
    }))
    responsesEmulatorState.setInputItems('resp_desc_page', [
      { id: 'item_1', type: 'compaction', encrypted_content: 'enc_1' },
      { id: 'item_2', type: 'compaction', encrypted_content: 'enc_2' },
      { id: 'item_3', type: 'compaction', encrypted_content: 'enc_3' },
      { id: 'item_4', type: 'compaction', encrypted_content: 'enc_4' },
    ])

    const response = await app.handle(new Request('http://localhost/v1/responses/resp_desc_page/input_items?order=desc&after=item_3&limit=2', {
      method: 'GET',
    }))
    const payload = await response.json() as {
      data: Array<{ id: string }>
      first_id: string | null
      last_id: string | null
      has_more: boolean
    }

    expect(response.status).toBe(200)
    expect(payload.data.map(item => item.id)).toEqual(['item_2', 'item_1'])
    expect(payload.first_id).toBe('item_2')
    expect(payload.last_id).toBe('item_1')
    expect(payload.has_more).toBe(false)
  })

  test('/v1/responses/input_tokens official emulator estimates tokens from continued history', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_emu_1',
        model: 'gpt-5',
        status: 'completed',
        output: [{
          id: 'msg_token_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'assistant context', annotations: [] }],
        }],
        output_text: 'assistant context',
        usage: null,
      }),
    ], [])

    const firstResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))
    const first = await firstResponse.json() as ResponsesResult

    const tokenResponse = await app.handle(new Request('http://localhost/v1/responses/input_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        previous_response_id: first.id,
        input: [{ type: 'message', role: 'user', content: 'follow up' }],
      }),
    }))

    const tokens = await tokenResponse.json() as {
      object?: string
      input_tokens?: number
    }
    expect(tokenResponse.status).toBe(200)
    expect(tokens.object).toBe('response.input_tokens')
    expect(typeof tokens.input_tokens).toBe('number')
    expect(tokens.input_tokens).toBeGreaterThan(0)
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

describe('ResponsesStreamTranslator', () => {
  test('treats ordinary spaces as part of the function-call whitespace guard', () => {
    const translator = new ResponsesStreamTranslator()
    translator.onEvent({
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
    })
    translator.onEvent({
      type: 'response.output_item.added',
      sequence_number: 2,
      output_index: 0,
      item: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'test',
        arguments: '',
      },
    })

    const events = translator.onEvent({
      type: 'response.function_call_arguments.delta',
      sequence_number: 3,
      output_index: 0,
      item_id: 'call_1',
      delta: '                     ',
    })

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: {
        type: 'api_error',
      },
    })
  })
})
