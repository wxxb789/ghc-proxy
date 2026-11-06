import type { DecisionsTranslationResult } from './mapping'
import type { DecisionsRequest } from '~/types'

import { buildSystemOneRequest } from './mapping'
import { assertSystemOneRequestSupported } from './policy'

export function translateDecisionsRequest(
  payload: DecisionsRequest,
): DecisionsTranslationResult {
  assertSystemOneRequestSupported(payload)
  return buildSystemOneRequest(payload)
}
