import type { PreparedGitHubCredential } from '~/lib/credentials'
import type { GetCopilotTokenResponse } from '~/types'

import consola from 'consola'

import { GitHubClient } from '~/clients'
import { cacheVSCodeVersion, getClientConfig } from '~/clients/factory'
import { applyGheDomain, buildGitHubUrls } from '~/clients/ghe-domain'
import { writeConfigField } from '~/lib/config'
import {
  CredentialMigrationError,
  finalizeGitHubCredentialMigration,
  prepareGitHubCredential,
  preparePendingGitHubCredentialMigration,
  replaceGitHubCredentialDuringMigration,
  writeGitHubCredential,
} from '~/lib/credentials'
import { HTTPError, isTransientUpstreamStatus } from '~/lib/error'
import { PATHS } from '~/lib/paths'
import { formatErrorMessage, retryWithBackoff } from '~/lib/retry'

import {
  authStore,
  getCurrentAccountRuntime,
  modelCache,
  runWithAccountRuntime,
} from '~/state'

const TRAILING_SLASHES_RE = /\/+$/

interface RefreshSchedule {
  stopped: boolean
  timerId?: ReturnType<typeof setTimeout>
}

const refreshSchedules = new WeakMap<object, RefreshSchedule>()

export async function setupAuthTokens(
  options?: SetupGitHubTokenOptions,
): Promise<() => void> {
  const githubSetup = await setupGitHubToken(options)

  let tokenCleanup: (() => void) | undefined
  try {
    tokenCleanup = await setupCopilotToken()
  }
  catch (error) {
    if (githubSetup.migrationPending) {
      throw migrationValidationError('Copilot token validation', error)
    }
    throw error
  }

  try {
    if (githubSetup.migrationPending) {
      await finalizeGitHubCredentialMigration(authStore.githubToken ?? '')
    }
    return tokenCleanup
  }
  catch (error) {
    tokenCleanup()
    throw error
  }
}

export async function finalizePendingGitHubCredentialMigration(
  githubSetup: SetupGitHubTokenResult,
): Promise<void> {
  if (!githubSetup.migrationPending) {
    return
  }

  try {
    await fetchCopilotToken()
  }
  catch (error) {
    throw migrationValidationError('Copilot token validation', error)
  }
  await finalizeGitHubCredentialMigration(authStore.githubToken ?? '')
}

export async function setupRuntimeOverrideTokens(): Promise<() => void> {
  await ensureVSCodeVersion()
  try {
    const credential = await preparePendingGitHubCredentialMigration()
    if (credential) {
      await validateAndFinalizePendingGitHubCredentialMigration(credential)
    }
  }
  catch (error) {
    consola.warn(
      `Could not complete the pending GitHub credential migration. ${formatErrorMessage(error)} Continuing with the runtime override; the migration state was left unchanged for recovery.`,
    )
  }
  return setupCopilotToken()
}

export async function setupCopilotToken(): Promise<() => void> {
  const runtime = getCurrentAccountRuntime()
  const { githubClient, response } = await fetchCopilotToken()

  const REFRESH_BUFFER_SECONDS = 60
  const refreshInterval = Math.max(30_000, (response.refresh_in - REFRESH_BUFFER_SECONDS) * 1000)

  const previousSchedule = refreshSchedules.get(runtime)
  if (previousSchedule) {
    previousSchedule.stopped = true
    if (previousSchedule.timerId !== undefined) {
      clearTimeout(previousSchedule.timerId)
    }
  }

  const schedule: RefreshSchedule = { stopped: false }
  refreshSchedules.set(runtime, schedule)

  const scheduleRefresh = () => {
    if (schedule.stopped)
      return
    schedule.timerId = setTimeout(() => {
      void runWithAccountRuntime(
        runtime,
        () => refreshCopilotToken(githubClient),
      ).then(scheduleRefresh)
    }, refreshInterval)
  }
  scheduleRefresh()

  return () => {
    schedule.stopped = true
    if (schedule.timerId !== undefined) {
      clearTimeout(schedule.timerId)
      schedule.timerId = undefined
    }
    if (refreshSchedules.get(runtime) === schedule) {
      refreshSchedules.delete(runtime)
    }
  }
}

