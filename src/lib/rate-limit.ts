import consola from "consola"

import type { AppState } from "./state"

import { HTTPError } from "./error"
import { sleep } from "./utils"

export async function checkRateLimit(state: AppState) {
  if (state.config.rateLimitSeconds === undefined) return

  const now = Date.now()

  if (!state.rateLimit.lastRequestTimestamp) {
    state.rateLimit.lastRequestTimestamp = now
    return
  }

  const elapsedSeconds = (now - state.rateLimit.lastRequestTimestamp) / 1000

  if (elapsedSeconds > state.config.rateLimitSeconds) {
    state.rateLimit.lastRequestTimestamp = now
    return
  }

  const waitTimeSeconds = Math.ceil(
    state.config.rateLimitSeconds - elapsedSeconds,
  )

  if (!state.config.rateLimitWait) {
    consola.warn(
      `Rate limit exceeded. Need to wait ${waitTimeSeconds} more seconds.`,
    )
    throw new HTTPError(
      "Rate limit exceeded",
      Response.json({ message: "Rate limit exceeded" }, { status: 429 }),
    )
  }

  const waitTimeMs = waitTimeSeconds * 1000
  consola.warn(
    `Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`,
  )
  await sleep(waitTimeMs)
  // eslint-disable-next-line require-atomic-updates
  state.rateLimit.lastRequestTimestamp = now
  consola.info("Rate limit wait completed, proceeding with request")
  return
}
