import consola from "consola"

import { GitHubClient } from "~/clients"

import { getClientConfig } from "./client-config"
import { getCachedConfig, writeConfigField } from "./config"
import { HTTPError } from "./error"
import { state } from "./state"
import { cacheVSCodeVersion } from "./utils"

const writeGithubToken = async (token: string): Promise<void> => {
  await writeConfigField("githubToken", token)
}

export const setupCopilotToken = async () => {
  await ensureVSCodeVersion()
  const githubClient = createGitHubClient()
  const { token, refresh_in } = await githubClient.getCopilotToken()
  state.auth.copilotToken = token

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.config.showToken) {
    consola.info("Copilot token:", token)
  }

  const refreshInterval = (refresh_in - 60) * 1000
  const refreshCopilotToken = async () => {
    consola.debug("Refreshing Copilot token")
    try {
      const { token } = await githubClient.getCopilotToken()
      state.auth.copilotToken = token
      consola.debug("Copilot token refreshed")
      if (state.config.showToken) {
        consola.info("Refreshed Copilot token:", token)
      }
    } catch (error) {
      consola.error("Failed to refresh Copilot token:", error)
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
    const githubToken = cachedToken?.trim() || ""

    if (githubToken && !options?.force) {
      state.auth.githubToken = githubToken
      if (state.config.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      try {
        await logUser()
        return
      } catch (error) {
        if (isAuthError(error) && !options?.force) {
          consola.warn(
            "Stored GitHub token invalid or expired. Re-authenticating...",
          )
          await setupGitHubToken({ force: true })
          return
        }
        throw error
      }
    }

    consola.info("Not logged in, getting new access token")
    const githubClient = createGitHubClient()
    const response = await githubClient.getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await githubClient.pollAccessToken(response)
    await writeGithubToken(token)
    state.auth.githubToken = token

    if (state.config.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

const isAuthError = (error: unknown) =>
  error instanceof HTTPError
  && (error.response.status === 401 || error.response.status === 403)

async function logUser() {
  const githubClient = createGitHubClient()
  const user = await githubClient.getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}

const createGitHubClient = () =>
  new GitHubClient(state.auth, getClientConfig(state))

const ensureVSCodeVersion = async () => {
  if (!state.cache.vsCodeVersion) {
    await cacheVSCodeVersion()
  }
}
