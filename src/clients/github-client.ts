import type { ClientAuth, ClientConfig, ClientDeps } from './types'

import type {
  CopilotUsageResponse,
  DeviceCodeResponse,
  GetCopilotTokenResponse,
  GithubUserResponse,
} from '~/types'

import consola from 'consola'
import {
  GITHUB_API_BASE_URL,
  GITHUB_APP_SCOPES,
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  githubHeaders,
  standardHeaders,
} from '~/lib/api-config'
import { throwUpstreamError } from '~/lib/error'

import { sleep } from '~/lib/sleep'

export class GitHubClient {
  private auth: ClientAuth
  private config: ClientConfig
  private fetchImpl: typeof fetch

  constructor(auth: ClientAuth, config: ClientConfig, deps?: ClientDeps) {
    this.auth = auth
    this.config = config
    this.fetchImpl = deps?.fetch ?? fetch
  }

  /** Fetch JSON from a GitHub API endpoint with standard github headers and error handling */
  private async requestJson<T>(
    url: string,
    init: RequestInit,
    errorMessage: string,
  ): Promise<T> {
    const response = await this.fetchImpl(url, init)

    if (!response.ok) {
      await throwUpstreamError(errorMessage, response)
    }

    return (await response.json()) as T
  }

  async getCopilotUsage(): Promise<CopilotUsageResponse> {
    return this.requestJson<CopilotUsageResponse>(
      `${GITHUB_API_BASE_URL}/copilot_internal/user`,
      { headers: githubHeaders(this.auth, this.config) },
      'Failed to get Copilot usage',
    )
  }

  async getCopilotToken(): Promise<GetCopilotTokenResponse> {
    return this.requestJson<GetCopilotTokenResponse>(
      `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
      { headers: githubHeaders(this.auth, this.config) },
      'Failed to get Copilot token',
    )
  }

  async getDeviceCode(): Promise<DeviceCodeResponse> {
    return this.requestJson<DeviceCodeResponse>(
      `${GITHUB_BASE_URL}/login/device/code`,
      {
        method: 'POST',
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          scope: GITHUB_APP_SCOPES,
        }),
      },
      'Failed to get device code',
    )
  }

  async pollAccessToken(deviceCode: DeviceCodeResponse): Promise<string> {
    const MAX_POLL_ATTEMPTS = 60 // ~5 minutes at 5s intervals
    const sleepDuration = (deviceCode.interval + 1) * 1000
    consola.debug(`Polling access token with interval of ${sleepDuration}ms`)

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const response = await this.fetchImpl(
        `${GITHUB_BASE_URL}/login/oauth/access_token`,
        {
          method: 'POST',
          headers: standardHeaders(),
          body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            device_code: deviceCode.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        },
      )

      if (!response.ok) {
        await sleep(sleepDuration)
        consola.error('Failed to poll access token:', await response.text())
        continue
      }

      const json = (await response.json()) as AccessTokenResponse
      consola.debug('Polling access token response:', json)

      if (json.access_token) {
        return json.access_token
      }

      await sleep(sleepDuration)
    }

    throw new Error('Device code authorization timed out')
  }

  async getGitHubUser(): Promise<GithubUserResponse> {
    return this.requestJson<GithubUserResponse>(
      `${GITHUB_API_BASE_URL}/user`,
      {
        headers: {
          authorization: `token ${this.auth.githubToken}`,
          ...standardHeaders(),
        },
      },
      'Failed to get GitHub user',
    )
  }
}

interface AccessTokenResponse {
  access_token: string
  token_type: string
  scope: string
}
