import type { CapturedChatCall, CapturedResponsesCall } from './helpers'
import type { CapiChatCompletionChunk, CapiChatCompletionResponse } from '~/core/capi'
import type { Model, ResponsesResult, ResponseStreamEvent } from '~/types'

import { Buffer } from 'node:buffer'
import { createConnection } from 'node:net'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { TerminalUpstreamRecoveryError } from '~/clients/upstream-queue'
import { compileAccountRouting } from '~/lib/account-routing'
import { getCachedConfig } from '~/lib/config'
import { HTTPError } from '~/lib/error'
import { createServer } from '~/server'
import {
  authStore,
  configureAccountRuntimes,
  createAccountRuntime,
  getCurrentAccountName,
  modelCache,
  resetAccountRuntimes,
  responsesEmulatorState,
  runtimeStore,
} from '~/state'

import {
  buildModel,
  buildModelsResponse,
  buildResponsesResult,
  clearConfig,
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
const originalGetResponse = CopilotClient.prototype.getResponse
const originalGetResponseInputItems = CopilotClient.prototype.getResponseInputItems
const originalCreateResponseInputTokens = CopilotClient.prototype.createResponseInputTokens
const originalDeleteResponse = CopilotClient.prototype.deleteResponse
const stateSnapshot = saveStateSnapshot()
const originalConfig = structuredClone(getCachedConfig())

beforeEach(() => {
  setupDefaultTestState()
  clearConfig()
  runtimeStore.requests.reset()
})

afterEach(() => {
  CopilotClient.prototype.createChatCompletions = originalCreateChatCompletions
  CopilotClient.prototype.createResponses = originalCreateResponses
  CopilotClient.prototype.getResponse = originalGetResponse
  CopilotClient.prototype.getResponseInputItems = originalGetResponseInputItems
  CopilotClient.prototype.createResponseInputTokens = originalCreateResponseInputTokens
  CopilotClient.prototype.deleteResponse = originalDeleteResponse
  resetAccountRuntimes()
  restoreStateSnapshot(stateSnapshot)
  runtimeStore.requests.reset()
  clearConfig()
  Object.assign(getCachedConfig(), originalConfig)
})

function enableFallback(): void {
  getCachedConfig().responsesChatCompletionsFallback = true
}

function cacheChatModel(
  id = 'chat-only',
  overrides: Partial<Model> = {},
): Model {
  const model = buildModel(id, {
    supported_endpoints: ['/chat/completions'],
    ...overrides,
  })
  modelCache.cacheModels(buildModelsResponse(model))
  return model
}

function cacheNativeModel(
  id = 'native',
  endpoints: Array<string> = ['/responses'],
): Model {
  const model = buildModel(id, { supported_endpoints: endpoints })
  modelCache.cacheModels(buildModelsResponse(model))
  return model
}

function textChatResponse(
  model: string,
  content: string,
  id = 'chat_text',
): CapiChatCompletionResponse {
  return {
    id,
    object: 'chat.completion',
    created: 100,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
      logprobs: null,
    }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 3,
      total_tokens: 14,
    },
  }
}

function toolChatResponse(
  model: string,
  toolCalls: Array<{ id: string, name: string, arguments: string }>,
  id = 'chat_tools',
): CapiChatCompletionResponse {
  return {
    id,
    object: 'chat.completion',
    created: 100,
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map(call => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      },
      finish_reason: 'tool_calls',
      logprobs: null,
    }],
    usage: {
      prompt_tokens: 17,
      completion_tokens: 9,
      total_tokens: 26,
    },
  }
}

function chatChunk(
  model: string,
  delta: Record<string, unknown>,
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null = null,
  usage?: CapiChatCompletionChunk['usage'],
): CapiChatCompletionChunk {
  return {
    id: 'chat_stream',
    object: 'chat.completion.chunk',
    created: 100,
    model,
    choices: [{
      index: 0,
      delta: delta as CapiChatCompletionChunk['choices'][number]['delta'],
      finish_reason: finishReason,
      logprobs: null,
    }],
    ...(usage ? { usage } : {}),
  }
}

function post(
  app: ReturnType<typeof createServer>,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }))
}

async function decodeJson<T>(response: Response): Promise<T> {
  return await response.json() as T
}

function decodeSseEvents(body: string): Array<{ event?: string, payload?: ResponseStreamEvent }> {
  return parseSse(body).map((event) => {
    if (!event.data || event.data === '[DONE]')
      return { event: event.event }
    return {
      event: event.event,
      payload: JSON.parse(event.data) as ResponseStreamEvent,
    }
  })
}

