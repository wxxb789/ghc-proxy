import { Hono } from 'hono'

import { GitHubClient } from '~/clients'
import { getClientConfig, state } from '~/lib/state'

export const usageRoute = new Hono()

usageRoute.get('/', async (c) => {
  const githubClient = new GitHubClient(state.auth, getClientConfig())
  const usage = await githubClient.getCopilotUsage()
  return c.json(usage)
})
