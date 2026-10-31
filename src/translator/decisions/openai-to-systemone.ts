import type { DecisionsTranslationResult } from './mapping'
import type { DecisionsRequest } from '~/types'

import { buildSystemOneRequest } from './mapping'
import { assertDecisionsRequestSupported } from './policy'

export function translateDecisionsRequest(
  payload: DecisionsRequest,
): DecisionsTranslationResult {
  assertDecisionsRequestSupported(payload)
  return buildSystemOneRequest(payload)
}
