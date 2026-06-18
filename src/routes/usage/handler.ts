import { GitHubClient } from '~/clients'
import { getClientConfig } from '~/clients/factory'
import { authStore } from '~/state'

/**
 * Core handler for retrieving usage data.
 */
export async function handleUsageCore(): Promise<object> {
  const githubClient = new GitHubClient(authStore, getClientConfig())
  return await githubClient.getCopilotUsage()
}