function terminalEvents(events: Array<{ payload?: ResponseStreamEvent }>): Array<ResponseStreamEvent> {
  return events
    .map(event => event.payload)
    .filter((payload): payload is ResponseStreamEvent => Boolean(payload))
    .filter(payload => ['response.completed', 'response.incomplete', 'response.failed'].includes(payload.type))
}

describe('Responses Chat bridge route contract', () => {
  test.each(['/responses', '/v1/responses'])('%s translates text and exposes the Responses envelope', async (path) => {
    enableFallback()
    cacheChatModel()
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(
      textChatResponse('chat-only', 'hello from chat'),
      calls,
    )

    const response = await post(createServer(), path, {
      model: 'chat-only',
      instructions: 'Be concise.',
      input: 'hello',
      temperature: 0.4,
      top_p: 0.8,
    })
    const body = await decodeJson<ResponsesResult>(response)

    expect(response.status).toBe(200)
    expect(body.object).toBe('response')
    expect(body.status).toBe('completed')
    expect(body.model).toBe('chat-only')
    expect(body.output_text).toBe('hello from chat')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.messages).toEqual([
      { role: 'system', content: 'Be concise.', copilot_cache_control: { type: 'ephemeral' } },
      { role: 'user', content: 'hello' },
    ])
    const requests = runtimeStore.requests.snapshot()
    expect([...requests.active, ...requests.recent]).toContainEqual(expect.objectContaining({
      selectedStrategy: 'responses-chat-completions',
      effectiveModel: 'chat-only',
    }))
  })

  test('translates parallel namespaced function calls and reverses the aliases in JSON output', async () => {
    enableFallback()
    cacheChatModel()
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = (async (payload, options) => {
      calls.push({ payload, options })
      const aliases = payload.tools?.map(tool => tool.function.name) ?? []
      return toolChatResponse('chat-only', [
        { id: 'up_weather', name: aliases[0] ?? '', arguments: '{"city":"Paris"}' },
        { id: 'up_docs', name: aliases[1] ?? '', arguments: '{"query":"proxy"}' },
      ])
    }) as typeof CopilotClient.prototype.createChatCompletions

    const response = await post(createServer(), '/v1/responses', {
      model: 'chat-only',
      parallel_tool_calls: true,
      tools: [
        {
          type: 'function',
          name: 'lookup',
          namespace: 'weather',
          description: 'Look up weather.',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
        {
          type: 'function',
          name: 'lookup',
          namespace: 'docs',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
      input: [
        { type: 'message', role: 'user', content: 'Use both tools.' },
        { type: 'function_call', call_id: 'old_weather', name: 'lookup', namespace: 'weather', arguments: '{"city":"Paris"}' },
        { type: 'function_call', call_id: 'old_docs', name: 'lookup', namespace: 'docs', arguments: '{"query":"proxy"}' },
        { type: 'function_call_output', call_id: 'old_docs', output: 'docs result' },
        { type: 'function_call_output', call_id: 'old_weather', output: 'weather result' },
      ],
    })
    const body = await decodeJson<ResponsesResult>(response)

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.parallel_tool_calls).toBe(true)
    expect(calls[0]?.payload.tools).toHaveLength(2)
    expect(calls[0]?.payload.tools?.[0]?.function.name).not.toBe(calls[0]?.payload.tools?.[1]?.function.name)
    expect(calls[0]?.payload.messages.filter(message => message.role === 'tool')).toHaveLength(2)
    expect(body.output.filter(item => item.type === 'function_call')).toHaveLength(2)
    expect(body.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', name: 'lookup', namespace: 'weather', arguments: '{"city":"Paris"}' }),
      expect.objectContaining({ type: 'function_call', name: 'lookup', namespace: 'docs', arguments: '{"query":"proxy"}' }),
    ]))
  })

  test('round-trips a plain custom text tool through the JSON input wrapper', async () => {
    enableFallback()
    cacheChatModel()
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = (async (payload, options) => {
      calls.push({ payload, options })
      const alias = payload.tools?.[0]?.function.name ?? ''
      return toolChatResponse('chat-only', [{
        id: 'up_custom',
        name: alias,
        arguments: JSON.stringify({ input: 'title: hello' }),
      }])
    }) as typeof CopilotClient.prototype.createChatCompletions

    const response = await post(createServer(), '/v1/responses', {
      model: 'chat-only',
      tools: [{ type: 'custom', name: 'write_note', namespace: 'codex' }],
      input: [
        { type: 'message', role: 'user', content: 'Write a note.' },
        { type: 'custom_tool_call', call_id: 'custom_old', name: 'write_note', namespace: 'codex', input: 'title: old' },
        { type: 'custom_tool_call_output', call_id: 'custom_old', output: 'written' },
      ],
    })
    const body = await decodeJson<ResponsesResult>(response)

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    })
    expect(calls[0]?.payload.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: 'custom_old', content: 'written' }),
    ]))
    expect(body.output).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'custom_tool_call',
        name: 'write_note',
        namespace: 'codex',
        input: 'title: hello',
      }),
    ]))
  })

  test('preserves images, sampling, JSON mode, minimal reasoning, user, and explicit false parallel calls', async () => {
    enableFallback()
    const model = cacheChatModel('vision-chat', {
      capabilities: {
        ...buildModel('vision-chat').capabilities,
        supports: {
          ...buildModel('vision-chat').capabilities.supports,
          vision: true,
          reasoning_effort: ['minimal'],
          structured_outputs: false,
        },
      },
    })
    model.capabilities.limits.vision = { max_prompt_images: 2, supported_media_types: ['image/png'] }
    modelCache.cacheModels(buildModelsResponse(model))
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(
      textChatResponse('vision-chat', '{"ok":true}'),
      calls,
    )

    const response = await post(createServer(), '/v1/responses', {
      model: 'vision-chat',
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Inspect these.' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
          { type: 'input_image', image_url: 'https://example.test/image.png', detail: 'low' },
        ],
      }],
      temperature: 0.2,
      top_p: 0.7,
      max_output_tokens: 12,
      parallel_tool_calls: false,
      reasoning: { effort: 'minimal' },
      text: { format: { type: 'json_object' } },
      user: 'user-1',
      prompt_cache_key: 'cache-1',
    })
    const body = await decodeJson<ResponsesResult>(response)

    expect(response.status).toBe(200)
    expect(body.output_text).toBe('{"ok":true}')
    expect(calls[0]?.payload).toMatchObject({
      model: 'vision-chat',
      temperature: 0.2,
      top_p: 0.7,
      max_tokens: 12,
      parallel_tool_calls: false,
      reasoning_effort: 'minimal',
      response_format: { type: 'json_object' },
      user: 'user-1',
    })
    expect(calls[0]?.payload).not.toHaveProperty('prompt_cache_key')
    expect(calls[0]?.payload.messages[0]?.content).toEqual([
      { type: 'text', text: 'Inspect these.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } },
      { type: 'image_url', image_url: { url: 'https://example.test/image.png', detail: 'low' } },
    ])
  })

  test('keeps PR82 nullable and optional function output fields on the native dual-endpoint path', async () => {
    enableFallback()
    cacheNativeModel('dual', ['/responses', '/chat/completions'])
    const nativeCalls: Array<CapturedResponsesCall> = []
    const chatCalls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createResponses = mockResponses(
      buildResponsesResult({ model: 'dual', status: 'completed', output_text: 'native' }),
      nativeCalls,
    )
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(
      textChatResponse('dual', 'wrong path'),
      chatCalls,
    )

    const inputItem = {
      type: 'function_call_output',
      id: 'fco_codex_app_1',
      name: 'send_message_to_thread',
      namespace: 'codex_app',
      call_id: null,
      status: null,
      output: 'sent',
    }
    const response = await post(createServer(), '/v1/responses', {
      model: 'dual',
      input: [inputItem],
    })

    expect(response.status).toBe(200)
    expect(nativeCalls).toHaveLength(1)
    expect(chatCalls).toHaveLength(0)
    expect(nativeCalls[0]?.payload.input).toEqual([inputItem])
  })

  test.each([
    {
      name: 'hosted web search',
      body: { tools: [{ type: 'web_search' }], input: 'hello' },
    },
    {
      name: 'compaction input',
      body: { input: [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque' }] },
    },
  ])('rejects unsupported $name before Chat dispatch', async ({ body }) => {
    enableFallback()
    cacheChatModel()
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(
      textChatResponse('chat-only', 'must not run'),
      calls,
    )

    const response = await post(createServer(), '/v1/responses', {
      model: 'chat-only',
      ...body,
    })
    const result = await decodeJson<{ error?: { message?: string } }>(response)

    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
    expect(result.error?.message).toBeTruthy()
  })

  test('rejects strict function tools for a Chat model without structured-output capability', async () => {
    enableFallback()
    const model = cacheChatModel('gemini-chat')
    model.capabilities.supports.structured_outputs = false
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(
      textChatResponse('gemini-chat', 'must not run'),
      calls,
    )

    const response = await post(createServer(), '/v1/responses', {
      model: 'gemini-chat',
      tools: [{
        type: 'function',
        name: 'lookup',
        strict: true,
        parameters: { type: 'object', properties: { key: { type: 'string' } } },
      }],
      input: 'lookup',
    })

    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test.each([
    { name: 'missing call_id', item: { type: 'function_call_output', output: 'orphan' } },
    { name: 'unbound call_id', item: { type: 'function_call_output', call_id: 'missing', output: 'orphan' } },
  ])('rejects $name on the bridge without guessing tool identity', async ({ item }) => {
    enableFallback()
    cacheChatModel()
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(
      textChatResponse('chat-only', 'must not run'),
      calls,
    )

    const response = await post(createServer(), '/v1/responses', {
      model: 'chat-only',
      input: [item],
    })

    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('emulator persists generated function/custom output and reconstructs previous_response_id history', async () => {
    enableFallback()
    getCachedConfig().responsesOfficialEmulator = true
    cacheChatModel()
    const calls: Array<CapturedChatCall> = []
    let turn = 0
    CopilotClient.prototype.createChatCompletions = (async (payload, options) => {
      calls.push({ payload, options })
      if (turn++ > 0)
        return textChatResponse('chat-only', 'continued', 'chat_emu_2')

      const aliases = payload.tools?.map(tool => tool.function.name) ?? []
      return toolChatResponse('chat-only', [
        { id: 'up_fn', name: aliases[0] ?? '', arguments: '{"city":"Paris"}' },
        { id: 'up_custom', name: aliases[1] ?? '', arguments: JSON.stringify({ input: 'freeform' }) },
      ], 'chat_emu_1')
    }) as typeof CopilotClient.prototype.createChatCompletions

    const first = await post(createServer(), '/v1/responses', {
      model: 'chat-only',
      tools: [
        { type: 'function', name: 'lookup', namespace: 'weather', parameters: { type: 'object' } },
        { type: 'custom', name: 'write_note', namespace: 'codex' },
      ],
      input: 'start',
    })
    const firstBody = await decodeJson<ResponsesResult>(first)

    expect(first.status).toBe(200)
    expect(firstBody.store).toBe(true)
    expect(firstBody.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', name: 'lookup', namespace: 'weather' }),
      expect.objectContaining({ type: 'custom_tool_call', name: 'write_note', namespace: 'codex', input: 'freeform' }),
    ]))

    const stored = await createServer().handle(new Request(`http://localhost/v1/responses/${firstBody.id}`))
    const inputItems = await createServer().handle(new Request(`http://localhost/v1/responses/${firstBody.id}/input_items`))
    expect(stored.status).toBe(200)
    expect(inputItems.status).toBe(200)

    const unfinished = await post(createServer(), '/v1/responses', {
      model: 'chat-only',
      previous_response_id: firstBody.id,
      input: 'follow-up without tool results',
    })
    expect(unfinished.status).toBe(400)
    expect(calls).toHaveLength(1)

    const second = await post(createServer(), '/v1/responses', {
      model: 'chat-only',
      previous_response_id: firstBody.id,
      tools: [
        { type: 'function', name: 'lookup', namespace: 'weather', parameters: { type: 'object' } },
        { type: 'custom', name: 'write_note', namespace: 'codex' },
      ],
      input: [
        { type: 'function_call_output', call_id: 'up_fn', output: 'clear weather' },
        { type: 'custom_tool_call_output', call_id: 'up_custom', output: 'saved' },
        { type: 'message', role: 'user', content: 'follow-up' },
      ],
    })
    const secondBody = await second.json() as Record<string, unknown>
    expect(second.status, JSON.stringify(secondBody)).toBe(200)
    expect(secondBody.output_text).toBe('continued')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.payload.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
    expect(calls[1]?.payload.messages.at(-1)?.content).toBe('follow-up')
  })

  test('emulator store=false does not make bridge responses retrievable', async () => {
    enableFallback()
    getCachedConfig().responsesOfficialEmulator = true
    cacheChatModel()
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(
      textChatResponse('chat-only', 'ephemeral', 'chat_nostore'),
      calls,
    )
    CopilotClient.prototype.getResponse = (() => {
      throw new Error('getResponse must not be called when the emulator is enabled')
    }) as typeof CopilotClient.prototype.getResponse
    CopilotClient.prototype.getResponseInputItems = (() => {
      throw new Error('getResponseInputItems must not be called when the emulator is enabled')
    }) as typeof CopilotClient.prototype.getResponseInputItems

    const create = await post(createServer(), '/v1/responses', {
      model: 'chat-only',
      store: false,
      input: 'ephemeral',
    })
    const body = await decodeJson<ResponsesResult>(create)
    const retrieve = await createServer().handle(new Request(`http://localhost/v1/responses/${body.id}`))
    const items = await createServer().handle(new Request(`http://localhost/v1/responses/${body.id}/input_items`))

    expect(create.status).toBe(200)
    expect(body.store).toBe(false)
    expect(retrieve.status).toBe(404)
    expect(items.status).toBe(404)
    expect(calls).toHaveLength(1)
  })

  test('account-routed emulator state and bridge calls stay isolated by current runtime', async () => {
    enableFallback()
    getCachedConfig().responsesOfficialEmulator = true
    const defaultRuntime = createAccountRuntime('default', { copilotToken: 'copilot-default' })
    const account1Runtime = createAccountRuntime('account1', { copilotToken: 'copilot-account1' })
    defaultRuntime.models.cacheModels(buildModelsResponse(buildModel('chat-only', { supported_endpoints: ['/chat/completions'] })))
    account1Runtime.models.cacheModels(buildModelsResponse(buildModel('chat-only', { supported_endpoints: ['/chat/completions'] })))
    configureAccountRuntimes(
      compileAccountRouting({
        baseHostname: 'localhost',
        defaultAccount: 'default',
        hostnames: {
          'default.localhost': 'default',
          'account1.localhost': 'account1',
        },
      }, ['default', 'account1']),
      [defaultRuntime, account1Runtime],
    )

    const calls: Array<{ account: string, token: string | undefined }> = []
    CopilotClient.prototype.createChatCompletions = (async (payload) => {
      calls.push({ account: getCurrentAccountName(), token: authStore.copilotToken })
      const id = authStore.copilotToken === 'copilot-default' ? 'resp_default' : 'resp_account1'
      return textChatResponse(payload.model, authStore.copilotToken ?? '', id)
    }) as typeof CopilotClient.prototype.createChatCompletions

    const app = createServer()
    const [defaultResponse, account1Response] = await Promise.all([
      app.handle(new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'chat-only', input: 'default' }),
      })),
      app.handle(new Request('http://account1.localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'chat-only', input: 'account1' }),
      })),
    ])
    const defaultBody = await decodeJson<ResponsesResult>(defaultResponse)
    const account1Body = await decodeJson<ResponsesResult>(account1Response)

    expect(defaultResponse.status).toBe(200)
    expect(account1Response.status).toBe(200)
    expect(defaultBody.id).toMatch(/^resp_/)
    expect(account1Body.id).toMatch(/^resp_/)
    expect(defaultBody.id).not.toBe(account1Body.id)
    expect(calls.map(call => call.account).sort()).toEqual(['account1', 'default'])
    expect(calls.map(call => call.token).sort()).toEqual(['copilot-account1', 'copilot-default'])

    const ownResponse = await app.handle(new Request(`http://localhost/v1/responses/${defaultBody.id}`))
    expect(ownResponse.status).toBe(200)
    expect(await ownResponse.json()).toMatchObject({ id: defaultBody.id })
    const defaultCannotReadAccount1 = await app.handle(new Request(`http://localhost/v1/responses/${account1Body.id}`))
    const account1CannotReadDefault = await app.handle(new Request(`http://account1.localhost/v1/responses/${defaultBody.id}`))
    const crossAccountContinuation = await app.handle(new Request('http://account1.localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'chat-only',
        previous_response_id: defaultBody.id,
        input: 'must fail locally',
      }),
    }))

    expect(defaultCannotReadAccount1.status).toBe(404)
    expect(account1CannotReadDefault.status).toBe(404)
    expect(crossAccountContinuation.status).toBe(400)
    expect(calls).toHaveLength(2)
  })
})

