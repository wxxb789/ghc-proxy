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
  EmbeddingRequest,
  EmbeddingResponse,
  Model,
  ModelsResponse,
  ResponsesPayload,
  ResponsesResult,
} from '~/types'

import { expect } from 'bun:test'
import { Elysia } from 'elysia'

import { getCachedConfig } from '~/lib/config'
import { HTTPError } from '~/lib/error'
import { createCompletionRoutes } from '~/routes/chat-completions/route'
import { createEmbeddingRoutes } from '~/routes/embeddings/route'
import { createMessageRoutes } from '~/routes/messages/route'
import { createModelRoutes } from '~/routes/models/route'
import { createResponsesRoutes } from '~/routes/responses/route'
import { authStore, modelCache, rateLimiter, responsesEmulatorState, runtimeStore } from '~/state'

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
  options?: {
    signal?: AbortSignal
    initiator?: 'user' | 'agent'
    vision?: boolean
    requestContext?: Partial<CapiRequestContext>
  }
}

export interface CapturedMessagesCall {
  payload: AnthropicMessagesPayload
}

export interface CapturedEmbeddingCall {
  payload: EmbeddingRequest
}

export interface CapturedGetResponseCall {
  responseId: string
  params?: Record<string, unknown>
}

export interface CapturedGetResponseInputItemsCall {
  responseId: string
  params?: {
    after?: string
    include?: Array<string>
    limit?: number
    order?: 'asc' | 'desc'
  }
}

export interface CapturedCreateResponseInputTokensCall {
  payload: Record<string, unknown>
}

export interface CapturedDeleteResponseCall {
  responseId: string
}

interface ParsedSseEvent {
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

export function buildResponsesResult(overrides: Partial<ResponsesResult> = {}): ResponsesResult {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    model: 'gpt-5.4',
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
    ...overrides,
  }
}

// ── Elysia App Factory ──

type CreateChatCompletions = typeof CopilotClient.prototype.createChatCompletions
type CreateResponses = typeof CopilotClient.prototype.createResponses
type CreateMessages = typeof CopilotClient.prototype.createMessages
type CreateEmbeddings = typeof CopilotClient.prototype.createEmbeddings
type GetResponse = typeof CopilotClient.prototype.getResponse
type GetResponseInputItems = typeof CopilotClient.prototype.getResponseInputItems
type CreateResponseInputTokens = typeof CopilotClient.prototype.createResponseInputTokens
type DeleteResponse = typeof CopilotClient.prototype.deleteResponse

