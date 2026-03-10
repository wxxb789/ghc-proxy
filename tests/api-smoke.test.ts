import type { ServerSentEventMessage } from 'fetch-event-stream'
import type {
  CapiChatCompletionChunk,
  CapiChatCompletionResponse,
  CapiChatCompletionsPayload,
  CapiRequestContext,
} from '~/core/capi'
import type { AnthropicResponse } from '~/translator'
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  Model,
  ModelsResponse,
} from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import { CopilotClient } from '~/clients'
import { forwardError } from '~/lib/error'
import { state } from '~/lib/state'
import { completionRoutes } from '~/routes/chat-completions/route'
import { messageRoutes } from '~/routes/messages/route'

type CreateChatCompletions = typeof CopilotClient.prototype.createChatCompletions

interface CapturedChatCall {
  payload: CapiChatCompletionsPayload
  options?: {
    signal?: AbortSignal
    initiator?: 'user' | 'agent'
    requestContext?: CapiRequestContext
  }
}

interface ParsedSseEvent {
  event?: string
  data?: string
}

const originalCreateChatCompletions = CopilotClient.prototype.createChatCompletions
const originalState = {
  auth: { ...state.auth },
  config: { ...state.config },
  cache: { ...state.cache },
  rateLimit: { ...state.rateLimit },
}

function buildModel(id: string): Model {
  return {
    id,
    model_picker_enabled: true,
    name: id,
    object: 'model',
    preview: false,
    vendor: 'anthropic',
    version: '1',
    capabilities: {
      family: 'claude',
      limits: {
        max_context_window_tokens: 200000,
        max_output_tokens: 8192,
        max_prompt_tokens: 180000,
      },
      object: 'model_capabilities',
      supports: {
        tool_calls: true,
        parallel_tool_calls: true,
      },
      tokenizer: 'o200k_base',
      type: 'chat',
    },
  }
}

function buildModelsResponse(...models: Array<Model>): ModelsResponse {
  return {
    object: 'list',
    data: models,
  }
}

function createApp() {
  const app = new Hono()
  app.onError((error, c) => forwardError(c, error))
  app.route('/v1/messages', messageRoutes)
  app.route('/v1/chat/completions', completionRoutes)
  return app
}

function parseSse(body: string): Array<ParsedSseEvent> {
  return body
    .split(/\r?\n\r?\n/)
    .map((chunk) => {
      const event: ParsedSseEvent = {}
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith('event: ')) {
          event.event = line.slice('event: '.length)
        }
        else if (line.startsWith('data: ')) {
          event.data = event.data
            ? `${event.data}\n${line.slice('data: '.length)}`
            : line.slice('data: '.length)
        }
      }
      return event
    })
    .filter(event => event.event || event.data)
}

function createStream(
  chunks: Array<CapiChatCompletionChunk | '[DONE]'>,
): AsyncGenerator<ServerSentEventMessage, void, unknown> {
  return (async function* () {
    for (const chunk of chunks) {
      yield {
        data: chunk === '[DONE]' ? chunk : JSON.stringify(chunk),
      }
    }
  })()
}

function mockNonStreamingResponse(
  response: CapiChatCompletionResponse,
  calls: Array<CapturedChatCall>,
): CreateChatCompletions {
  return ((payload, options) => {
    calls.push({ payload, options })
    return Promise.resolve(response)
  }) as CreateChatCompletions
}

function mockStreamingResponse(
  chunks: Array<CapiChatCompletionChunk | '[DONE]'>,
  calls: Array<CapturedChatCall>,
): CreateChatCompletions {
  return ((payload, options) => {
    calls.push({ payload, options })
    return Promise.resolve(createStream(chunks))
  }) as CreateChatCompletions
}