describe('Responses Chat bridge streaming contract', () => {
  test('streams text with one completed terminal and no duplicate completion', async () => {
    enableFallback()
    cacheChatModel()
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = mockStreamingResponse([
      chatChunk('chat-only', { role: 'assistant', content: 'hello' }),
      chatChunk('chat-only', { content: ' world' }),
      chatChunk('chat-only', {}, 'stop', {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      }),
      '[DONE]',
    ], calls)

    const response = await post(createServer(), '/v1/responses', {
      model: 'chat-only',
      stream: true,
      input: 'hello',
    })
    const events = decodeSseEvents(await response.text())
    const terminals = terminalEvents(events)
    const completed = terminals.find(payload => payload.type === 'response.completed')

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.stream).toBe(true)
    expect(calls[0]?.payload.stream_options).toEqual({ include_usage: true })
    expect(events.some(event => event.payload?.type === 'response.created')).toBe(true)
    expect(events.some(event => event.payload?.type === 'response.output_text.delta')).toBe(true)
    expect(terminals).toHaveLength(1)
    expect(completed && completed.type === 'response.completed' ? completed.response.output_text : undefined).toBe('hello world')
  })

  test('streams parallel function and custom calls with typed deltas and restored output items', async () => {
    enableFallback()
    cacheChatModel()
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = (async (payload, options) => {
      calls.push({ payload, options })
      const functionAlias = payload.tools?.[0]?.function.name ?? ''
      const customAlias = payload.tools?.[1]?.function.name ?? ''
      const functionArgs = '{"city":"Paris"}'
      const customArgs = JSON.stringify({ input: 'freeform' })
      return Promise.resolve((async function* () {
        yield { data: JSON.stringify(chatChunk('chat-only', {
          role: 'assistant',
          tool_calls: [
            { index: 0, id: 'up_fn', function: { name: functionAlias, arguments: functionArgs.slice(0, 9) } },
            { index: 1, id: 'up_custom', function: { name: customAlias, arguments: customArgs.slice(0, 10) } },
          ],
        })) }
        yield { data: JSON.stringify(chatChunk('chat-only', {
          tool_calls: [
            { index: 0, function: { arguments: functionArgs.slice(9) } },
            { index: 1, function: { arguments: customArgs.slice(10) } },
          ],
        })) }
        yield { data: JSON.stringify(chatChunk('chat-only', {}, 'tool_calls', {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 20,
        })) }
        yield { data: '[DONE]' }
      })())
    }) as typeof CopilotClient.prototype.createChatCompletions

    const response = await post(createServer(), '/v1/responses', {
      model: 'chat-only',
      stream: true,
      tools: [
        { type: 'function', name: 'lookup', namespace: 'weather', parameters: { type: 'object' } },
        { type: 'custom', name: 'write_note', namespace: 'codex' },
      ],
      input: 'run both',
    })
    const events = decodeSseEvents(await response.text())
    const payloads = events.flatMap(event => event.payload ? [event.payload] : [])
    const terminal = terminalEvents(events)
    const completed = terminal.find(payload => payload.type === 'response.completed')

    expect(response.status).toBe(200)
    expect(payloads.some(payload => payload.type === 'response.function_call_arguments.delta')).toBe(true)
    expect(payloads.some(payload => payload.type === 'response.function_call_arguments.done')).toBe(true)
    expect(payloads.some(payload => payload.type === 'response.custom_tool_call_input.delta')).toBe(true)
    expect(payloads.some(payload => payload.type === 'response.custom_tool_call_input.done')).toBe(true)
    expect(payloads.filter(payload => payload.type === 'response.output_item.done')).toHaveLength(2)
    expect(terminal).toHaveLength(1)
    expect(completed && completed.type === 'response.completed'
      ? completed.response.output.some(item => item.type === 'custom_tool_call' && item.name === 'write_note' && item.input === 'freeform')
      : false).toBe(true)
  })

  test('maps a length finish to response.incomplete without falsely completing', async () => {
    enableFallback()
    cacheChatModel()
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = (async (payload, options) => {
      calls.push({ payload, options })
      const alias = payload.tools?.[0]?.function.name ?? ''
      return Promise.resolve((async function* () {
        yield { data: JSON.stringify(chatChunk('chat-only', {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'up_partial', function: { name: alias, arguments: '{"city":' } }],
        })) }
        yield { data: JSON.stringify(chatChunk('chat-only', {}, 'length')) }
        yield { data: '[DONE]' }
      })())
    }) as typeof CopilotClient.prototype.createChatCompletions

    const response = await post(createServer(), '/v1/responses', {
      model: 'chat-only',
      stream: true,
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      input: 'truncate this',
    })
    const events = decodeSseEvents(await response.text())
    const terminals = terminalEvents(events)
    const incomplete = terminals.find(payload => payload.type === 'response.incomplete')

    expect(response.status).toBe(200)
    expect(terminals).toHaveLength(1)
    expect(incomplete?.type).toBe('response.incomplete')
    expect(terminals.some(payload => payload.type === 'response.completed')).toBe(false)
  })

  test('turns early EOF without a finish reason into one failed Responses terminal', async () => {
    enableFallback()
    cacheChatModel()
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = (async (_payload, options) => {
      calls.push({ payload: _payload, options })
      return Promise.resolve((async function* () {
        yield { data: JSON.stringify(chatChunk('chat-only', { content: 'partial' })) }
      })())
    }) as typeof CopilotClient.prototype.createChatCompletions

    const response = await post(createServer(), '/v1/responses', {
      model: 'chat-only',
      stream: true,
      input: 'partial',
    })
    const events = decodeSseEvents(await response.text())
    const terminals = terminalEvents(events)

    expect(response.status).toBe(200)
    expect(events.some(event => event.payload?.type === 'error')).toBe(true)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]?.type).toBe('response.failed')
    expect(terminals.some(payload => payload.type === 'response.completed')).toBe(false)
  })

  test('turns malformed stream JSON into a failed Responses terminal without completion', async () => {
    enableFallback()
    cacheChatModel()
    CopilotClient.prototype.createChatCompletions = (async () => Promise.resolve((async function* () {
      yield { data: '{"choices": [' }
    })())) as typeof CopilotClient.prototype.createChatCompletions

    const response = await post(createServer(), '/v1/responses', {
      model: 'chat-only',
      stream: true,
      input: 'malformed',
    })
    const events = decodeSseEvents(await response.text())
    const terminals = terminalEvents(events)

    expect(response.status).toBe(200)
    expect(events.some(event => event.payload?.type === 'error')).toBe(true)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]?.type).toBe('response.failed')
    expect(terminals.some(payload => payload.type === 'response.completed')).toBe(false)
  })

  test('client abort stops the Chat bridge stream without fabricating a terminal event', async () => {
    enableFallback()
    cacheChatModel()
    let markCancelled: (() => void) | undefined
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve
    })
    CopilotClient.prototype.createChatCompletions = (async (_payload, options) => {
      const signal = options?.signal
      return Promise.resolve((async function* () {
        yield { data: JSON.stringify(chatChunk('chat-only', { content: 'partial' })) }
        if (!signal?.aborted) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        markCancelled?.()
        throw signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
      })())
    }) as typeof CopilotClient.prototype.createChatCompletions

    const app = createServer().listen({ hostname: '127.0.0.1', port: 0 })
    try {
      const port = app.server?.port
      expect(port).toBeNumber()
      const body = JSON.stringify({ model: 'chat-only', stream: true, input: 'cancel me' })
      let received = ''
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port: port! }, () => {
          socket.write([
            'POST /v1/responses HTTP/1.1',
            `Host: 127.0.0.1:${port}`,
            'Content-Type: application/json',
            `Content-Length: ${Buffer.byteLength(body)}`,
            'Connection: close',
            '',
            body,
          ].join('\r\n'))
        })
        socket.on('data', (chunk) => {
          received += chunk.toString()
          if (received.includes('partial')) {
            socket.destroy()
            resolve()
          }
        })
        socket.once('error', reject)
      })
      await cancelled
      await Bun.sleep(50)

      expect(received).not.toContain('response.completed')
      expect(received).not.toContain('response.failed')
      expect(runtimeStore.requests.snapshot().recent[0]).toMatchObject({
        endpoint: '/v1/responses',
        state: 'aborted',
      })
    }
    finally {
      await app.stop(true)
    }
  })

  test('client abort followed by a clean upstream EOF does not fabricate failure or persist a response', async () => {
    enableFallback()
    getCachedConfig().responsesOfficialEmulator = true
    cacheChatModel()
    let markCancelled: (() => void) | undefined
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve
    })
    CopilotClient.prototype.createChatCompletions = (async (_payload, options) => {
      const signal = options?.signal
      return Promise.resolve((async function* () {
        yield { data: JSON.stringify(chatChunk('chat-only', { content: 'partial' })) }
        if (!signal?.aborted) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        markCancelled?.()
        yield { data: '[DONE]' }
        // A transport may finish its iterator normally after observing the
        // client disconnect. The strategy must not turn that into a failure.
      })())
    }) as typeof CopilotClient.prototype.createChatCompletions

    const app = createServer().listen({ hostname: '127.0.0.1', port: 0 })
    try {
      const port = app.server?.port
      expect(port).toBeNumber()
      const body = JSON.stringify({ model: 'chat-only', stream: true, input: 'cancel cleanly' })
      let received = ''
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port: port! }, () => {
          socket.write([
            'POST /v1/responses HTTP/1.1',
            `Host: 127.0.0.1:${port}`,
            'Content-Type: application/json',
            `Content-Length: ${Buffer.byteLength(body)}`,
            'Connection: close',
            '',
            body,
          ].join('\r\n'))
        })
        socket.on('data', (chunk) => {
          received += chunk.toString()
          if (received.includes('partial')) {
            socket.destroy()
            resolve()
          }
        })
        socket.once('error', reject)
      })
      await cancelled
      await Bun.sleep(50)

      expect(received).not.toContain('response.completed')
      expect(received).not.toContain('response.failed')
      expect(responsesEmulatorState.snapshot().responses).toBe(0)
      expect(runtimeStore.requests.snapshot().recent[0]).toMatchObject({
        endpoint: '/v1/responses',
        state: 'aborted',
      })
    }
    finally {
      await app.stop(true)
    }
  })
})

