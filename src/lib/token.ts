import type { GetCopilotTokenResponse } from '~/types'

import consola from 'consola'

import { GitHubClient } from '~/clients'

import { getCachedConfig, writeConfigField } from './config'
import { HTTPError } from './error'
import { cacheVSCodeVersion, getClientConfig, state } from './state'

const TRAILING_SLASHES_RE = /\/+$/

async function writeGithubToken(token: string): Promise<void> {
  await writeConfigField('githubToken', token)
}

export async function setupCopilotToken() {
  await ensureVSCodeVersion()
  const githubClient = createGitHubClient()
  const response = await githubClient.getCopilotToken()
  applyCopilotTokenState(response)

  consola.debug('GitHub Copilot Token fetched successfully!')
  if (state.config.showToken) {
    consola.info('Copilot token:', response.token)
  }

  const REFRESH_BUFFER_SECONDS = 60
  const refreshInterval = (response.refresh_in - REFRESH_BUFFER_SECONDS) * 1000
  const refreshCopilotToken = async () => {
    consola.debug('Refreshing Copilot token')
    try {
      const refreshed = await githubClient.getCopilotToken()
      applyCopilotTokenState(refreshed)
      consola.debug('Copilot token refreshed')
      if (state.config.showToken) {
        consola.info('Refreshed Copilot token:', refreshed.token)
      }
    }
    catch (error) {
      consola.error('Failed to refresh Copilot token:', error)
    }
  }

  setInterval(() => {
    void refreshCopilotToken()
  }, refreshInterval)
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    await ensureVSCodeVersion()

    const cachedToken = getCachedConfig().githubToken
    const githubToken = cachedToken?.trim() || ''

    if (githubToken && !options?.force) {
      state.auth.githubToken = githubToken
      if (state.config.showToken) {
        consola.info('GitHub token:', githubToken)
      }
      try {
        await logUser()
        return
      }
      catch (error) {
        if (isAuthError(error) && !options?.force) {
          consola.warn(
            'Stored GitHub token invalid or expired. Re-authenticating...',
          )
          await setupGitHubToken({ force: true })
          return
        }
        throw error
      }
    }

    consola.info('Not logged in, getting new access token')
    const githubClient = createGitHubClient()
    const response = await githubClient.getDeviceCode()
    consola.debug('Device code response:', response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await githubClient.pollAccessToken(response)
    await writeGithubToken(token)
    state.auth.githubToken = token

    if (state.config.showToken) {
      consola.info('GitHub token:', token)
    }
    await logUser()
  }
  catch (error) {
    if (error instanceof HTTPError) {
      consola.error('Failed to get GitHub token:', error.body)
      throw error
    }

    consola.error('Failed to get GitHub token:', error)
    throw error
  }
}

function isAuthError(error: unknown) {
  return error instanceof HTTPError
    && (error.status === 401 || error.status === 403)
}

async function logUser() {
  const githubClient = createGitHubClient()
  const user = await githubClient.getGitHubUser()
  state.cache.githubLogin = user.login
  consola.debug(`Logged in as ${user.login}`)
}

function createGitHubClient() {
  return new GitHubClient(state.auth, getClientConfig())
}

function applyCopilotTokenState(response: GetCopilotTokenResponse) {
  state.auth.copilotToken = response.token
  state.auth.copilotApiBase = normalizeCopilotApiBase(response.endpoints?.api)
}

function normalizeCopilotApiBase(value?: string): string | undefined {
  if (!value) {
    return undefined
  }
  return value.replace(TRAILING_SLASHES_RE, '')
}

async function ensureVSCodeVersion() {
  if (!state.cache.vsCodeVersion) {
    await cacheVSCodeVersion()
  }
}
