import type { ResponsesPayload } from '~/types'

import consola from 'consola'

/**
 * Strip `phase` from input message items.
 *
 * `phase` (`commentary` / `final_answer`) is an output-only annotation. Some
 * models reject it when it is sent back as input — this repo traced an
 * upstream `400 invalid_request_body` to exactly that (see
 * `docs/investigation-responses-404.md`).
 *
 * Both Responses dispatch paths must call this. `POST /responses` receives the
 * field from clients replaying prior output; the `/v1/messages` → Responses
 * strategy has the translator *generate* it (see `resolveAssistantPhase` in
 * `translator/responses/response-items.ts`), so neither path is exempt.
 */
export function stripPhaseFromInputMessages(payload: ResponsesPayload): number {
  if (!Array.isArray(payload.input)) {
    return 0
  }

  let stripped = 0
  for (const item of payload.input) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const rec = item as Record<string, unknown>
    const isMessage = !('type' in rec) || rec.type === 'message'
    if (isMessage && 'phase' in rec) {
      delete rec.phase
      stripped++
    }
  }

  if (stripped > 0) {
    consola.debug(`Stripped phase from ${stripped} input message item(s)`)
  }
  return stripped
}
