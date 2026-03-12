import type { Context } from 'hono'
import type {
  ResponseInputItemsListParams,
  ResponseRetrieveParams,
  ResponsesInputTokensPayload,
} from '~/types'

import { CopilotClient } from '~/clients'
import { readCapiRequestContext } from '~/core/capi'
import { throwInvalidRequestError } from '~/lib/error'
import { getClientConfig, state } from '~/lib/state'
import { parseResponsesInputTokensPayload } from '~/lib/validation'

// --- Core request parameter interfaces ---

export interface ResourceHandlerParams {
  params: { responseId?: string }
  url: string
  headers: Headers
  signal: AbortSignal
}

export interface ResourceHandlerBodyParams {
  body: unknown
  headers: Headers
  signal: AbortSignal
}

// --- Framework-agnostic Core functions ---

export async function handleRetrieveResponseCore(
  { params, url, headers, signal }: ResourceHandlerParams,
): Promise<object> {
  const responseId = requireResponseId(params.responseId)
  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  return await copilotClient.getResponse(responseId, {
    params: getRetrieveParamsFromUrl(url),
    requestContext: readCapiRequestContext(headers),
    signal,
  })
}

export async function handleListResponseInputItemsCore(
  { params, url, headers, signal }: ResourceHandlerParams,
): Promise<object> {
  const responseId = requireResponseId(params.responseId)
  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  return await copilotClient.getResponseInputItems(
    responseId,
    getInputItemsParamsFromUrl(url),
    {
      requestContext: readCapiRequestContext(headers),
      signal,
    },
  )
}

export async function handleCreateResponseInputTokensCore(
  { body, headers, signal }: ResourceHandlerBodyParams,
): Promise<object> {
  const payload = parseResponsesInputTokensPayload(body) as ResponsesInputTokensPayload
  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  return await copilotClient.createResponseInputTokens(payload, {
    requestContext: readCapiRequestContext(headers),
    signal,
  })
}

export async function handleDeleteResponseCore(
  { params, headers, signal }: Omit<ResourceHandlerParams, 'url'>,
): Promise<object> {
  const responseId = requireResponseId(params.responseId)
  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  return await copilotClient.deleteResponse(responseId, {
    requestContext: readCapiRequestContext(headers),
    signal,
  })
}

// --- Hono-specific wrappers ---

export async function handleRetrieveResponse(c: Context) {
  const result = await handleRetrieveResponseCore({
    params: { responseId: c.req.param('responseId') },
    url: c.req.url,
    headers: c.req.raw.headers,
    signal: c.req.raw.signal,
  })
  return c.json(result)
}

export async function handleListResponseInputItems(c: Context) {
  const result = await handleListResponseInputItemsCore({
    params: { responseId: c.req.param('responseId') },
    url: c.req.url,
    headers: c.req.raw.headers,
    signal: c.req.raw.signal,
  })
  return c.json(result)
}

export async function handleCreateResponseInputTokens(c: Context) {
  const result = await handleCreateResponseInputTokensCore({
    body: await c.req.json(),
    headers: c.req.raw.headers,
    signal: c.req.raw.signal,
  })
  return c.json(result)
}

export async function handleDeleteResponse(c: Context) {
  const result = await handleDeleteResponseCore({
    params: { responseId: c.req.param('responseId') },
    headers: c.req.raw.headers,
    signal: c.req.raw.signal,
  })
  return c.json(result)
}

// --- Shared helpers (now framework-agnostic, accept url string) ---

function requireResponseId(responseId: string | undefined): string {
  if (!responseId) {
    throwInvalidRequestError('Response id is required.', 'response_id')
  }
  return responseId
}

function getRetrieveParamsFromUrl(rawUrl: string): ResponseRetrieveParams {
  const url = new URL(rawUrl)
  const params: ResponseRetrieveParams = {
    include: getIncludeParamsFromUrl(rawUrl),
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
    include: getIncludeParamsFromUrl(rawUrl),
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

function getIncludeParamsFromUrl(rawUrl: string): Array<string> | undefined {
  const url = new URL(rawUrl)
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
