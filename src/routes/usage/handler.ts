import { GitHubClient } from '~/clients'
import { getClientConfig, state } from '~/lib/state'

/**
 * Core handler for retrieving usage data.
 */
export async function handleUsageCore(): Promise<object> {
  const githubClient = new GitHubClient(state.auth, getClientConfig())
  return await githubClient.getCopilotUsage()
}