function expectCacheCheckpoints(payload: CapiChatCompletionsPayload) {
  expect(payload.messages[0]?.copilot_cache_control).toEqual({ type: 'ephemeral' })
  expect(payload.tools?.at(-1)?.copilot_cache_control).toEqual({ type: 'ephemeral' })
  expect(
    payload.messages.some(message =>
      message.role !== 'user'
      && message.copilot_cache_control?.type === 'ephemeral',
    ),
  ).toBe(true)
}

beforeEach(() => {
  state.auth.copilotToken = 'test-token'
  state.cache.vsCodeVersion = '1.99.0'
  state.cache.models = buildModelsResponse(buildModel('claude-sonnet-4.5'))
  state.config.accountType = 'individual'
  state.config.manualApprove = false
  state.config.rateLimitSeconds = undefined
  state.config.rateLimitWait = false
  state.rateLimit.lastRequestTimestamp = undefined
})

afterEach(() => {
  CopilotClient.prototype.createChatCompletions = originalCreateChatCompletions
  state.auth = { ...originalState.auth }
  state.config = { ...originalState.config }
  state.cache = { ...originalState.cache }
  state.rateLimit = { ...originalState.rateLimit }
})

describe('API smoke', () => {
  test('Anthropic non-stream preserves Claude reasoning/tool semantics and CAPI cache planning', async () => {
    const app = createApp()
    const calls: Array<CapturedChatCall> = []

    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse({
      id: 'msg_123',
      object: 'chat.completion',
      created: 1,
      model: 'claude-sonnet-4.5',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          logprobs: null,
          message: {
            role: 'assistant',
            content: 'I will inspect the file.',
            reasoning_text: 'Need to read src/main.ts before editing.',
            reasoning_opaque: 'opaque-state',
            encrypted_content: 'encrypted-state',
            phase: 'tool',
            copilot_annotations: { source: 'copilot' },
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"src/main.ts"}',
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: {
          cached_tokens: 80,
        },
      },
    }, calls)

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 256,
        system: 'You are Claude Code.',
        thinking: {
          type: 'enabled',
          budget_tokens: 4096,
        },
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
        ],
        messages: [
          { role: 'assistant', content: 'I can continue from the previous step.' },
          { role: 'user', content: 'Inspect src/main.ts' },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const json = await response.json() as AnthropicResponse

    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.model).toBe('claude-sonnet-4.5')
    expect(calls[0]?.payload.reasoning_effort).toBe('low')
    expect(calls[0]?.payload.thinking_budget).toBe(4096)
    expect(calls[0]?.payload.stream_options).toBeUndefined()
    expect(calls[0]?.options?.initiator).toBe('agent')
    expect(calls[0]?.options?.requestContext?.interactionType).toBe('conversation-agent')
    expectCacheCheckpoints(calls[0]!.payload)

    expect(json.stop_reason).toBe('tool_use')
    expect(json.usage.input_tokens).toBe(40)
    expect(json.usage.cache_read_input_tokens).toBe(80)
    expect(json.content[0]).toMatchObject({
      type: 'thinking',
      thinking: 'Need to read src/main.ts before editing.',
    })
    expect(json.content[1]).toMatchObject({
      type: 'text',
      text: 'I will inspect the file.',
    })
    expect(json.content[2]).toMatchObject({
      type: 'tool_use',
      id: 'call_1',
      name: 'read_file',
      input: {
        path: 'src/main.ts',
      },
    })
  })

  test('Anthropic streaming emits official SSE events while keeping Claude stream usage and tool deltas', async () => {
    const app = createApp()
    const calls: Array<CapturedChatCall> = []

    CopilotClient.prototype.createChatCompletions = mockStreamingResponse([
      {
        id: 'stream_123',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'claude-sonnet-4.5',
        choices: [
          {
            index: 0,
            delta: {
              reasoning_text: 'Need a tool before answering.',
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: 'stream_123',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'claude-sonnet-4.5',
        choices: [
          {
            index: 0,
            delta: {
              content: 'I will read the file.',
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: 'stream_123',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'claude-sonnet-4.5',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'read_file',
                  },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: 'stream_123',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'claude-sonnet-4.5',
        usage: {
          prompt_tokens: 90,
          completion_tokens: 12,
          total_tokens: 102,
          prompt_tokens_details: {
            cached_tokens: 50,
          },
        },
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: '{"path":"src/main.ts"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
            logprobs: null,
          },
        ],
      },
      '[DONE]',
    ], calls)

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        max_tokens: 256,
        stream: true,
        thinking: {
          type: 'adaptive',
        },
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
        ],
        messages: [
          { role: 'user', content: 'Inspect src/main.ts' },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.stream_options).toEqual({ include_usage: true })
    expect(calls[0]?.payload.reasoning_effort).toBe('medium')
    expect(calls[0]?.payload.thinking_budget).toBe(24000)
    expect(calls[0]?.payload.tools?.[0]?.copilot_cache_control).toEqual({ type: 'ephemeral' })
    expect(
      calls[0]?.payload.messages.every(message => message.copilot_cache_control == null),
    ).toBe(true)

    const events = parseSse(body)
    expect(events.some(event => event.event === 'message_start')).toBe(true)
    expect(events.some(event => event.event === 'content_block_start')).toBe(true)
    expect(events.some(event => event.data?.includes('"type":"thinking_delta"'))).toBe(true)
    expect(events.some(event => event.data?.includes('"partial_json":"{\\"path\\":\\"src/main.ts\\"}"'))).toBe(true)
    expect(events.some(event => event.data?.includes('"cache_read_input_tokens":50'))).toBe(true)
    expect(events.some(event => event.data?.includes('"stop_reason":"tool_use"'))).toBe(true)
    expect(events.at(-1)?.event).toBe('message_stop')
  })

  test('OpenAI non-stream keeps public schema clean while sharing Claude planning core', async () => {
    const app = createApp()
    const calls: Array<CapturedChatCall> = []

    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse({
      id: 'chatcmpl_123',
      object: 'chat.completion',
      created: 1,
      model: 'claude-sonnet-4.5',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          logprobs: null,
          message: {
            role: 'assistant',
            content: 'Running the tool now.',
            reasoning_text: 'Need to inspect the file first.',
            reasoning_opaque: 'opaque-state',
            encrypted_content: 'encrypted-state',
            phase: 'tool',
            copilot_annotations: { source: 'copilot' },
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"src/main.ts"}',
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 60,
        completion_tokens: 20,
        total_tokens: 80,
        prompt_tokens_details: {
          cached_tokens: 30,
        },
      },
    }, calls)

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-session-id': 'client-session-1',
        'x-interaction-id': 'interaction-1',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        thinking_budget: 12000,
        reasoning_effort: 'high',
        response_format: { type: 'json_object' },
        seed: 7,
        messages: [
          { role: 'developer', content: 'Follow repo conventions.' },
          { role: 'user', content: 'Open src/main.ts' },
        ],
        tools: [
          {
            type: 'function',
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
      }),
    })

    expect(response.status).toBe(200)
    const json = await response.json() as ChatCompletionResponse

    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.max_tokens).toBe(8192)
    expect(calls[0]?.payload.reasoning_effort).toBe('high')
    expect(calls[0]?.payload.thinking_budget).toBe(12000)
    expect(calls[0]?.payload.response_format).toEqual({ type: 'json_object' })
    expect(calls[0]?.payload.seed).toBe(7)
    expect(calls[0]?.options?.initiator).toBe('user')
    expect(calls[0]?.options?.requestContext).toMatchObject({
      interactionType: 'conversation-user',
      interactionId: 'interaction-1',
      clientSessionId: 'client-session-1',
    })
    expectCacheCheckpoints(calls[0]!.payload)

    expect(json.choices[0]?.message.content).toBe('Running the tool now.')
    expect(json.choices[0]?.message.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"path":"src/main.ts"}',
        },
      },
    ])
    expect(Object.hasOwn(json.choices[0]!.message, 'reasoning_text')).toBe(false)
    expect(Object.hasOwn(json.choices[0]!.message as object, 'reasoning_opaque')).toBe(false)
    expect(Object.hasOwn(json.choices[0]!.message as object, 'encrypted_content')).toBe(false)
    expect(Object.hasOwn(json.choices[0]!.message as object, 'copilot_annotations')).toBe(false)
  })

  test('OpenAI route rejects malformed completion options before upstream call', async () => {
    const app = createApp()
    const calls: Array<CapturedChatCall> = []

    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse({
      id: 'chatcmpl_unused',
      object: 'chat.completion',
      created: 1,
      model: 'claude-sonnet-4.5',
      choices: [],
    }, calls)

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'Open src/main.ts' }],
        n: '2',
        response_format: { type: 'json_schema' },
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Invalid request payload')
    expect(calls).toHaveLength(0)
  })

  test('OpenAI streaming preserves public reasoning_text but does not leak Copilot-private fields', async () => {
    const app = createApp()
    const calls: Array<CapturedChatCall> = []

    CopilotClient.prototype.createChatCompletions = mockStreamingResponse([
      {
        id: 'chatcmpl_stream_1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'claude-sonnet-4.5',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              reasoning_text: 'Need to inspect before writing.',
              reasoning_opaque: 'opaque-state',
              encrypted_content: 'encrypted-state',
              phase: 'tool',
              copilot_annotations: { source: 'copilot' },
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: 'chatcmpl_stream_1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'claude-sonnet-4.5',
        usage: {
          prompt_tokens: 70,
          completion_tokens: 12,
          total_tokens: 82,
          prompt_tokens_details: {
            cached_tokens: 35,
          },
        },
        choices: [
          {
            index: 0,
            delta: {
              content: 'I will run the tool.',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: '{"path":"src/main.ts"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
            logprobs: null,
          },
        ],
      },
      '[DONE]',
    ], calls)

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        stream: true,
        thinking_budget: 8000,
        messages: [
          { role: 'user', content: 'Inspect src/main.ts' },
        ],
        tools: [
          {
            type: 'function',
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
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    const events = parseSse(body)
    const chunks = events
      .map(event => event.data)
      .filter((data): data is string => Boolean(data) && data !== '[DONE]')
      .map(data => JSON.parse(data) as ChatCompletionChunk)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.stream_options).toEqual({ include_usage: true })
    expect(calls[0]?.payload.reasoning_effort).toBe('low')
    expect(calls[0]?.payload.thinking_budget).toBe(8000)

    expect(chunks[0]?.choices[0]?.delta.reasoning_text).toBe('Need to inspect before writing.')
    expect(Object.hasOwn(chunks[0]!.choices[0]!.delta as object, 'reasoning_opaque')).toBe(false)
    expect(Object.hasOwn(chunks[0]!.choices[0]!.delta as object, 'encrypted_content')).toBe(false)
    expect(Object.hasOwn(chunks[0]!.choices[0]!.delta as object, 'copilot_annotations')).toBe(false)
    expect(chunks[1]?.choices[0]?.delta.tool_calls?.[0]?.function?.name).toBe('read_file')
    expect(chunks[1]?.choices[0]?.finish_reason).toBe('tool_calls')
    expect(chunks[1]?.usage?.prompt_tokens_details?.cached_tokens).toBe(35)
  })

  test('Anthropic count_tokens works through the shared planning core for Claude Code style requests', async () => {
    const app = createApp()

    const response = await app.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-beta': 'claude-code-1',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        system: 'You are Claude Code.',
        thinking: {
          type: 'adaptive',
        },
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
        ],
        messages: [
          { role: 'assistant', content: 'I can continue.' },
          { role: 'user', content: 'Inspect src/main.ts' },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const json = await response.json() as { input_tokens: number }
    expect(json.input_tokens).toBeGreaterThan(0)
  })
})
