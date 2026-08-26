import type { CopilotClient } from '~/clients'
import type { UpstreamRecoveryRecord } from '~/clients/upstream-queue'
import type { CapiRequestContext } from '~/core/capi/types'
import type {
  ResponseInputItemsListParams,
  ResponseRetrieveParams,
} from '~/types'

import { readCapiRequestContext } from '~/core/capi/request-context'
import { protocolRegistry } from '~/ingest'
import { throwInvalidRequestError } from '~/lib/error'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { createResourceDispatcher } from './resource-dispatcher'

// --- Core request parameter interfaces ---

export interface ResourceHandlerParams {
  params: { responseId?: string }
  url: string
  headers: Headers
  signal: AbortSignal
  /** Injection seam for tests; production callers omit it. */
  client?: CopilotClient
  recovery?: UpstreamRecoveryRecord
  onClientAbort?: () => void
}

export interface ResourceHandlerBodyParams {
  body: unknown
  headers: Headers
  signal: AbortSignal
  /** Injection seam for tests; production callers omit it. */
  client?: CopilotClient
  recovery?: UpstreamRecoveryRecord
  onClientAbort?: () => void
}

// --- Core functions ---

export async function handleRetrieveResponseCore(
  { params, url, headers, signal, client, recovery, onClientAbort }: ResourceHandlerParams,
): Promise<object> {
  const responseId = requireResponseId(params.responseId)
  const dispatcher = createResourceDispatcher(client, recovery)
  return withUpstreamSignal(signal, onClientAbort, upstreamSignal =>
    dispatcher.retrieve(
      responseId,
      getRetrieveParamsFromUrl(url),
      { requestContext: readCapiRequestContext(headers), signal: upstreamSignal },
    ) as Promise<object>)
}

export async function handleListResponseInputItemsCore(
  { params, url, headers, signal, client, recovery, onClientAbort }: ResourceHandlerParams,
): Promise<object> {
  const responseId = requireResponseId(params.responseId)
  const dispatcher = createResourceDispatcher(client, recovery)
  return withUpstreamSignal(signal, onClientAbort, upstreamSignal =>
    dispatcher.listInputItems(
      responseId,
      getInputItemsParamsFromUrl(url),
      { requestContext: readCapiRequestContext(headers), signal: upstreamSignal },
    ) as Promise<object>)
}

export async function handleCreateResponseInputTokensCore(
  { body, headers, signal, client, recovery, onClientAbort }: ResourceHandlerBodyParams,
): Promise<object> {
  const { payload, meta } = protocolRegistry.ingest<import('~/types').ResponsesInputTokensPayload>(
    'responses-input-tokens',
    body,
    headers,
  )
  const dispatcher = createResourceDispatcher(client, recovery)
  return withUpstreamSignal(signal, onClientAbort, upstreamSignal =>
    dispatcher.createInputTokens(
      payload,
      {
        requestContext: meta.requestContext as Partial<CapiRequestContext> | undefined,
        signal: upstreamSignal,
      },
    ) as Promise<object>)
}

export async function handleDeleteResponseCore(
  { params, headers, signal, client, recovery, onClientAbort }: Omit<ResourceHandlerParams, 'url'>,
): Promise<object> {
  const responseId = requireResponseId(params.responseId)
  const dispatcher = createResourceDispatcher(client, recovery)
  return withUpstreamSignal(signal, onClientAbort, upstreamSignal =>
    dispatcher.delete(
      responseId,
      { requestContext: readCapiRequestContext(headers), signal: upstreamSignal },
    ) as Promise<object>)
}

// --- Shared helpers ---

async function withUpstreamSignal<T>(
  clientSignal: AbortSignal,
  onClientAbort: (() => void) | undefined,
  dispatch: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const upstreamSignal = createUpstreamSignalFromConfig(
    clientSignal,
    undefined,
    onClientAbort,
  )
  try {
    return await dispatch(upstreamSignal.signal)
  }
  finally {
    upstreamSignal.cleanup()
  }
}

function requireResponseId(responseId: string | undefined): string {
  if (!responseId) {
    throwInvalidRequestError('Response id is required.', 'response_id')
  }
  return responseId
}

function getRetrieveParamsFromUrl(rawUrl: string): ResponseRetrieveParams {
  const url = new URL(rawUrl)
  const params: ResponseRetrieveParams = {
    include: getIncludeParams(url),
  }

  const startingAfter = url.searchParams.get('starting_after')
  if (startingAfter !== null) {
    const parsed = Number(startingAfter)
    if (!Number.isInteger(parsed) || parsed < 0) {
      throwInvalidRequestError(
        'Query parameter starting_after must be a non-negative integer.',
        'starting_after',
      )
    }
    params.starting_after = parsed
  }

  const includeObfuscation = url.searchParams.get('include_obfuscation')
  if (includeObfuscation !== null) {
    const parsed = parseBooleanParam(includeObfuscation)
    if (parsed === undefined) {
      throwInvalidRequestError(
        'Query parameter include_obfuscation must be true or false.',
        'include_obfuscation',
      )
    }
    params.include_obfuscation = parsed
  }

  const stream = url.searchParams.get('stream')
  if (stream !== null) {
    const parsed = parseBooleanParam(stream)
    if (parsed === undefined) {
      throwInvalidRequestError(
        'Query parameter stream must be true or false.',
        'stream',
      )
    }
    params.stream = parsed
  }

  return params
}

function getInputItemsParamsFromUrl(rawUrl: string): ResponseInputItemsListParams {
  const url = new URL(rawUrl)
  const limit = url.searchParams.get('limit')
  const order = url.searchParams.get('order')
  const params: ResponseInputItemsListParams = {
    after: url.searchParams.get('after') ?? undefined,
    include: getIncludeParams(url),
  }

  if (limit !== null) {
    const parsed = Number(limit)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throwInvalidRequestError(
        'Query parameter limit must be an integer between 1 and 100.',
        'limit',
      )
    }
    params.limit = parsed
  }

  if (order !== null) {
    if (order !== 'asc' && order !== 'desc') {
      throwInvalidRequestError(
        'Query parameter order must be "asc" or "desc".',
        'order',
      )
    }
    params.order = order
  }

  return params
}

function getIncludeParams(url: URL): Array<string> | undefined {
  const includes = url.searchParams.getAll('include')
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean)

  return includes.length > 0 ? includes : undefined
}

function parseBooleanParam(value: string): boolean | undefined {
  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  return undefined
}
