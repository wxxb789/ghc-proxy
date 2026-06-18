import type { ProtocolHandler, RequestMeta } from './types'
import type { ResponsesInputTokensPayload, ResponsesPayload } from '~/types'

import { normalizeResponsesRequestContext } from '~/core/capi'
import { parseResponsesInputTokensPayload, parseResponsesPayload } from './validation'

function extractResponsesMeta(
  payload: ResponsesPayload | ResponsesInputTokensPayload,
  headers: Headers,
): RequestMeta {
  const requestContext = normalizeResponsesRequestContext(payload, headers)
  return {
    sessionId: requestContext.clientSessionId,
    requestContext,
  }
}

export const responsesProtocol: ProtocolHandler<ResponsesPayload> = {
  parse(body: unknown): ResponsesPayload {
    return parseResponsesPayload(body)
  },
  extractMeta(payload: ResponsesPayload, headers: Headers): RequestMeta {
    return extractResponsesMeta(payload, headers)
  },
}

export const responsesInputTokensProtocol: ProtocolHandler<ResponsesInputTokensPayload> = {
  parse(body: unknown): ResponsesInputTokensPayload {
    return parseResponsesInputTokensPayload(body)
  },
  extractMeta(payload: ResponsesInputTokensPayload, headers: Headers): RequestMeta {
    return extractResponsesMeta(payload, headers)
  },
}
