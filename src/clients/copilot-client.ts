import type { ClientAuth, ClientConfig, ClientDeps } from './types'
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  EmbeddingRequest,
  EmbeddingResponse,
  ModelsResponse,
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
    payload: ChatCompletionsPayload,
    options?: { signal?: AbortSignal },
  ) {
    if (!this.auth.copilotToken)
      throw new Error('Copilot token not found')

    const enableVision = payload.messages.some(
      x =>
        typeof x.content !== 'string'
        && x.content?.some(content => content.type === 'image_url'),
    )

    // Agent/user check for X-Initiator header
    const isAgentCall = payload.messages.some(msg =>
      ['assistant', 'tool'].includes(msg.role),
    )

    const headers: Record<string, string> = {
      ...copilotHeaders(this.auth, this.config, enableVision),
      'X-Initiator': isAgentCall ? 'agent' : 'user',
    }

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

    return (await response.json()) as ChatCompletionResponse
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
}
