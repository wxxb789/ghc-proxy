import type { CopilotHeaderOptions } from './api-config'
import type { ClientAuth, ClientConfig, ClientDeps } from './types'
import type { QueuedUpstreamResponse, UpstreamRecoveryRecord, UpstreamRequestQueue } from './upstream-queue'
import type {
  CapiChatCompletionResponse,
  CapiChatCompletionsPayload,
  CapiRequestContext,
} from '~/core/capi'
import type { AccountRuntime } from '~/state/account-runtime'
import type { AnthropicMessagesPayload } from '~/translator'
import type {
  DecisionsRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  ImageEditRequest,
  ImageGenerationRequest,
  ImageResponse,
  ModelsResponse,
  ResponseDeletionResult,
  ResponseInputItemsListParams,
  ResponseInputItemsListResult,
  ResponseInputTokensResult,
  ResponseRetrieveParams,
  ResponsesInputTokensPayload,
  ResponsesPayload,
  ResponsesResult,
  SystemOneRequest,
} from '~/types'

import { events } from 'fetch-event-stream'

import { HTTPError, throwUpstreamError } from '~/lib/error'
import { setTargetAvailability } from '~/state/account-runtime'

import { copilotBaseUrl, copilotHeaders } from './api-config'
import { acquireM365Credential, isM365CatalogAccessDenied, markM365Unavailable } from './m365-credential'
import { normalizeM365Catalog } from './m365-upstream'
import { TerminalUpstreamRecoveryError } from './upstream-queue'

export type UpstreamErrorMapper = (message: string, response: Response) => Promise<HTTPError>

interface RequestOptions {
  method?: string
  body?: string | FormData
  signal?: AbortSignal
  headerOptions?: CopilotHeaderOptions
  extraHeaders?: Record<string, string>
  retryable?: boolean | 'capacity'
  effectiveModel?: string
  errorMapper?: UpstreamErrorMapper
}

interface FetchParams {
  url: string
  init: RequestInit
}

export class CopilotClient {
  private auth: ClientAuth
  /**
   * Set exactly when the upstream is M365, which records its credential and
   * availability on the route target it serves.
   */
  private m365Runtime: AccountRuntime | undefined
  private config: ClientConfig
  private fetchImpl: typeof fetch
  private requestQueue: UpstreamRequestQueue | undefined
  private recovery: UpstreamRecoveryRecord | undefined
  private offerLocalModelCooldown: ClientDeps['offerLocalModelCooldown']
  private fallbackAttempt: boolean

  constructor(auth: ClientAuth, config: ClientConfig, deps?: ClientDeps) {
    if (config.upstream === 'm365') {
      if (!deps?.runtime) {
        throw new Error('An M365 client requires its route target runtime')
      }
      this.m365Runtime = deps.runtime
    }
    this.auth = auth
    this.config = config
    this.fetchImpl = deps?.fetch ?? fetch
    this.requestQueue = deps?.requestQueue
    this.recovery = deps?.recovery
    this.offerLocalModelCooldown = deps?.offerLocalModelCooldown ?? false
    this.fallbackAttempt = deps?.fallbackAttempt ?? false
  }

  private requireToken(): void {
    if (!this.auth.copilotToken) {
      throw new Error('Copilot token not found')
    }
  }

