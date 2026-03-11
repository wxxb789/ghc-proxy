import type { ClientAuth, ClientConfig, ClientDeps } from './types'
import type {
  CapiChatCompletionResponse,
  CapiChatCompletionsPayload,
  CapiRequestContext,
} from '~/core/capi'
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

import { HTTPError } from '~/lib/error'

export class CopilotClient {
  private auth: ClientAuth
  private config: ClientConfig
  private fetchImpl: typeof fetch

  constructor(auth: ClientAuth, config: ClientConfig, deps?: ClientDeps) {
    this.auth = auth
    this.config = config
    this.fetchImpl = deps?.fetch ?? fetch
  }

  async createChatCompletions(
    payload: CapiChatCompletionsPayload,
    options?: {
      signal?: AbortSignal
      initiator?: 'user' | 'agent'
      requestContext?: CapiRequestContext
    },
  ) {
    if (!this.auth.copilotToken)
      throw new Error('Copilot token not found')

    const enableVision = payload.messages.some(
      x =>
        typeof x.content !== 'string'
        && x.content?.some(content => content.type === 'image_url'),
    )

    const initiator = options?.initiator
      ?? (payload.messages.some(msg => ['assistant', 'tool'].includes(msg.role))
        ? 'agent'
        : 'user')

    const headers = copilotHeaders(this.auth, this.config, {
      vision: enableVision,
      initiator,
      requestContext: options?.requestContext,
    })

    const response = await this.fetchImpl(
      `${copilotBaseUrl(this.config)}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: options?.signal,
      },
    )

    if (!response.ok) {
      consola.error('Failed to create chat completions', response)
      throw new HTTPError('Failed to create chat completions', response)
    }

    if (payload.stream) {
      return events(response)
    }

    return (await response.json()) as CapiChatCompletionResponse
  }

  async createEmbeddings(
    payload: EmbeddingRequest,
  ): Promise<EmbeddingResponse> {
    if (!this.auth.copilotToken)
      throw new Error('Copilot token not found')

    const response = await this.fetchImpl(
      `${copilotBaseUrl(this.config)}/embeddings`,
      {
        method: 'POST',
        headers: copilotHeaders(this.auth, this.config),
        body: JSON.stringify(payload),
      },
    )

    if (!response.ok) {
      throw new HTTPError('Failed to create embeddings', response)
    }

    return (await response.json()) as EmbeddingResponse
  }

  async getModels(): Promise<ModelsResponse> {
    const response = await this.fetchImpl(
      `${copilotBaseUrl(this.config)}/models`,
      {
        headers: copilotHeaders(this.auth, this.config),
      },
    )

    if (!response.ok)
      throw new HTTPError('Failed to get models', response)

    return (await response.json()) as ModelsResponse
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
    if (!this.auth.copilotToken)
      throw new Error('Copilot token not found')

    const headers = copilotHeaders(this.auth, this.config, {
      vision: options?.vision,
      initiator: options?.initiator,
      requestContext: options?.requestContext,
    })

    const response = await this.fetchImpl(
      `${copilotBaseUrl(this.config)}/responses`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: options?.signal,
      },
    )

    if (!response.ok) {
      consola.error('Failed to create responses', response)
      throw new HTTPError('Failed to create responses', response)
    }

    if (payload.stream) {
      return events(response)
    }

    return (await response.json()) as ResponsesResult
  }

  async getResponse(
    responseId: string,
    options?: {
      signal?: AbortSignal
      params?: ResponseRetrieveParams
      requestContext?: Partial<CapiRequestContext>
    },
  ): Promise<ResponsesResult | Record<string, unknown>> {
    if (!this.auth.copilotToken)
      throw new Error('Copilot token not found')

    const response = await this.fetchImpl(
      this.buildResponsesUrl(responseId, options?.params),
      {
        headers: copilotHeaders(this.auth, this.config, {
          requestContext: options?.requestContext,
        }),
        signal: options?.signal,
      },
    )

    if (!response.ok) {
      consola.error('Failed to get response', response)
      throw new HTTPError('Failed to get response', response)
    }

    return await response.json() as ResponsesResult | Record<string, unknown>
  }

  async getResponseInputItems(
    responseId: string,
    params?: ResponseInputItemsListParams,
    options?: {
      signal?: AbortSignal
      requestContext?: Partial<CapiRequestContext>
    },
  ): Promise<ResponseInputItemsListResult | Record<string, unknown>> {
    if (!this.auth.copilotToken)
      throw new Error('Copilot token not found')

    const response = await this.fetchImpl(
      this.buildResponseInputItemsUrl(responseId, params),
      {
        headers: copilotHeaders(this.auth, this.config, {
          requestContext: options?.requestContext,
        }),
        signal: options?.signal,
      },
    )

    if (!response.ok) {
      consola.error('Failed to get response input items', response)
      throw new HTTPError('Failed to get response input items', response)
    }

    return await response.json() as ResponseInputItemsListResult | Record<string, unknown>
  }

  async createResponseInputTokens(
    payload: ResponsesInputTokensPayload,
    options?: {
      signal?: AbortSignal
      requestContext?: Partial<CapiRequestContext>
    },
  ): Promise<ResponseInputTokensResult | Record<string, unknown>> {
    if (!this.auth.copilotToken)
      throw new Error('Copilot token not found')

    const response = await this.fetchImpl(
      `${copilotBaseUrl(this.config)}/responses/input_tokens`,
      {
        method: 'POST',
        headers: copilotHeaders(this.auth, this.config, {
          requestContext: options?.requestContext,
        }),
        body: JSON.stringify(payload),
        signal: options?.signal,
      },
    )

    if (!response.ok) {
      consola.error('Failed to create response input tokens', response)
      throw new HTTPError('Failed to create response input tokens', response)
    }

    return await response.json() as ResponseInputTokensResult | Record<string, unknown>
  }

  async deleteResponse(
    responseId: string,
    options?: {
      signal?: AbortSignal
      requestContext?: Partial<CapiRequestContext>
    },
  ): Promise<ResponseDeletionResult | Record<string, unknown>> {
    if (!this.auth.copilotToken)
      throw new Error('Copilot token not found')

    const response = await this.fetchImpl(
      this.buildResponsesUrl(responseId),
      {
        method: 'DELETE',
        headers: copilotHeaders(this.auth, this.config, {
          requestContext: options?.requestContext,
        }),
        signal: options?.signal,
      },
    )

    if (!response.ok) {
      consola.error('Failed to delete response', response)
      throw new HTTPError('Failed to delete response', response)
    }

    return await response.json() as ResponseDeletionResult | Record<string, unknown>
  }

  async createMessages(
    payload: AnthropicMessagesPayload,
    anthropicBetaHeader?: string,
    options?: {
      signal?: AbortSignal
      requestContext?: Partial<CapiRequestContext>
    },
  ) {
    if (!this.auth.copilotToken)
      throw new Error('Copilot token not found')

    const headers = copilotHeaders(this.auth, this.config, {
      initiator: 'agent',
      requestContext: options?.requestContext,
    })

    if (anthropicBetaHeader) {
      headers['anthropic-beta'] = anthropicBetaHeader
    }

    const response = await this.fetchImpl(
      `${copilotBaseUrl(this.config)}/v1/messages`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: options?.signal,
      },
    )

    if (!response.ok) {
      consola.error('Failed to create messages', response)
      throw new HTTPError('Failed to create messages', response)
    }

    if (payload.stream) {
      return events(response)
    }

    return await response.json()
  }

  private buildResponsesUrl(
    responseId?: string,
    params?: ResponseRetrieveParams,
  ): string {
    const base = responseId
      ? `${copilotBaseUrl(this.config)}/responses/${encodeURIComponent(responseId)}`
      : `${copilotBaseUrl(this.config)}/responses`

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
    const base = `${copilotBaseUrl(this.config)}/responses/${encodeURIComponent(responseId)}/input_items`
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
