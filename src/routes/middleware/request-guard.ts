import type { MiddlewareHandler } from "hono"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"

export const requestGuard: MiddlewareHandler = async (c, next) => {
  void c
  await checkRateLimit(state)

  if (state.config.manualApprove) {
    await awaitApproval()
  }

  await next()
}
