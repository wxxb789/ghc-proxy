import type { ProtocolHandler } from './types'
import type { SystemOneRequest } from '~/types'

import { parseSystemOneRequest } from './validation'

export const systemOneProtocol: ProtocolHandler<SystemOneRequest> = {
  parse: parseSystemOneRequest,
  extractMeta: () => ({}),
}
