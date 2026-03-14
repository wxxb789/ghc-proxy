import type { ClientAuth, ClientConfig, ClientDeps } from './types'
import type {
  CapiChatCompletionResponse,
  CapiChatCompletionsPayload,
  CapiRequestContext,
} from '~/core/capi'
import type { CopilotHeaderOptions } from '~/lib/api-config'
import type { AnthropicMessagesPayload } from '~/translator'
import type {
  EmbeddingRequest,
  EmbeddingResponse,
  ModelsResponse,
  ResponseDeletionResult,
  ResponseInputItemsListParams,
  ResponseInputItemsListResult,
  ResponseInputTokensResult,
  ResponseRetrieveParams,
  ResponsesInputTokensPayload,
  ResponsesPayload,
  ResponsesResult,
} from '~/types'

import consola from 'consola'

import { events } from 'fetch-event-stream'

import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'

import { throwUpstreamError } from '~/lib/error'

interface RequestOptions {
  method?: string
  body?: string
  signal?: AbortSignal
  headerOptions?: CopilotHeaderOptions
  extraHeaders?: Record<string, string>
}

export class CopilotClient {
  private auth: ClientAuth
  private config: ClientConfig
  private fetchImpl: typeof fetch

  constructor(auth: ClientAuth, config: ClientConfig, deps?: ClientDeps) {
    this.auth = auth
    this.config = config
    this.fetchImpl = deps?.fetch ?? fetch
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
  ): Promise<Response> {
    this.requireToken()

    const headers = options.extraHeaders
      ? { ...copilotHeaders(this.auth, this.config, options.headerOptions), ...options.extraHeaders }
      : copilotHeaders(this.auth, this.config, options.headerOptions)

    const response = await this.fetchImpl(
      `${copilotBaseUrl(this.config)}${path}`,
      {
        method: options.method,
        headers,
        body: options.body,
        signal: options.signal,
      },
    )

    if (!response.ok) {
      consola.error(errorMessage, response)
      await throwUpstreamError(errorMessage, response)
    }

    return response
  }

  /** Fetch and parse JSON response */
  private async requestJson<T>(
    path: string,
    errorMessage: string,
    options?: RequestOptions,
  ): Promise<T> {
    const response = await this.request(path, errorMessage, options)
    return (await response.json()) as T
  }

  /** POST payload, return parsed JSON or SSE stream based on payload.stream */
  private async requestStreamable<T>(
    path: string,
    payload: { stream?: boolean | null },
    errorMessage: string,
    options?: Omit<RequestOptions, 'method' | 'body'>,
  ) {
    const response = await this.request(path, errorMessage, {
      method: 'POST',
      body: JSON.stringify(payload),
      ...options,
    })

    if (payload.stream) {
      return events(response)
    }

    return (await response.json()) as T
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
  ): Promise<EmbeddingResponse> {
    return this.requestJson<EmbeddingResponse>(
      '/embeddings',
      'Failed to create embeddings',
      { method: 'POST', body: JSON.stringify(payload) },
    )
  }

  async getModels(): Promise<ModelsResponse> {
    return this.requestJson<ModelsResponse>(
      '/models',
      'Failed to get models',
    )
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
