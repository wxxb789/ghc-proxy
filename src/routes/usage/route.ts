import { Hono } from 'hono'

import { GitHubClient } from '~/clients'
import { getClientConfig, state } from '~/lib/state'

/**
 * Framework-agnostic handler for retrieving usage data.
 */
export async function handleUsageCore(): Promise<object> {
  const githubClient = new GitHubClient(state.auth, getClientConfig())
  return await githubClient.getCopilotUsage()
}

export const usageRoute = new Hono()

usageRoute.get('/', async (c) => {
  return c.json(await handleUsageCore())
})
