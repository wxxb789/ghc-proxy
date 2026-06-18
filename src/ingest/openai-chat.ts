import type { ProtocolHandler, RequestMeta } from './types'
import type { ChatCompletionsPayload } from '~/types'

import { normalizeChatRequestContext } from '~/core/capi'
import { parseOpenAIChatPayload } from './validation'

export const openaiChatProtocol: ProtocolHandler<ChatCompletionsPayload> = {
  parse(body: unknown): ChatCompletionsPayload {
    return parseOpenAIChatPayload(body)
  },
  extractMeta(payload: ChatCompletionsPayload, headers: Headers): RequestMeta {
    const requestContext = normalizeChatRequestContext(payload, headers)
    return {
      sessionId: requestContext.clientSessionId,
      requestContext,
    }
  },
}
