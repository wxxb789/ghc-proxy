import { Hono } from 'hono'

import { state } from '~/lib/state'

/**
 * Framework-agnostic handler for retrieving the token.
 */
export function handleTokenCore(): object {
  return {
    token: state.auth.copilotToken,
  }
}

export const tokenRoute = new Hono()

tokenRoute.get('/', (c) => {
  return c.json(handleTokenCore())
})
