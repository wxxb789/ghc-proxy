import { state } from '~/lib/state'

/**
 * Core handler for retrieving the token.
 */
export function handleTokenCore(): object {
  return {
    token: state.auth.copilotToken,
  }
}
