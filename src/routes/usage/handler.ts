import type { CopilotUsageResponse } from '~/types'

import { GitHubClient } from '~/clients'
import { getClientConfig } from '~/clients/factory'
import { authStore } from '~/state'

/**
 * Core handler for retrieving usage data.
 */
export async function handleUsageCore(signal?: AbortSignal): Promise<CopilotUsageResponse> {
  const githubClient = new GitHubClient(authStore, getClientConfig())
  return await githubClient.getCopilotUsage(signal)
}
