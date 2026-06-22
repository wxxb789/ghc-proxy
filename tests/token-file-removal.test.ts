import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), 'ghc-proxy-test-token-'),
)

await mock.module('node:os', () => ({
  ...os,
  homedir: () => tempDir,
}))

await mock.module('consola', () => ({
  default: {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
}))

const mockPollAccessToken = mock(() => Promise.resolve('new-test-token'))
await mock.module('../src/clients/vscode-client', () => ({
  getVSCodeVersion: mock(() => Promise.resolve('1.91.0')),
}))

await mock.module('../src/clients/github-client', () => ({
  GitHubClient: class {
    constructor(_auth?: unknown, _config?: unknown, _deps?: { fetch?: typeof fetch }) {}

    getGitHubUser = () => Promise.resolve({ login: 'test-user' })
    getDeviceCode = () =>
      Promise.resolve({
        user_code: '1234',
        verification_uri: 'http://test',
        device_code: 'dc',
        expires_in: 60,
        interval: 1,
      })

    pollAccessToken = mockPollAccessToken
    getCopilotToken = () =>
      Promise.resolve({ token: 'copilot-token', refresh_in: 1800 })

    getCopilotUsage = () =>
      Promise.resolve({ seat_breakdown: {}, total_suggestions_count: 0 })
  },
}))

const { PATHS, ensurePaths } = await import('../src/lib/paths')
const { setupGitHubToken } = await import('../src/lib/token')
const { authStore, modelCache } = await import('../src/state')
const { readConfig } = await import('../src/lib/config')

function resetStores() {
  authStore.githubToken = undefined
  authStore.copilotToken = undefined
  authStore.copilotApiBase = undefined
  authStore.gheDomain = undefined
  authStore.githubLogin = undefined
  authStore.accountType = 'individual'
  authStore.manualApprove = false
  authStore.rateLimitWait = false
  authStore.showToken = false
  authStore.rateLimitSeconds = undefined
  authStore.upstreamTimeoutSeconds = undefined
  modelCache.clearModels()
  modelCache.clearVSCodeVersion()
}

describe('Token file removal: config.json-only persistence', () => {
  beforeEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
    await fs.mkdir(tempDir, { recursive: true })

    resetStores()
    mockPollAccessToken.mockClear()
  })

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('ensurePaths() creates APP_DIR', async () => {
    await ensurePaths()

    const appDirExists = await fs
      .access(PATHS.APP_DIR)
      .then(() => true)
      .catch(() => false)
    expect(appDirExists).toBe(true)
  })

  test('setupGitHubToken() should NOT read from the old token file', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({}))
    await readConfig()

    await setupGitHubToken()

    expect(authStore.githubToken).toBe('new-test-token')
  })

  test('setupGitHubToken() should write to config.json only', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({}))
    await readConfig()

    await setupGitHubToken({ force: true })

    const configContent = await fs.readFile(PATHS.CONFIG_PATH)
    const config = JSON.parse(configContent.toString('utf8')) as {
      githubToken: string
    }

    expect(config.githubToken).toBe('new-test-token')
  })
})

describe('GHE domain-switch re-auth', () => {
  beforeEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
    await fs.mkdir(tempDir, { recursive: true })

    resetStores()
    mockPollAccessToken.mockClear()
  })

  test('domain changed → re-auth forced (cached token NOT reused)', async () => {
    // Simulate a previously persisted config with a github.com token and no GHE domain
    await fs.writeFile(
      PATHS.CONFIG_PATH,
      JSON.stringify({ githubToken: 'old-github-com-token' }),
    )
    await readConfig()

    // Now the user configures a GHE domain (different from persisted undefined)
    authStore.gheDomain = 'corp.ghe.com'

    await setupGitHubToken()

    // The old token must NOT be reused — device flow should have been triggered
    expect(mockPollAccessToken).toHaveBeenCalledTimes(1)
    expect(authStore.githubToken).toBe('new-test-token')

    // The new GHE domain should be persisted in config
    const configContent = await fs.readFile(PATHS.CONFIG_PATH, 'utf8')
    const config = JSON.parse(configContent) as { gheDomain?: string, githubToken?: string }
    expect(config.gheDomain).toBe('corp.ghe.com')
    expect(config.githubToken).toBe('new-test-token')
  })

  test('domain unchanged → cached token reused normally', async () => {
    // Simulate a persisted config with matching GHE domain and valid token
    await fs.writeFile(
      PATHS.CONFIG_PATH,
      JSON.stringify({
        githubToken: 'existing-ghe-token',
        gheDomain: 'corp.ghe.com',
      }),
    )
    await readConfig()

    // Runtime domain matches the persisted one
    authStore.gheDomain = 'corp.ghe.com'

    await setupGitHubToken()

    // Cached token should be reused — no device flow triggered
    expect(mockPollAccessToken).not.toHaveBeenCalled()
    expect(authStore.githubToken).toBe('existing-ghe-token')
  })

  test('both undefined (public github.com) → cached token reused', async () => {
    // No GHE domain in persisted config, no GHE domain at runtime
    await fs.writeFile(
      PATHS.CONFIG_PATH,
      JSON.stringify({ githubToken: 'public-github-token' }),
    )
    await readConfig()

    // authStore.gheDomain is undefined by default (no GHE)

    await setupGitHubToken()

    // Cached token should be reused
    expect(mockPollAccessToken).not.toHaveBeenCalled()
    expect(authStore.githubToken).toBe('public-github-token')
  })

  test('switching from GHE back to public → re-auth forced', async () => {
    // Previously used a GHE domain
    await fs.writeFile(
      PATHS.CONFIG_PATH,
      JSON.stringify({
        githubToken: 'old-ghe-token',
        gheDomain: 'corp.ghe.com',
      }),
    )
    await readConfig()

    // Now runtime has no GHE domain (public github.com)
    authStore.gheDomain = undefined

    await setupGitHubToken()

    // Domain changed (GHE → public) — must force re-auth
    expect(mockPollAccessToken).toHaveBeenCalledTimes(1)
    expect(authStore.githubToken).toBe('new-test-token')
  })
})
