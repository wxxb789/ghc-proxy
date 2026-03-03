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
import { HTTPError } from '~/lib/error'

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

  async getCopilotUsage(): Promise<CopilotUsageResponse> {
    const response = await this.fetchImpl(
      `${GITHUB_API_BASE_URL}/copilot_internal/user`,
      {
        headers: githubHeaders(this.auth, this.config),
      },
    )

    if (!response.ok) {
      throw new HTTPError('Failed to get Copilot usage', response)
    }

    return (await response.json()) as CopilotUsageResponse
  }

  async getCopilotToken(): Promise<GetCopilotTokenResponse> {
    const response = await this.fetchImpl(
      `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
      {
        headers: githubHeaders(this.auth, this.config),
      },
    )

    if (!response.ok) {
      throw new HTTPError('Failed to get Copilot token', response)
    }

    return (await response.json()) as GetCopilotTokenResponse
  }

  async getDeviceCode(): Promise<DeviceCodeResponse> {
    const response = await this.fetchImpl(
      `${GITHUB_BASE_URL}/login/device/code`,
      {
        method: 'POST',
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          scope: GITHUB_APP_SCOPES,
        }),
      },
    )

    if (!response.ok) {
      throw new HTTPError('Failed to get device code', response)
    }

    return (await response.json()) as DeviceCodeResponse
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
    const response = await this.fetchImpl(`${GITHUB_API_BASE_URL}/user`, {
      headers: {
        authorization: `token ${this.auth.githubToken}`,
        ...standardHeaders(),
      },
    })

    if (!response.ok) {
      throw new HTTPError('Failed to get GitHub user', response)
    }

    return (await response.json()) as GithubUserResponse
  }
}

interface AccessTokenResponse {
  access_token: string
  token_type: string
  scope: string
}
