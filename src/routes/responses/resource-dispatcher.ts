import type { CopilotClient } from '~/clients'
import type { UpstreamRecoveryRecord } from '~/clients/upstream-queue'
import type { CapiRequestContext } from '~/core/capi/types'

import type { ResponseInputItemsListParams, ResponseRetrieveParams, ResponsesInputTokensPayload } from '~/types'
import { createCopilotClient } from '~/clients/factory'
import { resolveModelOrThrow } from '~/lib/error'
import { configStore } from '~/state'
import {
  deleteStoredResponseOrThrow,
  estimateEmulatorInputTokens,
  getStoredResponseOrThrow,
  listStoredInputItemsOrThrow,
} from './emulator'

export interface ResourceRequestOptions {
  signal?: AbortSignal
  requestContext?: Partial<CapiRequestContext>
}

export interface ResourceDispatcher {
  retrieve: (responseId: string, params?: ResponseRetrieveParams, options?: ResourceRequestOptions) => Promise<unknown>
  listInputItems: (responseId: string, params?: ResponseInputItemsListParams, options?: ResourceRequestOptions) => Promise<unknown>
  createInputTokens: (payload: ResponsesInputTokensPayload, options?: ResourceRequestOptions) => Promise<unknown>
  delete: (responseId: string, options?: ResourceRequestOptions) => Promise<unknown>
}

class EmulatorResourceDispatcher implements ResourceDispatcher {
  retrieve(responseId: string): Promise<unknown> {
    return Promise.resolve(getStoredResponseOrThrow(responseId))
  }

  listInputItems(responseId: string, params?: ResponseInputItemsListParams): Promise<unknown> {
    return Promise.resolve(listStoredInputItemsOrThrow(responseId, params))
  }

  async createInputTokens(payload: ResponsesInputTokensPayload): Promise<unknown> {
    const model = payload.model ?? ''
    const selectedModel = resolveModelOrThrow(model)
    return estimateEmulatorInputTokens(payload, selectedModel)
  }

  delete(responseId: string): Promise<unknown> {
    return Promise.resolve(deleteStoredResponseOrThrow(responseId))
  }
}

class UpstreamResourceDispatcher implements ResourceDispatcher {
  private client: CopilotClient

  constructor(client: CopilotClient) {
    this.client = client
  }

  retrieve(responseId: string, params?: ResponseRetrieveParams, options?: ResourceRequestOptions): Promise<unknown> {
    return this.client.getResponse(responseId, { params, ...options })
  }

  listInputItems(responseId: string, params?: ResponseInputItemsListParams, options?: ResourceRequestOptions): Promise<unknown> {
    return this.client.getResponseInputItems(responseId, params, options)
  }

  createInputTokens(payload: ResponsesInputTokensPayload, options?: ResourceRequestOptions): Promise<unknown> {
    return this.client.createResponseInputTokens(payload, options)
  }

  delete(responseId: string, options?: ResourceRequestOptions): Promise<unknown> {
    return this.client.deleteResponse(responseId, options)
  }
}

/**
 * Build the dispatcher backing the `/responses/{id}` resource routes.
 *
 * `client` is an injection seam for tests: pass a stand-in to exercise the
 * upstream path without patching `CopilotClient.prototype`. Production callers
 * omit it and get the configured client.
 */
export function createResourceDispatcher(
  client?: CopilotClient,
  recovery?: UpstreamRecoveryRecord,
): ResourceDispatcher {
  return configStore.isEmulatorEnabled()
    ? new EmulatorResourceDispatcher()
    : new UpstreamResourceDispatcher(client ?? createCopilotClient(recovery))
}
