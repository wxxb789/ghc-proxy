import type { ProtocolHandler, RequestMeta } from './types'
import type { AnthropicCountTokensPayload, AnthropicMessagesPayload } from '~/translator'

import { normalizeAnthropicRequestContext } from '~/core/capi'
import { parseAnthropicCountTokensPayload, parseAnthropicMessagesPayload } from './validation'

function extractAnthropicMeta(
  payload: AnthropicMessagesPayload | AnthropicCountTokensPayload,
  headers: Headers,
): RequestMeta {
  const requestContext = normalizeAnthropicRequestContext(payload, headers)
  const rawBeta = headers.get('anthropic-beta')
  const betaHeaders = rawBeta
    ? rawBeta.split(',').map(v => v.trim()).filter(Boolean)
    : undefined

  return {
    sessionId: requestContext.clientSessionId,
    requestContext,
    betaHeaders,
  }
}

export const anthropicMessagesProtocol: ProtocolHandler<AnthropicMessagesPayload> = {
  parse(body: unknown): AnthropicMessagesPayload {
    return parseAnthropicMessagesPayload(body)
  },
  extractMeta(payload: AnthropicMessagesPayload, headers: Headers): RequestMeta {
    return extractAnthropicMeta(payload, headers)
  },
}

export const anthropicCountTokensProtocol: ProtocolHandler<AnthropicCountTokensPayload> = {
  parse(body: unknown): AnthropicCountTokensPayload {
    return parseAnthropicCountTokensPayload(body)
  },
  extractMeta(payload: AnthropicCountTokensPayload, headers: Headers): RequestMeta {
    return extractAnthropicMeta(payload, headers)
  },
}
