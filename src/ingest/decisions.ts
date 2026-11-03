import type { ProtocolHandler, RequestMeta } from './types'
import type { DecisionsRequest } from '~/types'

import { parseDecisionsRequest } from './validation'

export const decisionsProtocol: ProtocolHandler<DecisionsRequest> = {
  parse(body: unknown): DecisionsRequest {
    return parseDecisionsRequest(body)
  },
  extractMeta(_payload: DecisionsRequest, _headers: Headers): RequestMeta {
    return {}
  },
}
