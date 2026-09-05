import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import consola from 'consola'

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghc-proxy-probe-bootstrap-'))
const paths = {
  ACCOUNT_MANAGEMENT_JOURNAL_PATH: path.join(tempDir, 'account-management-transaction.json'),
  APP_DIR: tempDir,
  CONFIG_PATH: path.join(tempDir, 'config.json'),
  CREDENTIALS_PATH: path.join(tempDir, 'credentials.json'),
  CONFIG_MIGRATION_BACKUP_PATH: path.join(tempDir, 'config.json.github-token-migration.bak'),
}

mock.module('../src/lib/paths', () => ({
  PATHS: paths,
  ensurePaths: () => fs.mkdir(paths.APP_DIR, { recursive: true }),
}))

const { bootstrapProbe } = await import('../scripts/lib/probe-harness')
const { CopilotClient, GitHubClient } = await import('../src/clients')
const { getCachedConfig } = await import('../src/lib/config')
const { authStore, modelCache } = await import('../src/state')

const originalFetch = globalThis.fetch
const originalGetGitHubUser = GitHubClient.prototype.getGitHubUser
const originalGetCopilotToken = GitHubClient.prototype.getCopilotToken
const originalGetDeviceCode = GitHubClient.prototype.getDeviceCode
const originalGetModels = CopilotClient.prototype.getModels
const originalConsolaLevel = consola.level
let cachedConfigSnapshot: Record<string, unknown> = {}
let authStoreSnapshot = snapshotAuthStore()
let modelsSnapshot = modelCache.getModels()
let vsCodeVersionSnapshot = modelCache.getVSCodeVersion()

function snapshotAuthStore() {
  return {
    githubToken: authStore.githubToken,
    copilotToken: authStore.copilotToken,
    copilotApiBase: authStore.copilotApiBase,
    gheDomain: authStore.gheDomain,
    githubLogin: authStore.githubLogin,
    githubValidatedAt: authStore.githubValidatedAt,
    copilotTokenExpiresAt: authStore.copilotTokenExpiresAt,
    copilotTokenLastRefreshAt: authStore.copilotTokenLastRefreshAt,
    copilotTokenLastRefreshSucceeded: authStore.copilotTokenLastRefreshSucceeded,
    accountType: authStore.accountType,
    manualApprove: authStore.manualApprove,
    rateLimitWait: authStore.rateLimitWait,
    showToken: authStore.showToken,
    upstreamTimeoutSeconds: authStore.upstreamTimeoutSeconds,
  }
}

function restoreAuthStore(snapshot: ReturnType<typeof snapshotAuthStore>) {
  authStore.githubToken = snapshot.githubToken
  authStore.copilotToken = snapshot.copilotToken
  authStore.copilotApiBase = snapshot.copilotApiBase
  authStore.gheDomain = snapshot.gheDomain
  authStore.githubLogin = snapshot.githubLogin
  authStore.githubValidatedAt = snapshot.githubValidatedAt
  authStore.copilotTokenExpiresAt = snapshot.copilotTokenExpiresAt
  authStore.copilotTokenLastRefreshAt = snapshot.copilotTokenLastRefreshAt
  authStore.copilotTokenLastRefreshSucceeded = snapshot.copilotTokenLastRefreshSucceeded
  authStore.accountType = snapshot.accountType
  authStore.manualApprove = snapshot.manualApprove
  authStore.rateLimitWait = snapshot.rateLimitWait
  authStore.showToken = snapshot.showToken
  authStore.upstreamTimeoutSeconds = snapshot.upstreamTimeoutSeconds
}

describe('bootstrapProbe', () => {
  beforeEach(async () => {
    authStoreSnapshot = snapshotAuthStore()
    modelsSnapshot = modelCache.getModels()
    vsCodeVersionSnapshot = modelCache.getVSCodeVersion()
    cachedConfigSnapshot = structuredClone(getCachedConfig()) as Record<string, unknown>
    await fs.rm(tempDir, { recursive: true, force: true })
    await fs.mkdir(tempDir, { recursive: true })

    globalThis.fetch = (async () => new Response('pkgver=1.105.0')) as unknown as typeof fetch
  })

  afterEach(() => {
    GitHubClient.prototype.getGitHubUser = originalGetGitHubUser
    GitHubClient.prototype.getCopilotToken = originalGetCopilotToken
    GitHubClient.prototype.getDeviceCode = originalGetDeviceCode
    CopilotClient.prototype.getModels = originalGetModels
    globalThis.fetch = originalFetch
    consola.level = originalConsolaLevel
    const cachedConfig = getCachedConfig() as Record<string, unknown>
    for (const key of Object.keys(cachedConfig)) {
      delete cachedConfig[key]
    }
    Object.assign(cachedConfig, cachedConfigSnapshot)
    restoreAuthStore(authStoreSnapshot)
    if (modelsSnapshot === undefined) {
      modelCache.clearModels()
    }
    else {
      modelCache.cacheModels(modelsSnapshot)
    }
    if (vsCodeVersionSnapshot === undefined) {
      modelCache.clearVSCodeVersion()
    }
    else {
      modelCache.setVSCodeVersion(vsCodeVersionSnapshot)
    }
  })

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('applies persisted GHE domain and finalizes a validated legacy credential migration without device flow', async () => {
    await fs.writeFile(paths.CONFIG_PATH, JSON.stringify({
      gheDomain: 'company.ghe.com',
      githubToken: 'legacy-token',
    }))

    let deviceFlowCalls = 0
    GitHubClient.prototype.getGitHubUser = async () => ({ login: 'ghe-user', id: 1 })
    GitHubClient.prototype.getCopilotToken = async () => ({
      token: 'copilot-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_in: 1800,
    })
    GitHubClient.prototype.getDeviceCode = async () => {
      deviceFlowCalls++
      throw new Error('device flow must not start')
    }
    CopilotClient.prototype.getModels = async () => ({ data: [], object: 'list' })

    const cleanup = await bootstrapProbe({ silent: true })
    cleanup()

    expect(authStore.gheDomain).toBe('company.ghe.com')
    expect(authStore.githubToken).toBe('legacy-token')
    expect(authStore.copilotToken).toBe('copilot-token')
    expect(deviceFlowCalls).toBe(0)
    expect(JSON.parse(await fs.readFile(paths.CONFIG_PATH, 'utf8'))).toEqual({
      gheDomain: 'company.ghe.com',
    })
    await expect(fs.access(paths.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
  })
})