export function createApp(
  routes: 'all' | 'messages' | 'responses' | 'completions' | 'embeddings' | 'models' = 'all',
) {
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
      .use(createEmbeddingRoutes())
      .use(createModelRoutes())
      .use(createResponsesRoutes()))
  }
  if (routes === 'messages') {
    return app.group('/v1', a => a.use(createMessageRoutes()))
  }
  if (routes === 'responses') {
    return app.group('/v1', a => a.use(createResponsesRoutes()))
  }
  if (routes === 'embeddings') {
    return app.group('/v1', a => a.use(createEmbeddingRoutes()))
  }
  if (routes === 'models') {
    return app.group('/v1', a => a.use(createModelRoutes()))
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
  return ((payload, options) => {
    calls.push({ payload, options })
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

export function mockEmbeddings(
  response: EmbeddingResponse,
  calls: Array<CapturedEmbeddingCall>,
): CreateEmbeddings {
  return ((payload) => {
    calls.push({ payload })
    return Promise.resolve(response)
  }) as CreateEmbeddings
}

export function mockChatCompletions(
  response: CapiChatCompletionResponse,
  calls: Array<CapturedChatCall>,
): CreateChatCompletions {
  return ((payload) => {
    calls.push({ payload })
    return Promise.resolve(response)
  }) as CreateChatCompletions
}

export function mockGetResponse(
  response: Record<string, unknown>,
  calls: Array<CapturedGetResponseCall>,
): GetResponse {
  return ((responseId, options) => {
    calls.push({ responseId, params: options?.params as Record<string, unknown> | undefined })
    return Promise.resolve(response)
  }) as GetResponse
}

export function mockGetResponseInputItems(
  response: Record<string, unknown>,
  calls: Array<CapturedGetResponseInputItemsCall>,
): GetResponseInputItems {
  return ((responseId, params) => {
    calls.push({ responseId, params })
    return Promise.resolve(response)
  }) as GetResponseInputItems
}

export function mockCreateResponseInputTokens(
  response: Record<string, unknown>,
  calls: Array<CapturedCreateResponseInputTokensCall>,
): CreateResponseInputTokens {
  return ((payload) => {
    calls.push({ payload: payload as Record<string, unknown> })
    return Promise.resolve(response)
  }) as CreateResponseInputTokens
}

export function mockDeleteResponse(
  response: Record<string, unknown>,
  calls: Array<CapturedDeleteResponseCall>,
): DeleteResponse {
  return ((responseId) => {
    calls.push({ responseId })
    return Promise.resolve(response)
  }) as DeleteResponse
}

export function mockEmulatorCreateResponses(
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

// ── State Snapshot ──

export interface StateSnapshot {
  copilotToken: typeof authStore.copilotToken
  copilotApiBase: typeof authStore.copilotApiBase
  githubToken: typeof authStore.githubToken
  gheDomain: typeof authStore.gheDomain
  accountType: typeof authStore.accountType
  manualApprove: typeof authStore.manualApprove
  rateLimitSeconds: typeof authStore.rateLimitSeconds
  rateLimitWait: typeof authStore.rateLimitWait
  showToken: typeof authStore.showToken
  upstreamTimeoutSeconds: typeof authStore.upstreamTimeoutSeconds
  dumpFailedPayloads: typeof runtimeStore.dumpFailedPayloads
  models: ReturnType<typeof modelCache.getModels>
  vsCodeVersion: ReturnType<typeof modelCache.getVSCodeVersion>
}

export function saveStateSnapshot(): StateSnapshot {
  return {
    copilotToken: authStore.copilotToken,
    copilotApiBase: authStore.copilotApiBase,
    githubToken: authStore.githubToken,
    gheDomain: authStore.gheDomain,
    accountType: authStore.accountType,
    manualApprove: authStore.manualApprove,
    rateLimitSeconds: authStore.rateLimitSeconds,
    rateLimitWait: authStore.rateLimitWait,
    showToken: authStore.showToken,
    upstreamTimeoutSeconds: authStore.upstreamTimeoutSeconds,
    dumpFailedPayloads: runtimeStore.dumpFailedPayloads,
    models: modelCache.getModels(),
    vsCodeVersion: modelCache.getVSCodeVersion(),
  }
}

export function restoreStateSnapshot(snapshot: StateSnapshot) {
  authStore.copilotToken = snapshot.copilotToken
  authStore.copilotApiBase = snapshot.copilotApiBase
  authStore.githubToken = snapshot.githubToken
  authStore.gheDomain = snapshot.gheDomain
  authStore.accountType = snapshot.accountType
  authStore.manualApprove = snapshot.manualApprove
  authStore.rateLimitSeconds = snapshot.rateLimitSeconds
  authStore.rateLimitWait = snapshot.rateLimitWait
  authStore.showToken = snapshot.showToken
  authStore.upstreamTimeoutSeconds = snapshot.upstreamTimeoutSeconds
  runtimeStore.dumpFailedPayloads = snapshot.dumpFailedPayloads
  if (snapshot.models !== undefined) {
    modelCache.cacheModels(snapshot.models)
  }
  else {
    modelCache.clearModels()
  }
  if (snapshot.vsCodeVersion !== undefined) {
    modelCache.setVSCodeVersion(snapshot.vsCodeVersion)
  }
  else {
    modelCache.clearVSCodeVersion()
  }
  rateLimiter.reset()
  responsesEmulatorState.clear()
}

// ── Cache Checkpoint Assertions ──

export function expectCacheCheckpoints(payload: CapiChatCompletionsPayload) {
  // Mirrors the three sites tagged by applyCacheCheckpoints in
  // src/core/capi/plan-builder.ts: first system/developer message, last tool,
  // and the last cache-eligible (non-user) message.
  expect(payload.messages[0]?.copilot_cache_control).toEqual({ type: 'ephemeral' })
  expect(payload.tools?.at(-1)?.copilot_cache_control).toEqual({ type: 'ephemeral' })

  const lastCacheEligibleIndex = payload.messages.findLastIndex(
    message => message.role !== 'user',
  )
  expect(lastCacheEligibleIndex).toBeGreaterThanOrEqual(0)
  expect(payload.messages[lastCacheEligibleIndex]?.copilot_cache_control).toEqual({ type: 'ephemeral' })
}

// ── Default Test State Setup ──

export function setupDefaultTestState() {
  authStore.copilotToken = 'test-token'
  authStore.accountType = 'individual'
  authStore.manualApprove = false
  authStore.rateLimitSeconds = undefined
  authStore.rateLimitWait = false
  runtimeStore.dumpFailedPayloads = false
  modelCache.setVSCodeVersion('1.99.0')
  modelCache.cacheModels(buildModelsResponse(buildModel('claude-sonnet-4.5')))
  rateLimiter.reset()
  responsesEmulatorState.clear()
}

// ── Config Helpers ──

/** Reset the module-level cachedConfig to empty defaults. */
export function clearConfig() {
  const config = getCachedConfig() as Record<string, unknown>
  for (const key of Object.keys(config)) {
    delete config[key]
  }
}
