import type { Context } from 'hono'
import type {
  ResponseInputItemsListParams,
  ResponseRetrieveParams,
  ResponsesInputTokensPayload,
} from '~/types'

import { CopilotClient } from '~/clients'
import { readCapiRequestContext } from '~/core/capi'
import { HTTPError } from '~/lib/error'
import { getClientConfig, state } from '~/lib/state'
import { parseResponsesInputTokensPayload } from '~/lib/validation'

export async function handleRetrieveResponse(c: Context) {
  const responseId = getRequiredResponseId(c)
  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  const response = await copilotClient.getResponse(responseId, {
    params: getRetrieveParams(c),
    requestContext: readCapiRequestContext(c.req.raw.headers),
    signal: c.req.raw.signal,
  })
  return c.json(response)
}

export async function handleListResponseInputItems(c: Context) {
  const responseId = getRequiredResponseId(c)
  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  const response = await copilotClient.getResponseInputItems(responseId, getInputItemsParams(c), {
    requestContext: readCapiRequestContext(c.req.raw.headers),
    signal: c.req.raw.signal,
  })
  return c.json(response)
}

export async function handleCreateResponseInputTokens(c: Context) {
  const payload = parseResponsesInputTokensPayload(await c.req.json()) as ResponsesInputTokensPayload
  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  const response = await copilotClient.createResponseInputTokens(payload, {
    requestContext: readCapiRequestContext(c.req.raw.headers),
    signal: c.req.raw.signal,
  })
  return c.json(response)
}

export async function handleDeleteResponse(c: Context) {
  const responseId = getRequiredResponseId(c)
  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  const response = await copilotClient.deleteResponse(responseId, {
    requestContext: readCapiRequestContext(c.req.raw.headers),
    signal: c.req.raw.signal,
  })
  return c.json(response)
}

function getRequiredResponseId(c: Context): string {
  const responseId = c.req.param('responseId')
  if (!responseId) {
    throwInvalidRequestError('Response id is required.', 'response_id')
  }
  return responseId
}

function getRetrieveParams(c: Context): ResponseRetrieveParams {
  const url = new URL(c.req.url)
  const params: ResponseRetrieveParams = {
    include: getIncludeParams(c),
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

function getInputItemsParams(c: Context): ResponseInputItemsListParams {
  const url = new URL(c.req.url)
  const limit = url.searchParams.get('limit')
  const order = url.searchParams.get('order')
  const params: ResponseInputItemsListParams = {
    after: url.searchParams.get('after') ?? undefined,
    include: getIncludeParams(c),
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

function getIncludeParams(c: Context): Array<string> | undefined {
  const url = new URL(c.req.url)
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

function throwInvalidRequestError(
  message: string,
  param: string,
): never {
  throw new HTTPError(
    message,
    Response.json(
      {
        error: {
          message,
          type: 'invalid_request_error',
          param,
        },
      },
      { status: 400 },
    ),
  )
}
