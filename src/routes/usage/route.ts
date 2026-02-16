import { Hono } from 'hono'

import { GitHubClient } from '~/clients'
import { getClientConfig } from '~/lib/client-config'
import { state } from '~/lib/state'

export const usageRoute = new Hono()

usageRoute.get('/', async (c) => {
  const githubClient = new GitHubClient(state.auth, getClientConfig(state))
  const usage = await githubClient.getCopilotUsage()
  return c.json(usage)
})
