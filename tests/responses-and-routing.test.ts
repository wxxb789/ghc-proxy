import type { ServerSentEventMessage } from 'fetch-event-stream'
import type { CapiChatCompletionResponse, CapiChatCompletionsPayload } from '~/core/capi'
import type { AnthropicMessagesPayload, AnthropicResponse } from '~/translator'
import type { Model, ModelsResponse, ResponsesPayload, ResponsesResult, ResponseStreamEvent } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'

import { CopilotClient } from '~/clients'
import { getCachedConfig } from '~/lib/config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { createMessageRoutes } from '~/routes/messages/route'
import { createResponsesRoutes } from '~/routes/responses/route'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { translateAnthropicToResponsesPayload } from '~/translator/responses/anthropic-to-responses'
import { ResponsesStreamTranslator } from '~/translator/responses/responses-stream-translator'

type CreateResponses = typeof CopilotClient.prototype.createResponses
type CreateMessages = typeof CopilotClient.prototype.createMessages
type CreateChatCompletions = typeof CopilotClient.prototype.createChatCompletions
type GetResponse = typeof CopilotClient.prototype.getResponse
type GetResponseInputItems = typeof CopilotClient.prototype.getResponseInputItems
type CreateResponseInputTokens = typeof CopilotClient.prototype.createResponseInputTokens
type DeleteResponse = typeof CopilotClient.prototype.deleteResponse

const originalCreateResponses = CopilotClient.prototype.createResponses
const originalCreateMessages = CopilotClient.prototype.createMessages
const originalCreateChatCompletions = CopilotClient.prototype.createChatCompletions
const originalGetResponse = CopilotClient.prototype.getResponse
const originalGetResponseInputItems = CopilotClient.prototype.getResponseInputItems
const originalCreateResponseInputTokens = CopilotClient.prototype.createResponseInputTokens
const originalDeleteResponse = CopilotClient.prototype.deleteResponse
const originalState = {
  auth: { ...state.auth },
  config: { ...state.config },
  cache: { ...state.cache },
  rateLimit: { ...state.rateLimit },
}
const originalConfig = structuredClone(getCachedConfig())

interface CapturedResponsesCall {
  payload: ResponsesPayload
}

interface CapturedMessagesCall {
  payload: AnthropicMessagesPayload
}

interface CapturedChatCall {
  payload: CapiChatCompletionsPayload
}

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

function buildModel(id: string, supportedEndpoints?: Array<string>): Model {
  return {
    id,
    model_picker_enabled: true,
    name: id,
    object: 'model',
    preview: false,
    vendor: 'openai',
    version: '1',
    supported_endpoints: supportedEndpoints,
    capabilities: {
      family: 'gpt',
      limits: {
        max_context_window_tokens: 200000,
        max_output_tokens: 8192,
        max_prompt_tokens: 180000,
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
  }
}

function buildVisionModel(id: string, supportedEndpoints?: Array<string>): Model {
  const model = buildModel(id, supportedEndpoints)
  model.capabilities.supports.vision = true
  model.capabilities.limits.vision = {
    max_prompt_image_size: 3145728,
    max_prompt_images: 1,
    supported_media_types: ['image/png'],
  }
  return model
}

function buildModelsResponse(...models: Array<Model>): ModelsResponse {
  return {
    object: 'list',
    data: models,
  }
}

function createApp() {
  return new Elysia()
    .error({ HTTP: HTTPError })
    .onError(({ code, error }) => {
      if (code === 'HTTP')
        return
      if (error instanceof Error && error.name === 'AbortError') {
        return Response.json(
          { error: { message: 'Upstream request was aborted', type: 'timeout_error' } },
          { status: 504 },
        )
      }
      const message = error instanceof Error ? error.message : String(error)
      return Response.json(
        { error: { message, type: 'error' } },
        { status: 500 },
      )
    })
    .group('/v1', (app) => {
      return app
        .use(createMessageRoutes())
        .use(createResponsesRoutes())
    })
}

function mockResponses(
  response: ResponsesResult | AsyncGenerator<ServerSentEventMessage, void, unknown>,
  calls: Array<CapturedResponsesCall>,
): CreateResponses {
  return ((payload) => {
    calls.push({ payload })
    return Promise.resolve(response)
  }) as CreateResponses
}

function mockMessages(
  response: AnthropicResponse | AsyncGenerator<ServerSentEventMessage, void, unknown>,
  calls: Array<CapturedMessagesCall>,
): CreateMessages {
  return ((payload) => {
    calls.push({ payload })
    return Promise.resolve(response)
  }) as CreateMessages
}

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

beforeEach(() => {
  state.auth.copilotToken = 'test-token'
  state.cache.vsCodeVersion = '1.99.0'
  state.cache.models = buildModelsResponse()
  state.config.accountType = 'individual'
  state.config.manualApprove = false
  state.config.rateLimitSeconds = undefined
  state.config.rateLimitWait = false
  state.config.showToken = false
  state.config.upstreamTimeoutSeconds = undefined
  state.rateLimit.lastRequestTimestamp = undefined

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
  state.auth = { ...originalState.auth }
  state.config = { ...originalState.config }
  state.cache = { ...originalState.cache }
  state.rateLimit = { ...originalState.rateLimit }

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
    state.cache.models = buildModelsResponse(buildModel('gpt-4.1', ['/responses']))

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
    })
  })

  test('/v1/responses rejects unsupported builtin tools explicitly', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    state.cache.models = buildModelsResponse(buildModel('gpt-4.1', ['/responses']))

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

  test('/v1/responses rejects external image URLs explicitly', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    state.cache.models = buildModelsResponse(buildVisionModel('gpt-5', ['/responses']))

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
    state.cache.models = buildModelsResponse(buildModel('gpt-4.1', ['/responses']))

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

  test('/v1/messages uses responses translation path for responses-only models', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    state.cache.models = buildModelsResponse(buildModel('gpt-5', ['/responses']))

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
  })

  test('/v1/messages uses native messages path when model supports it', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    state.cache.models = buildModelsResponse(buildModel('claude-sonnet-4.5', ['/v1/messages']))

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

  test('/v1/messages native messages path preserves explicit thinking configuration', async () => {
    const app = createApp()
    const calls: Array<CapturedMessagesCall> = []
    state.cache.models = buildModelsResponse(buildModel('claude-sonnet-4.5', ['/v1/messages']))

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
        thinking: { type: 'disabled' },
        output_config: { effort: 'max' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.thinking).toEqual({ type: 'disabled' })
    expect(calls[0]?.payload.output_config).toEqual({ effort: 'max' })
  })

  test('compact and warmup routing can move /v1/messages to configured small model', async () => {
    const app = createApp()
    const chatCalls: Array<CapturedChatCall> = []
    state.cache.models = buildModelsResponse(
      buildModel('claude-opus-4.6'),
      buildModel('gpt-4.1-mini'),
    )

    const config = getCachedConfig()
    config.smallModel = 'gpt-4.1-mini'
    config.compactUseSmallModel = true
    config.warmupUseSmallModel = true

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
        'anthropic-beta': 'claude-code-warmup',
      },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    }))

    expect(chatCalls[0]?.payload.model).toBe('gpt-4.1-mini')
  })

  test('small-model routing preserves vision capability requirements', async () => {
    const app = createApp()
    const chatCalls: Array<CapturedChatCall> = []
    state.cache.models = buildModelsResponse(
      buildVisionModel('claude-opus-4.6'),
      buildModel('gpt-4.1-mini'),
    )

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
    state.cache.models = buildModelsResponse(buildModel('gpt-5', ['/responses']))

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
