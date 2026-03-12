import { state } from '~/lib/state'

/**
 * Framework-agnostic handler for retrieving the token.
 */
export function handleTokenCore(): object {
  return {
    token: state.auth.copilotToken,
  }
}