export async function refreshCopilotToken(githubClient: GitHubClient): Promise<void> {
  consola.debug('Refreshing Copilot token')
  try {
    const refreshed = await retryWithBackoff(
      () => githubClient.getCopilotToken(),
      {
        shouldRetry: error => !(error instanceof HTTPError) || isTransientHttpError(error),
        onRetry: (error, attempt, delayMs) => {
          consola.warn(
            `Token refresh failed (attempt ${attempt + 1}), retrying in ${delayMs / 1000}s:`,
            formatErrorMessage(error),
          )
        },
      },
    )
    applyCopilotTokenState(refreshed)
    consola.debug('Copilot token refreshed')
    if (authStore.showToken) {
      consola.info('Refreshed Copilot token:', refreshed.token)
    }
  }
  catch (error) {
    authStore.copilotTokenLastRefreshAt = Date.now()
    authStore.copilotTokenLastRefreshSucceeded = false
    consola.error('Failed to refresh Copilot token:', error)
  }
}

interface SetupGitHubTokenOptions {
  accountName?: string
  force?: boolean
  explicitGheDomain?: {
    value?: string
  }
  validateBeforePersist?: boolean
}

interface SetupGitHubTokenResult {
  migrationPending: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<SetupGitHubTokenResult> {
  authStore.githubLogin = undefined
  authStore.githubValidatedAt = undefined
  try {
    await ensureVSCodeVersion()

    const credential = await prepareGitHubCredential(PATHS, options?.accountName)
    if (
      credential?.replacementPending
      && options?.explicitGheDomain
      && options.explicitGheDomain.value !== credential.gheDomain
    ) {
      await validateAndFinalizePendingGitHubCredentialMigration(credential)
      return setupGitHubToken({
        accountName: options.accountName,
        force: true,
        explicitGheDomain: options.explicitGheDomain,
        validateBeforePersist: true,
      })
    }
    if (credential?.replacementPending) {
      applyGheDomain(authStore, credential.gheDomain)
    }
    const githubToken = credential?.githubToken ?? ''
    let migrationPending = credential?.migrationPending ?? false
    let replacementCandidate: PreparedGitHubCredential | undefined

    if (credential?.migrationPending && options?.force) {
      try {
        await validateAndFinalizePendingGitHubCredentialMigration(credential)
        migrationPending = false
      }
      catch (error) {
        if (!isRejectedMigrationCredential(error)) {
          throw error
        }
        replacementCandidate = credential
        consola.warn(
          'Legacy GitHub credential invalid or expired. Continuing forced re-authentication; the migration backup will be kept until the replacement credential is validated.',
        )
      }
    }

    // Domain-change detection: if the configured GHE domain differs from
    // the credential's domain, the cached token is for a different
    // GitHub instance and must not be reused.
    if (
      githubToken
      && !options?.force
      && isDomainChanged(credential?.gheDomain)
    ) {
      consola.warn(
        'GHE domain changed — cached token is for a different GitHub instance. Re-authenticating...',
      )
      return setupGitHubToken({
        accountName: options?.accountName,
        force: true,
        explicitGheDomain: options?.explicitGheDomain,
      })
    }

    if (githubToken && !options?.force) {
      authStore.githubToken = githubToken
      if (authStore.showToken) {
        consola.info('GitHub token:', githubToken)
      }
      try {
        await logUser()
        return { migrationPending }
      }
      catch (error) {
        if (migrationPending) {
          throw migrationValidationError('GitHub identity validation', error)
        }
        if (isAuthError(error)) {
          consola.warn(
            'Stored GitHub token invalid or expired. Re-authenticating...',
          )
          return setupGitHubToken({
            accountName: options?.accountName,
            force: true,
            explicitGheDomain: options?.explicitGheDomain,
          })
        }
        throw error
      }
    }

    let token: string
    try {
      consola.info('Not logged in, getting new access token')
      const githubClient = createGitHubClient()
      const response = await githubClient.getDeviceCode()
      consola.debug(
        `GitHub device authorization created; expires in ${response.expires_in}s`,
      )

      consola.info(
        `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
      )

      token = await githubClient.pollAccessToken(response)
      authStore.githubToken = token

      if (authStore.showToken) {
        consola.info('GitHub token:', token)
      }
      await logUser()
      if (options?.validateBeforePersist) {
        await fetchCopilotToken()
      }
    }
    catch (error) {
      if (options?.validateBeforePersist) {
        throw new CredentialMigrationError(
          `The pending replacement credential was recovered, but the explicit GHE tenant switch failed before the new credential was persisted. The recovered credential remains active in credentials.json. Cause: ${formatErrorMessage(error)}`,
          { cause: error },
        )
      }
      throw error
    }

    if (replacementCandidate) {
      try {
        await fetchCopilotToken()
      }
      catch (error) {
        throw migrationValidationError('replacement Copilot token validation', error)
      }
      await replaceGitHubCredentialDuringMigration(
        replacementCandidate.githubToken,
        token,
        authStore.gheDomain,
      )
      migrationPending = false
    }
    else {
      await writeGitHubCredential(token, authStore.gheDomain, PATHS, options?.accountName)
    }

    if (options?.accountName === undefined) {
      // The legacy single-account mode keeps its tenant in config.json. Named
      // accounts carry their tenant beside their credential instead.
      await writeConfigField('gheDomain', authStore.gheDomain)
    }
    return { migrationPending }
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

function isRejectedMigrationCredential(error: unknown): boolean {
  return error instanceof CredentialMigrationError
    && isAuthError(error.cause)
}

function isTransientHttpError(error: HTTPError): boolean {
  return isTransientUpstreamStatus(error.status)
}

async function logUser() {
  const githubClient = createGitHubClient()
  const user = await githubClient.getGitHubUser()
  authStore.githubLogin = user.login
  authStore.githubValidatedAt = Date.now()
  consola.debug(`Logged in as ${user.login}`)
}

function createGitHubClient() {
  return new GitHubClient(authStore, getClientConfig())
}

async function validateAndFinalizePendingGitHubCredentialMigration(
  credential: PreparedGitHubCredential,
): Promise<void> {
  const { baseUrl, apiBaseUrl } = buildGitHubUrls(credential.gheDomain)
  const githubClient = new GitHubClient(
    { githubToken: credential.githubToken },
    {
      ...getClientConfig(),
      githubBaseUrl: baseUrl,
      githubApiBaseUrl: apiBaseUrl,
    },
  )

  try {
    await githubClient.getGitHubUser()
  }
  catch (error) {
    throw migrationValidationError('GitHub identity validation', error)
  }

  try {
    await githubClient.getCopilotToken()
  }
  catch (error) {
    throw migrationValidationError('Copilot token validation', error)
  }

  await finalizeGitHubCredentialMigration(credential.githubToken)
}

function applyCopilotTokenState(response: GetCopilotTokenResponse) {
  authStore.copilotToken = response.token
  authStore.copilotApiBase = normalizeCopilotApiBase(response.endpoints?.api)
  authStore.copilotTokenExpiresAt = response.expires_at * 1_000
  authStore.copilotTokenLastRefreshAt = Date.now()
  authStore.copilotTokenLastRefreshSucceeded = true
}

async function fetchCopilotToken(): Promise<{
  githubClient: GitHubClient
  response: GetCopilotTokenResponse
}> {
  await ensureVSCodeVersion()
  const githubClient = createGitHubClient()
  const response = await githubClient.getCopilotToken()
  applyCopilotTokenState(response)

  consola.debug('GitHub Copilot Token fetched successfully!')
  if (authStore.showToken) {
    consola.info('Copilot token:', response.token)
  }
  return { githubClient, response }
}

function normalizeCopilotApiBase(value?: string): string | undefined {
  if (!value) {
    return undefined
  }
  return value.replace(TRAILING_SLASHES_RE, '')
}

/**
 * Detects whether the runtime GHE domain differs from the previously persisted one.
 * Both `undefined` means "public github.com" → no change → returns false.
 */
function isDomainChanged(credentialDomain: string | undefined): boolean {
  return authStore.gheDomain !== credentialDomain
}

async function ensureVSCodeVersion() {
  if (!modelCache.getVSCodeVersion()) {
    await cacheVSCodeVersion()
  }
}

function migrationValidationError(
  stage: string,
  cause: unknown,
): CredentialMigrationError {
  return new CredentialMigrationError(
    `GitHub credential migration failed during ${stage}. The original config and migration backup were preserved. Restore from ${PATHS.CONFIG_MIGRATION_BACKUP_PATH} if needed.`,
    { cause },
  )
}