describe('Responses Chat bridge overload fallback', () => {
  test('retries a native source through a Chat-only target for JSON mode and discloses the target model', async () => {
    enableFallback()
    getCachedConfig().overloadFallbacks = { source: 'target' }
    const source = buildModel('source', { supported_endpoints: ['/responses'] })
    const target = buildModel('target', { supported_endpoints: ['/chat/completions'] })
    target.capabilities.supports.structured_outputs = false
    modelCache.cacheModels(buildModelsResponse(source, target))
    const nativeCalls: Array<CapturedResponsesCall> = []
    const chatCalls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createResponses = (async (payload, options) => {
      nativeCalls.push({ payload, options })
      throw new TerminalUpstreamRecoveryError(
        new HTTPError(529, { error: { message: 'source overloaded', type: 'overloaded_error' } }),
        { requestId: 'responses-chat-overload', retryCount: 1, sourceModel: 'source' },
      )
    }) as typeof CopilotClient.prototype.createResponses
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(
      textChatResponse('target', '{"ok":true}', 'chat_target'),
      chatCalls,
    )

    const response = await post(createServer(), '/v1/responses', {
      model: 'source',
      text: { format: { type: 'json_object' } },
      input: 'hello',
    })
    const body = await decodeJson<ResponsesResult>(response)

    expect(response.status).toBe(200)
    expect(body.model).toBe('target')
    expect(body.output_text).toBe('{"ok":true}')
    expect(nativeCalls.map(call => call.payload.model)).toEqual(['source'])
    expect(chatCalls.map(call => call.payload.model)).toEqual(['target'])
    const requests = runtimeStore.requests.snapshot()
    expect([...requests.active, ...requests.recent]).toContainEqual(expect.objectContaining({
      requestedModel: 'source',
      effectiveModel: 'target',
      selectedStrategy: 'responses-chat-completions',
    }))
  })

  test('preserves the source 529 when a hosted tool would be unsupported by the Chat target', async () => {
    enableFallback()
    getCachedConfig().overloadFallbacks = { source: 'target' }
    const source = buildModel('source', { supported_endpoints: ['/responses'] })
    const target = buildModel('target', { supported_endpoints: ['/chat/completions'] })
    modelCache.cacheModels(buildModelsResponse(source, target))
    const nativeCalls: Array<CapturedResponsesCall> = []
    const chatCalls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createResponses = (async (payload, options) => {
      nativeCalls.push({ payload, options })
      throw new TerminalUpstreamRecoveryError(
        new HTTPError(529, {
          error: { message: 'source overloaded', type: 'overloaded_error' },
        }, { headers: { 'retry-after': '4' } }),
        { requestId: 'responses-chat-hosted-reject', retryCount: 1, sourceModel: 'source' },
      )
    }) as typeof CopilotClient.prototype.createResponses
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(
      textChatResponse('target', 'must not run'),
      chatCalls,
    )

    const response = await post(createServer(), '/v1/responses', {
      model: 'source',
      tools: [{ type: 'web_search' }],
      input: 'hello',
    })

    expect(response.status).toBe(529)
    expect(response.headers.get('retry-after')).toBe('4')
    expect(nativeCalls).toHaveLength(1)
    expect(chatCalls).toHaveLength(0)
  })

  test('keeps a native target on the native Responses strategy during overload fallback', async () => {
    enableFallback()
    getCachedConfig().overloadFallbacks = { source: 'target' }
    modelCache.cacheModels(buildModelsResponse(
      buildModel('source', { supported_endpoints: ['/responses'] }),
      buildModel('target', { supported_endpoints: ['/responses'] }),
    ))
    const nativeCalls: Array<CapturedResponsesCall> = []
    const chatCalls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createResponses = (async (payload, options) => {
      nativeCalls.push({ payload, options })
      if (nativeCalls.length === 1) {
        throw new TerminalUpstreamRecoveryError(
          new HTTPError(529, { error: { message: 'source overloaded', type: 'overloaded_error' } }),
          { requestId: 'responses-native-target', retryCount: 1, sourceModel: 'source' },
        )
      }
      return buildResponsesResult({ model: 'target', status: 'completed', output_text: 'native target' })
    }) as typeof CopilotClient.prototype.createResponses
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(
      textChatResponse('target', 'wrong strategy'),
      chatCalls,
    )

    const response = await post(createServer(), '/v1/responses', {
      model: 'source',
      input: 'hello',
    })
    const body = await decodeJson<ResponsesResult>(response)

    expect(response.status).toBe(200)
    expect(body.model).toBe('target')
    expect(nativeCalls.map(call => call.payload.model)).toEqual(['source', 'target'])
    expect(chatCalls).toHaveLength(0)
  })
})