  /** Low-level fetch with token check, header injection, and error handling */
  private async request(
    path: string,
    errorMessage: string,
    options: RequestOptions = {},
  ): Promise<QueuedUpstreamResponse> {
    if (this.m365Runtime) {
      const credential = await acquireM365Credential(this.m365Runtime)
      if (credential.status === 'unavailable') {
        throw new HTTPError(503, {
          error: {
            message: `The Microsoft 365 target is unavailable: ${credential.cause}`,
            type: 'invalid_request_error',
          },
        })
      }
    }

    this.requireToken()

    const headers = options.extraHeaders
      ? { ...copilotHeaders(this.auth, this.config, options.headerOptions), ...options.extraHeaders }
      : copilotHeaders(this.auth, this.config, options.headerOptions)

    // Fetch must generate the multipart boundary together with the body.
    if (options.body instanceof FormData)
      delete headers['content-type']

    const url = `${copilotBaseUrl(this.config)}${path}`
    const request = {
      url,
      init: {
        method: options.method,
        headers,
        body: options.body,
        signal: options.signal,
      },
    }

    const queuedResponse = await this.fetchWithQueue(
      request,
      options.retryable,
      options.effectiveModel,
    )
    const { response } = queuedResponse

    if (!response.ok) {
      try {
        if (options.errorMapper)
          throw await options.errorMapper(errorMessage, response)
        await throwUpstreamError(errorMessage, response)
      }
      catch (error) {
        if (
          error instanceof HTTPError
          && response.status === 529
          && queuedResponse.recovery
        ) {
          throw new TerminalUpstreamRecoveryError(error, queuedResponse.recovery)
        }
        throw error
      }
      finally {
        queuedResponse.release()
      }
    }

    return queuedResponse
  }

  /** Fetch and parse JSON response */
  private async requestJson<T>(
    path: string,
    errorMessage: string,
    options?: RequestOptions,
  ): Promise<T> {
    const { response, release } = await this.request(path, errorMessage, options)
    try {
      return (await response.json()) as T
    }
    finally {
      release()
    }
  }

  /** POST payload, return parsed JSON or SSE stream based on payload.stream */
  private async requestStreamable<T>(
    path: string,
    payload: { stream?: boolean | null, model?: unknown } | FormData,
    errorMessage: string,
    options?: Omit<RequestOptions, 'method' | 'body' | 'retryable'>,
  ) {
    const multipart = payload instanceof FormData
    const model = multipart ? payload.get('model') : payload.model
    const stream = multipart ? payload.get('stream') === 'true' : payload.stream === true
    const { response, release } = await this.request(path, errorMessage, {
      method: 'POST',
      body: multipart ? payload : JSON.stringify(payload),
      // Every completion endpoint routes through here, and each one bills a
      // generation. An upstream 5xx does not mean the request was refused —
      // it may have been fully processed before failing — so replaying one
      // can double-spend quota for a single client request. Only 429/529 are
      // replayed: there the upstream declined to serve. The `retryable` key is
      // excluded from `options` above so a future caller cannot widen this
      // back to the full transient set without saying so here.
      retryable: 'capacity',
      effectiveModel: typeof model === 'string' ? model : undefined,
      ...options,
    })

    if (stream) {
      return withRelease(events(response), release)
    }

    try {
      return (await response.json()) as T
    }
    finally {
      release()
    }
  }

  private async fetchWithQueue(
    request: FetchParams,
    retryable?: boolean | 'capacity',
    effectiveModel?: string,
  ): Promise<QueuedUpstreamResponse> {
    const fetcher = (signal?: AbortSignal) => this.fetchImpl(request.url, {
      ...request.init,
      signal: signal ?? request.init.signal,
    })
    if (this.requestQueue) {
      return this.requestQueue.dispatch(fetcher, {
        method: request.init.method,
        url: request.url,
        retryable,
        effectiveModel,
        recovery: this.recovery,
        offerLocalModelCooldown: this.offerLocalModelCooldown,
        fallbackAttempt: this.fallbackAttempt,
      }, request.init.signal ?? undefined)
    }

    const recovery = this.recovery ?? {
      requestId: crypto.randomUUID(),
      retryCount: 0,
    }
    return {
      response: await fetcher(request.init.signal ?? undefined),
      release: () => {},
      recovery,
    }
  }

  async createChatCompletions(
    payload: CapiChatCompletionsPayload,
    options?: {
      signal?: AbortSignal
      initiator?: 'user' | 'agent'
      requestContext?: CapiRequestContext
    },
  ) {
    const enableVision = payload.messages.some(
      x =>
        typeof x.content !== 'string'
        && x.content?.some(content => content.type === 'image_url'),
    )

    const initiator = options?.initiator
      ?? (payload.messages.some(msg => ['assistant', 'tool'].includes(msg.role))
        ? 'agent'
        : 'user')

    return this.requestStreamable<CapiChatCompletionResponse>(
      '/chat/completions',
      payload,
      'Failed to create chat completions',
      {
        signal: options?.signal,
        headerOptions: {
          vision: enableVision,
          initiator,
          requestContext: options?.requestContext,
        },
      },
    )
  }

