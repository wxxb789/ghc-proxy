import type { ServerSentEventMessage } from 'fetch-event-stream'
import type { CopilotClient } from '~/clients'
import type {
  CapiChatCompletionChunk,
  CapiChatCompletionResponse,
  CapiChatCompletionsPayload,
  CapiRequestContext,
} from '~/core/capi'
import type { AnthropicMessagesPayload, AnthropicResponse } from '~/translator'
import type {
  Model,
  ModelsResponse,
  ResponsesPayload,
  ResponsesResult,
} from '~/types'

import { expect } from 'bun:test'
import { Elysia } from 'elysia'

import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { createCompletionRoutes } from '~/routes/chat-completions/route'
import { createMessageRoutes } from '~/routes/messages/route'
import { createResponsesRoutes } from '~/routes/responses/route'

const SSE_BLOCK_SEPARATOR_RE = /\r?\n\r?\n/
const SSE_LINE_SEPARATOR_RE = /\r?\n/

// ── Shared Interfaces ──

export interface CapturedChatCall {
  payload: CapiChatCompletionsPayload
  options?: {
    signal?: AbortSignal
    initiator?: 'user' | 'agent'
    requestContext?: CapiRequestContext
  }
}

export interface CapturedResponsesCall {
  payload: ResponsesPayload
}

export interface CapturedMessagesCall {
  payload: AnthropicMessagesPayload
}

export interface ParsedSseEvent {
  event?: string
  data?: string
}

// ── Model Builders ──

export function buildModel(id: string, overrides?: Partial<Model>): Model {
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
        adaptive_thinking: true,
      },
      tokenizer: 'o200k_base',
      type: 'chat',
    },
    ...overrides,
  }
}

export function buildGptModel(id: string, overrides?: Partial<Model>): Model {
  return buildModel(id, {
    vendor: 'openai',
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
    ...overrides,
  })
}

export function buildVisionModel(id: string, overrides?: Partial<Model>): Model {
  const model = buildModel(id, overrides)
  model.capabilities.supports.vision = true
  model.capabilities.limits.vision = {
    max_prompt_image_size: 3145728,
    max_prompt_images: 1,
    supported_media_types: ['image/png'],
  }
  return model
}

export function buildModelsResponse(...models: Array<Model>): ModelsResponse {
  return {
    object: 'list',
    data: models,
  }
}

// ── Elysia App Factory ──

type CreateChatCompletions = typeof CopilotClient.prototype.createChatCompletions
type CreateResponses = typeof CopilotClient.prototype.createResponses
type CreateMessages = typeof CopilotClient.prototype.createMessages

export function createApp(routes: 'all' | 'messages' | 'responses' | 'completions' = 'all') {
  const app = new Elysia()
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

  if (routes === 'all') {
    return app.group('/v1', a => a
      .use(createMessageRoutes())
      .use(createCompletionRoutes())
      .use(createResponsesRoutes()))
  }
  if (routes === 'messages') {
    return app.group('/v1', a => a.use(createMessageRoutes()))
  }
  if (routes === 'responses') {
    return app.group('/v1', a => a.use(createResponsesRoutes()))
  }
  return app.group('/v1', a => a.use(createCompletionRoutes()))
}

// ── SSE Helpers ──

export function parseSse(body: string): Array<ParsedSseEvent> {
  return body
    .split(SSE_BLOCK_SEPARATOR_RE)
    .map((chunk) => {
      const event: ParsedSseEvent = {}
      for (const line of chunk.split(SSE_LINE_SEPARATOR_RE)) {
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

export function createStream(
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

// ── Mock Factories ──

export function mockNonStreamingResponse(
  response: CapiChatCompletionResponse,
  calls: Array<CapturedChatCall>,
): CreateChatCompletions {
  return ((payload, options) => {
    calls.push({ payload, options })
    return Promise.resolve(response)
  }) as CreateChatCompletions
}

export function mockStreamingResponse(
  chunks: Array<CapiChatCompletionChunk | '[DONE]'>,
  calls: Array<CapturedChatCall>,
): CreateChatCompletions {
  return ((payload, options) => {
    calls.push({ payload, options })
    return Promise.resolve(createStream(chunks))
  }) as CreateChatCompletions
}

export function mockResponses(
  response: ResponsesResult | AsyncGenerator<ServerSentEventMessage, void, unknown>,
  calls: Array<CapturedResponsesCall>,
): CreateResponses {
  return ((payload) => {
    calls.push({ payload })
    return Promise.resolve(response)
  }) as CreateResponses
}

export function mockMessages(
  response: AnthropicResponse | AsyncGenerator<ServerSentEventMessage, void, unknown>,
  calls: Array<CapturedMessagesCall>,
): CreateMessages {
  return ((payload) => {
    calls.push({ payload })
    return Promise.resolve(response)
  }) as CreateMessages
}

// ── State Snapshot ──

export interface StateSnapshot {
  auth: typeof state.auth
  config: typeof state.config
  cache: typeof state.cache
  rateLimit: typeof state.rateLimit
}

export function saveStateSnapshot(): StateSnapshot {
  return {
    auth: { ...state.auth },
    config: { ...state.config },
    cache: { ...state.cache },
    rateLimit: { ...state.rateLimit },
  }
}

export function restoreStateSnapshot(snapshot: StateSnapshot) {
  state.auth = { ...snapshot.auth }
  state.config = { ...snapshot.config }
  state.cache = { ...snapshot.cache }
  state.rateLimit = { ...snapshot.rateLimit }
}

// ── Cache Checkpoint Assertions ──

export function expectCacheCheckpoints(payload: CapiChatCompletionsPayload) {
  expect(payload.messages[0]?.copilot_cache_control).toEqual({ type: 'ephemeral' })
  expect(payload.tools?.at(-1)?.copilot_cache_control).toEqual({ type: 'ephemeral' })
  expect(
    payload.messages.some(message =>
      message.role !== 'user'
      && message.copilot_cache_control?.type === 'ephemeral',
    ),
  ).toBe(true)
}

// ── Default Test State Setup ──

export function setupDefaultTestState() {
  state.auth.copilotToken = 'test-token'
  state.cache.vsCodeVersion = '1.99.0'
  state.cache.models = buildModelsResponse(buildModel('claude-sonnet-4.5'))
  state.config.accountType = 'individual'
  state.config.manualApprove = false
  state.config.rateLimitSeconds = undefined
  state.config.rateLimitWait = false
  state.rateLimit.nextAvailableAt = undefined
}
