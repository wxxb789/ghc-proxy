import type { AccountRuntime } from '~/state'
import type { AuthStore } from '~/state/auth'
import type { DeviceCodeResponse, GithubUserResponse } from '~/types'

import { GitHubClient } from '~/clients'
import {
  cacheModels,
  cacheVSCodeVersion,
  createCopilotClient,
  getClientConfig,
} from '~/clients/factory'
import { applyGheDomain } from '~/clients/ghe-domain'
import { normalizeAccountName } from '~/lib/account-routing'
import { setupCopilotToken } from '~/lib/token'
import { createAccountRuntime, runWithAccountRuntime } from '~/state'

interface DeviceAuthenticationClient {
  getDeviceCode: () => Promise<DeviceCodeResponse>
  getGitHubUser: () => Promise<GithubUserResponse>
  pollAccessToken: (
    deviceCode: DeviceCodeResponse,
    options?: { signal?: AbortSignal },
  ) => Promise<string>
}

export interface AccountDeviceAuthenticationDependencies {
  activateCopilot: (runtime: AccountRuntime) => Promise<() => void>
  createClient: (runtime: AccountRuntime) => DeviceAuthenticationClient
  loadModels: (runtime: AccountRuntime) => Promise<void>
  now: () => number
  prepareRuntime: (runtime: AccountRuntime) => Promise<void>
}

export interface BeginAccountDeviceAuthenticationOptions {
  accountName: string
  authDefaults?: Partial<AuthStore>
  gheDomain?: string
  signal?: AbortSignal
}

export interface AccountDeviceAuthorization {
  expiresAt: string
  pollIntervalSeconds: number
  userCode: string
  verificationUri: string
}

export interface AuthenticatedAccount {
  githubToken: string
  runtime: AccountRuntime
  stopRefresh: () => void
}

const defaultDependencies: AccountDeviceAuthenticationDependencies = {
  activateCopilot: runtime => runWithAccountRuntime(runtime, setupCopilotToken),
  createClient: runtime => runWithAccountRuntime(
    runtime,
    () => new GitHubClient(runtime.auth, getClientConfig()),
  ),
  loadModels: runtime => runWithAccountRuntime(
    runtime,
    () => cacheModels(createCopilotClient()),
  ),
  now: Date.now,
  prepareRuntime: runtime => runWithAccountRuntime(runtime, cacheVSCodeVersion),
}

export async function beginAccountDeviceAuthentication(
  options: BeginAccountDeviceAuthenticationOptions,
  dependencyOverrides: Partial<AccountDeviceAuthenticationDependencies> = {},
): Promise<{
  authorization: AccountDeviceAuthorization
  completion: Promise<AuthenticatedAccount>
}> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides }
  const runtime = createAccountRuntime(
    normalizeAccountName(options.accountName),
    options.authDefaults,
  )
  applyGheDomain(runtime.auth, undefined, options.gheDomain)

  await dependencies.prepareRuntime(runtime)
  const client = dependencies.createClient(runtime)
  const deviceCode = await client.getDeviceCode()
  const completion = completeAccountDeviceAuthentication(
    runtime,
    client,
    deviceCode,
    options.signal,
    dependencies,
  )

  return {
    authorization: {
      userCode: deviceCode.user_code,
      verificationUri: deviceCode.verification_uri,
      expiresAt: new Date(
        dependencies.now() + deviceCode.expires_in * 1_000,
      ).toISOString(),
      pollIntervalSeconds: deviceCode.interval,
    },
    completion,
  }
}

async function completeAccountDeviceAuthentication(
  runtime: AccountRuntime,
  client: DeviceAuthenticationClient,
  deviceCode: DeviceCodeResponse,
  signal: AbortSignal | undefined,
  dependencies: AccountDeviceAuthenticationDependencies,
): Promise<AuthenticatedAccount> {
  const githubToken = await client.pollAccessToken(deviceCode, { signal })
  signal?.throwIfAborted()
  runtime.auth.githubToken = githubToken

  const user = await client.getGitHubUser()
  signal?.throwIfAborted()
  runtime.auth.githubLogin = user.login
  runtime.auth.githubValidatedAt = dependencies.now()

  const stopRefresh = await dependencies.activateCopilot(runtime)
  try {
    signal?.throwIfAborted()
    await dependencies.loadModels(runtime)
    signal?.throwIfAborted()
  }
  catch (error) {
    stopRefresh()
    throw error
  }

  return { githubToken, runtime, stopRefresh }
}