  async createEmbeddings(
    payload: EmbeddingRequest,
    options?: { signal?: AbortSignal },
  ): Promise<EmbeddingResponse> {
    return this.requestJson<EmbeddingResponse>(
      '/embeddings',
      'Failed to create embeddings',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: options?.signal,
        effectiveModel: payload.model,
        retryable: true,
      },
    )
  }

  async createSystemOne(
    payload: SystemOneRequest,
    options?: { signal?: AbortSignal, errorMapper?: UpstreamErrorMapper },
  ): Promise<unknown> {
    return this.requestJson<unknown>(
      '/v1/systemone',
      'Failed to create System One response',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: options?.signal,
        effectiveModel: payload.model,
        retryable: 'capacity',
        errorMapper: options?.errorMapper,
      },
    )
  }

  async createImageGeneration(
    payload: ImageGenerationRequest,
    options?: { signal?: AbortSignal },
  ) {
    return this.requestStreamable<ImageResponse>(
      '/v1/images/generations',
      payload,
      'Failed to generate images',
      { signal: options?.signal, headerOptions: { initiator: 'user' } },
    )
  }

  async createImageEdit(
    payload: ImageEditRequest,
    options?: { signal?: AbortSignal },
  ) {
    return this.requestStreamable<ImageResponse>(
      '/v1/images/edits',
      payload,
      'Failed to edit images',
      { signal: options?.signal, headerOptions: { initiator: 'user' } },
    )
  }

  /**
   * Native OpenAI Decisions endpoint. Errors take the shared upstream path:
   * the gateway already answers in the public envelope with public params.
   */
  async createDecisions(
    payload: DecisionsRequest,
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    return this.requestJson<unknown>(
      '/v1/decisions',
      'Failed to create decisions response',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: options?.signal,
        effectiveModel: payload.model,
        retryable: 'capacity',
      },
    )
  }

  async getModels(options: { signal?: AbortSignal } = {}): Promise<ModelsResponse> {
    try {
      const payload = await this.requestJson<unknown>(
        '/models',
        'Failed to get models',
        { retryable: true, signal: options.signal },
      )
      if (!this.m365Runtime)
        return payload as ModelsResponse
      const catalog = normalizeM365Catalog(payload)
      setTargetAvailability(this.m365Runtime, { status: 'ready' })
      return catalog
    }
    catch (error) {
      if (this.m365Runtime && isM365CatalogAccessDenied(error)) {
        markM365Unavailable(
          this.m365Runtime,
          `M365 model catalog access denied (${error.status}); select a work account with gateway access and a Copilot subscription.`,
        )
      }
      throw error
    }
  }

  async createResponses(
    payload: ResponsesPayload,
    options?: {
      signal?: AbortSignal
      initiator?: 'user' | 'agent'
      vision?: boolean
      requestContext?: Partial<CapiRequestContext>
    },
  ) {
    return this.requestStreamable<ResponsesResult>(
      '/responses',
      payload,
      'Failed to create responses',
      {
        signal: options?.signal,
        headerOptions: {
          vision: options?.vision,
          initiator: options?.initiator,
          requestContext: options?.requestContext,
        },
      },
    )
  }

  async getResponse(
    responseId: string,
    options?: {
      signal?: AbortSignal
      params?: ResponseRetrieveParams
      requestContext?: Partial<CapiRequestContext>
    },
  ): Promise<ResponsesResult | Record<string, unknown>> {
    return this.requestJson<ResponsesResult | Record<string, unknown>>(
      this.buildResponsesUrl(responseId, options?.params),
      'Failed to get response',
      {
        signal: options?.signal,
        headerOptions: { requestContext: options?.requestContext },
        retryable: true,
      },
    )
  }

  async getResponseInputItems(
    responseId: string,
    params?: ResponseInputItemsListParams,
    options?: {
      signal?: AbortSignal
      requestContext?: Partial<CapiRequestContext>
    },
  ): Promise<ResponseInputItemsListResult | Record<string, unknown>> {
    return this.requestJson<ResponseInputItemsListResult | Record<string, unknown>>(
      this.buildResponseInputItemsUrl(responseId, params),
      'Failed to get response input items',
      {
        signal: options?.signal,
        headerOptions: { requestContext: options?.requestContext },
        retryable: true,
      },
    )
  }

  async createResponseInputTokens(
    payload: ResponsesInputTokensPayload,
    options?: {
      signal?: AbortSignal
      requestContext?: Partial<CapiRequestContext>
    },
  ): Promise<ResponseInputTokensResult | Record<string, unknown>> {
    return this.requestJson<ResponseInputTokensResult | Record<string, unknown>>(
      '/responses/input_tokens',
      'Failed to create response input tokens',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: options?.signal,
        headerOptions: { requestContext: options?.requestContext },
        retryable: true,
      },
    )
  }

  async deleteResponse(
    responseId: string,
    options?: {
      signal?: AbortSignal
      requestContext?: Partial<CapiRequestContext>
    },
  ): Promise<ResponseDeletionResult | Record<string, unknown>> {
    return this.requestJson<ResponseDeletionResult | Record<string, unknown>>(
      this.buildResponsesUrl(responseId),
      'Failed to delete response',
      {
        method: 'DELETE',
        signal: options?.signal,
        headerOptions: { requestContext: options?.requestContext },
      },
    )
  }

  async createMessages(
    payload: AnthropicMessagesPayload,
    anthropicBetaHeader?: string,
    options?: {
      signal?: AbortSignal
      requestContext?: Partial<CapiRequestContext>
    },
  ) {
    return this.requestStreamable(
      '/v1/messages',
      payload,
      'Failed to create messages',
      {
        signal: options?.signal,
        extraHeaders: anthropicBetaHeader
          ? { 'anthropic-beta': anthropicBetaHeader }
          : undefined,
        headerOptions: {
          initiator: 'agent',
          requestContext: options?.requestContext,
        },
      },
    )
  }

  private buildResponsesUrl(
    responseId?: string,
    params?: ResponseRetrieveParams,
  ): string {
    const base = responseId
      ? `/responses/${encodeURIComponent(responseId)}`
      : `/responses`

    const searchParams = new URLSearchParams()
    if (params?.include?.length) {
      for (const include of params.include) {
        searchParams.append('include', include)
      }
    }
    if (typeof params?.starting_after === 'number') {
      searchParams.set('starting_after', String(params.starting_after))
    }
    if (typeof params?.include_obfuscation === 'boolean') {
      searchParams.set('include_obfuscation', String(params.include_obfuscation))
    }
    if (typeof params?.stream === 'boolean') {
      searchParams.set('stream', String(params.stream))
    }

    const query = searchParams.toString()
    return query ? `${base}?${query}` : base
  }

  private buildResponseInputItemsUrl(
    responseId: string,
    params?: ResponseInputItemsListParams,
  ): string {
    const base = `/responses/${encodeURIComponent(responseId)}/input_items`
    const searchParams = new URLSearchParams()

    if (params?.include?.length) {
      for (const include of params.include) {
        searchParams.append('include', include)
      }
    }
    if (typeof params?.after === 'string') {
      searchParams.set('after', params.after)
    }
    if (typeof params?.limit === 'number') {
      searchParams.set('limit', String(params.limit))
    }
    if (typeof params?.order === 'string') {
      searchParams.set('order', params.order)
    }

    const query = searchParams.toString()
    return query ? `${base}?${query}` : base
  }
}

export function isNonStreamingResponse(
  response: Awaited<ReturnType<CopilotClient['createChatCompletions']>>,
): response is CapiChatCompletionResponse {
  return Object.hasOwn(response, 'choices')
}

async function* withRelease<T>(
  iterable: AsyncIterable<T>,
  release: () => void,
): AsyncGenerator<T> {
  try {
    yield* iterable
  }
  finally {
    release()
  }
}
