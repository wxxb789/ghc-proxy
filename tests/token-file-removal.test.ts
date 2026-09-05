import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), 'ghc-proxy-test-token-'),
)

const testPaths = {
  APP_DIR: tempDir,
  CONFIG_PATH: path.join(tempDir, 'config.json'),
  CREDENTIALS_PATH: path.join(tempDir, 'credentials.json'),
  CONFIG_MIGRATION_BACKUP_PATH: path.join(tempDir, 'config.json.github-token-migration.bak'),
}

await mock.module('../src/lib/paths', () => ({
  PATHS: testPaths,
  ensurePaths: () => fs.mkdir(testPaths.APP_DIR, { recursive: true }),
}))

const mockInfo = mock(() => {})
const mockWarn = mock(() => {})
const mockError = mock(() => {})
const mockSuccess = mock(() => {})
await mock.module('consola', () => ({
  default: {
    level: 0,
    info: mockInfo,
    debug: mock(() => {}),
    warn: mockWarn,
    error: mockError,
    success: mockSuccess,
  },
}))

const listenCalls: Array<number> = []
await mock.module('../src/server', () => ({
  createServer: () => ({
    listen: (port: number) => {
      listenCalls.push(port)
    },
    stop: async () => {},
  }),
}))

await mock.module('../src/cli/startup-banner', () => ({
  printStartupBanner: mock(() => {}),
}))

let githubUserFailure: unknown
let copilotTokenFailure: unknown
const githubUserFailuresByToken = new Map<string, unknown>()
const copilotTokenFailuresByToken = new Map<string, unknown>()
const githubUserTokens: Array<string | undefined> = []
const githubUserApiBaseUrls: Array<string | undefined> = []
const copilotTokenTokens: Array<string | undefined> = []
const mockPollAccessToken = mock(() => Promise.resolve('new-test-token'))
const mockGetGitHubUser = mock(() => {
  if (githubUserFailure) {
    return Promise.reject(githubUserFailure)
  }
  return Promise.resolve({ login: 'test-user' })
})
const mockGetCopilotToken = mock(() => {
  if (copilotTokenFailure) {
    return Promise.reject(copilotTokenFailure)
  }
  return Promise.resolve({
    token: 'copilot-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_in: 1800,
  })
})

await mock.module('../src/clients/vscode-client', () => ({
  getVSCodeVersion: mock(() => Promise.resolve('1.91.0')),
}))

await mock.module('../src/clients/github-client', () => ({
  GitHubClient: class {
    private readonly auth: { githubToken?: string }
    private readonly config: { githubApiBaseUrl?: string }

    constructor(
      auth?: { githubToken?: string },
      config?: { githubApiBaseUrl?: string },
      _deps?: { fetch?: typeof fetch },
    ) {
      this.auth = auth ?? {}
      this.config = config ?? {}
    }

    getGitHubUser = () => {
      githubUserTokens.push(this.auth.githubToken)
      githubUserApiBaseUrls.push(this.config.githubApiBaseUrl)
      const failure = githubUserFailuresByToken.get(this.auth.githubToken ?? '')
      if (failure) {
        return Promise.reject(failure)
      }
      return mockGetGitHubUser()
    }

    getDeviceCode = () =>
      Promise.resolve({
        user_code: '1234',
        verification_uri: 'http://test',
        device_code: 'dc',
        expires_in: 60,
        interval: 1,
      })

    pollAccessToken = mockPollAccessToken
    getCopilotToken = () => {
      copilotTokenTokens.push(this.auth.githubToken)
      const failure = copilotTokenFailuresByToken.get(this.auth.githubToken ?? '')
      if (failure) {
        return Promise.reject(failure)
      }
      return mockGetCopilotToken()
    }

    getCopilotUsage = () =>
      Promise.resolve({ seat_breakdown: {}, total_suggestions_count: 0 })
  },
}))

const { PATHS, ensurePaths } = await import('../src/lib/paths')
const { auth } = await import('../src/auth')
const { start } = await import('../src/start')
const { CopilotClient } = await import('../src/clients')
const {
  prepareGitHubCredential,
  readGitHubCredential,
  writeGitHubCredential,
} = await import('../src/lib/credentials')
const {
  finalizePendingGitHubCredentialMigration,
  setupAuthTokens,
  setupGitHubToken,
  setupRuntimeOverrideTokens,
} = await import('../src/lib/token')
const { HTTPError } = await import('../src/lib/error')
const { authStore, modelCache } = await import('../src/state')
const { getCachedConfig, readConfig } = await import('../src/lib/config')

const originalGetModels = CopilotClient.prototype.getModels
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout

type AuthRunContext = Parameters<NonNullable<typeof auth.run>>[0]
type AuthArgs = AuthRunContext['args']
type StartRunContext = Parameters<NonNullable<typeof start.run>>[0]
type StartArgs = StartRunContext['args']

function resetStores() {
  authStore.githubToken = undefined
  authStore.copilotToken = undefined
  authStore.copilotApiBase = undefined
  authStore.gheDomain = undefined
  authStore.githubLogin = undefined
  authStore.githubValidatedAt = undefined
  authStore.accountType = 'individual'
  authStore.manualApprove = false
  authStore.rateLimitWait = false
  authStore.showToken = false
  authStore.rateLimitSeconds = undefined
  authStore.upstreamTimeoutSeconds = undefined
  modelCache.clearModels()
  modelCache.clearVSCodeVersion()
}

function removeNewSignalListeners(
  signal: NodeJS.Signals,
  baseline: Array<(...args: Array<unknown>) => void>,
) {
  const baselineSet = new Set(baseline)
  for (const listener of process.listeners(signal)) {
    const typedListener = listener as (...args: Array<unknown>) => void
    if (!baselineSet.has(typedListener)) {
      process.removeListener(signal, typedListener)
    }
  }
}

function makeAuthArgs(overrides: Partial<AuthArgs> = {}): AuthArgs {
  const args = {
    '_': [],
    'verbose': false,
    'v': false,
    'show-token': false,
    'ghe-domain': undefined,
    'ghe': undefined,
    ...overrides,
  }
  args.v = args.verbose
  args.ghe = args['ghe-domain']
  return args as AuthArgs
}

function makeStartArgs(overrides: Partial<StartArgs> = {}): StartArgs {
  const args = {
    '_': [],
    'port': '4141',
    'p': '4141',
    'verbose': false,
    'v': false,
    'account-type': 'individual',
    'a': 'individual',
    'manual': false,
    'rate-limit': undefined,
    'r': undefined,
    'wait': false,
    'w': false,
    'github-token': undefined,
    'g': undefined,
    'claude-code': false,
    'c': false,
    'show-token': false,
    'proxy-env': false,
    'idle-timeout': '120',
    'upstream-timeout': '1800',
    'upstream-queue-concurrency': undefined,
    'upstream-queue-retries': undefined,
    'upstream-recovery-budget': undefined,
    'upstream-queue-base-delay': undefined,
    'upstream-queue-max-delay': undefined,
    'ghe-domain': undefined,
    'ghe': undefined,
    'dump-failed-payloads': false,
    'D': false,
    ...overrides,
  }
  args.p = args.port
  args.v = args.verbose
  args.a = args['account-type']
  args.r = args['rate-limit']
  args.w = args.wait
  args.g = args['github-token']
  args.c = args['claude-code']
  args.ghe = args['ghe-domain']
  args.D = args['dump-failed-payloads']
  return args as StartArgs
}

async function runAuthCommand(args: AuthArgs): Promise<void> {
  await auth.run!({ rawArgs: [], args, cmd: auth })
}

async function runStartCommand(args: StartArgs): Promise<void> {
  const sigintListeners = process.listeners('SIGINT') as Array<(...args: Array<unknown>) => void>
  const sigtermListeners = process.listeners('SIGTERM') as Array<(...args: Array<unknown>) => void>
  CopilotClient.prototype.getModels = async () => ({ data: [], object: 'list' }) as Awaited<ReturnType<typeof originalGetModels>>
  globalThis.setTimeout = ((..._args: Parameters<typeof setTimeout>) => 1 as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout
  globalThis.clearTimeout = ((..._args: Parameters<typeof clearTimeout>) => {}) as typeof clearTimeout
  try {
    await start.run!({ rawArgs: [], args, cmd: start })
  }
  finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    CopilotClient.prototype.getModels = originalGetModels
    removeNewSignalListeners('SIGINT', sigintListeners)
    removeNewSignalListeners('SIGTERM', sigtermListeners)
  }
}

describe('GitHub credential migration', () => {
  beforeEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
    await fs.mkdir(tempDir, { recursive: true })

    resetStores()
    githubUserFailure = undefined
    copilotTokenFailure = undefined
    githubUserFailuresByToken.clear()
    copilotTokenFailuresByToken.clear()
    mockPollAccessToken.mockClear()
    mockGetGitHubUser.mockClear()
    mockGetCopilotToken.mockClear()
    githubUserTokens.length = 0
    githubUserApiBaseUrls.length = 0
    copilotTokenTokens.length = 0
    mockInfo.mockClear()
    mockWarn.mockClear()
    mockError.mockClear()
    mockSuccess.mockClear()
    listenCalls.length = 0
  })

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    CopilotClient.prototype.getModels = originalGetModels
  })

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('ensurePaths() creates APP_DIR', async () => {
    await ensurePaths()

    expect(PATHS.APP_DIR).toBe(tempDir)
    const appDirExists = await fs
      .access(PATHS.APP_DIR)
      .then(() => true)
      .catch(() => false)
    expect(appDirExists).toBe(true)
  })

  test('valid legacy credential migrates after GitHub and Copilot validation', async () => {
    const legacyConfig = JSON.stringify({
      githubToken: 'legacy-token',
      gheDomain: 'corp.ghe.com',
      smallModel: 'gpt-5-mini',
    }, null, 2)
    await fs.writeFile(PATHS.CONFIG_PATH, legacyConfig)
    await readConfig()
    authStore.gheDomain = getCachedConfig().gheDomain

    const cleanup = await setupAuthTokens()
    cleanup()

    expect(mockGetGitHubUser).toHaveBeenCalledTimes(1)
    expect(mockGetCopilotToken).toHaveBeenCalledTimes(1)
    expect(mockPollAccessToken).not.toHaveBeenCalled()
    expect(authStore.githubToken).toBe('legacy-token')
    expect(await readGitHubCredential()).toMatchObject({
      githubToken: 'legacy-token',
      gheDomain: 'corp.ghe.com',
    })
    expect(JSON.parse(await fs.readFile(PATHS.CONFIG_PATH, 'utf8'))).toEqual({
      gheDomain: 'corp.ghe.com',
      smallModel: 'gpt-5-mini',
    })
    await expect(fs.access(PATHS.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
  })

  test('GitHub identity failure preserves the original config and full backup', async () => {
    const legacyConfig = '{\n  "githubToken": "legacy-token",\n  "smallModel": "gpt-5-mini"\n}\n'
    await fs.writeFile(PATHS.CONFIG_PATH, legacyConfig)
    await readConfig()
    githubUserFailure = new HTTPError(401, {
      error: { message: 'bad credentials', type: 'authentication_error' },
    })

    await expect(setupAuthTokens()).rejects.toThrow('migration backup')

    expect(mockPollAccessToken).not.toHaveBeenCalled()
    expect(mockGetCopilotToken).not.toHaveBeenCalled()
    expect(await fs.readFile(PATHS.CONFIG_PATH, 'utf8')).toBe(legacyConfig)
    expect(await fs.readFile(PATHS.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(legacyConfig)
  })

  test('Copilot token failure preserves the original config and full backup', async () => {
    const legacyConfig = JSON.stringify({ githubToken: 'legacy-token', smallModel: 'gpt-5-mini' })
    await fs.writeFile(PATHS.CONFIG_PATH, legacyConfig)
    await readConfig()
    copilotTokenFailure = new HTTPError(403, {
      error: { message: 'copilot unavailable', type: 'authentication_error' },
    })

    await expect(setupAuthTokens()).rejects.toThrow('migration backup')

    expect(mockGetGitHubUser).toHaveBeenCalledTimes(1)
    expect(mockGetCopilotToken).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(PATHS.CONFIG_PATH, 'utf8')).toBe(legacyConfig)
    expect(await fs.readFile(PATHS.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(legacyConfig)
  })

  test('a pending migration resumes without device login and completes idempotently', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({ githubToken: 'legacy-token' }))
    await readConfig()
    copilotTokenFailure = new Error('temporary failure')
    await expect(setupAuthTokens()).rejects.toThrow('migration backup')
    const stagedCredentials = await fs.readFile(PATHS.CREDENTIALS_PATH, 'utf8')

    resetStores()
    copilotTokenFailure = undefined
    mockPollAccessToken.mockClear()
    await readConfig()

    const cleanup = await setupAuthTokens()
    cleanup()

    expect(mockPollAccessToken).not.toHaveBeenCalled()
    expect(await fs.readFile(PATHS.CREDENTIALS_PATH, 'utf8')).toBe(stagedCredentials)
    expect(JSON.parse(await fs.readFile(PATHS.CONFIG_PATH, 'utf8'))).toEqual({})
    await expect(fs.access(PATHS.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
  })

  test('new login writes only the credential store', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({ gheDomain: 'corp.ghe.com' }))
    await readConfig()
    authStore.gheDomain = 'corp.ghe.com'

    const githubSetup = await setupGitHubToken({ force: true })
    await finalizePendingGitHubCredentialMigration(githubSetup)

    expect(mockPollAccessToken).toHaveBeenCalledTimes(1)
    expect(mockGetCopilotToken).not.toHaveBeenCalled()
    expect(await readGitHubCredential()).toMatchObject({
      githubToken: 'new-test-token',
      gheDomain: 'corp.ghe.com',
    })
    const configContent = await fs.readFile(PATHS.CONFIG_PATH, 'utf8')
    expect(configContent).not.toContain('new-test-token')
    expect(JSON.parse(configContent)).toEqual({ gheDomain: 'corp.ghe.com' })
  })

  test('forced login completes a valid legacy migration before replacing the credential', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({
      githubToken: 'legacy-token',
      gheDomain: 'corp.ghe.com',
      smallModel: 'gpt-5-mini',
    }))
    await readConfig()
    authStore.gheDomain = 'corp.ghe.com'

    const githubSetup = await setupGitHubToken({ force: true })
    await finalizePendingGitHubCredentialMigration(githubSetup)

    expect(githubSetup.migrationPending).toBe(false)
    expect(githubUserTokens).toEqual(['legacy-token', 'new-test-token'])
    expect(copilotTokenTokens).toEqual(['legacy-token'])
    expect(await readGitHubCredential()).toMatchObject({
      githubToken: 'new-test-token',
      gheDomain: 'corp.ghe.com',
    })
    expect(JSON.parse(await fs.readFile(PATHS.CONFIG_PATH, 'utf8'))).toEqual({
      gheDomain: 'corp.ghe.com',
      smallModel: 'gpt-5-mini',
    })
    await expect(fs.access(PATHS.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
  })

  test('forced login replaces an invalid legacy credential only after validating the new credential', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({
      githubToken: 'legacy-token',
      gheDomain: 'corp.ghe.com',
      smallModel: 'gpt-5-mini',
    }))
    await readConfig()
    authStore.gheDomain = 'corp.ghe.com'
    githubUserFailuresByToken.set(
      'legacy-token',
      new HTTPError(401, {
        error: { message: 'expired legacy credential', type: 'authentication_error' },
      }),
    )

    const githubSetup = await setupGitHubToken({ force: true })
    await finalizePendingGitHubCredentialMigration(githubSetup)

    expect(githubSetup.migrationPending).toBe(false)
    expect(githubUserTokens).toEqual(['legacy-token', 'new-test-token'])
    expect(copilotTokenTokens).toEqual(['new-test-token'])
    expect(await readGitHubCredential()).toMatchObject({
      githubToken: 'new-test-token',
      gheDomain: 'corp.ghe.com',
    })
    expect(JSON.parse(await fs.readFile(PATHS.CONFIG_PATH, 'utf8'))).toEqual({
      gheDomain: 'corp.ghe.com',
      smallModel: 'gpt-5-mini',
    })
    await expect(fs.access(PATHS.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
  })

  test('forced replacement keeps the legacy recovery path when the new Copilot token validation fails', async () => {
    const legacyConfig = JSON.stringify({
      githubToken: 'legacy-token',
      smallModel: 'gpt-5-mini',
    })
    await fs.writeFile(PATHS.CONFIG_PATH, legacyConfig)
    await readConfig()
    githubUserFailuresByToken.set(
      'legacy-token',
      new HTTPError(401, {
        error: { message: 'expired legacy credential', type: 'authentication_error' },
      }),
    )
    copilotTokenFailuresByToken.set(
      'new-test-token',
      new HTTPError(403, {
        error: { message: 'replacement has no Copilot access', type: 'authentication_error' },
      }),
    )

    await expect(setupGitHubToken({ force: true })).rejects.toThrow('migration backup')

    expect(githubUserTokens).toEqual(['legacy-token', 'new-test-token'])
    expect(copilotTokenTokens).toEqual(['new-test-token'])
    expect(await fs.readFile(PATHS.CONFIG_PATH, 'utf8')).toBe(legacyConfig)
    expect(await fs.readFile(PATHS.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(legacyConfig)
    expect(await readGitHubCredential()).toMatchObject({ githubToken: 'legacy-token' })
  })

  test('replacement journal restart reuses the validated GHE credential and persists its tenant', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({
      githubToken: 'legacy-token',
      gheDomain: 'old.ghe.com',
      smallModel: 'gpt-5-mini',
    }))
    await prepareGitHubCredential()
    await fs.writeFile(
      `${PATHS.CONFIG_MIGRATION_BACKUP_PATH}.replacement.json`,
      JSON.stringify({
        version: 1,
        legacyTokenDigest: createHash('sha256').update('legacy-token').digest('hex'),
        replacementTokenDigest: createHash('sha256').update('replacement-token').digest('hex'),
      }),
    )
    await writeGitHubCredential('replacement-token', 'new.ghe.com')

    resetStores()
    await readConfig()
    authStore.gheDomain = getCachedConfig().gheDomain

    const cleanup = await setupAuthTokens()
    cleanup()

    expect(mockPollAccessToken).not.toHaveBeenCalled()
    expect(githubUserTokens).toEqual(['replacement-token'])
    expect(githubUserApiBaseUrls).toEqual(['https://api.new.ghe.com'])
    expect(copilotTokenTokens).toEqual(['replacement-token'])
    expect(await readGitHubCredential()).toMatchObject({
      githubToken: 'replacement-token',
      gheDomain: 'new.ghe.com',
    })
    expect(JSON.parse(await fs.readFile(PATHS.CONFIG_PATH, 'utf8'))).toEqual({
      gheDomain: 'new.ghe.com',
      smallModel: 'gpt-5-mini',
    })
    await expect(fs.access(PATHS.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
    await expect(fs.access(`${PATHS.CONFIG_MIGRATION_BACKUP_PATH}.replacement.json`)).rejects.toThrow()
  })

  test('start honors an explicit GHE override after recovering a pending replacement', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({
      githubToken: 'legacy-token',
      gheDomain: 'old.ghe.com',
      smallModel: 'gpt-5-mini',
    }))
    await prepareGitHubCredential()
    await fs.writeFile(
      `${PATHS.CONFIG_MIGRATION_BACKUP_PATH}.replacement.json`,
      JSON.stringify({
        version: 1,
        legacyTokenDigest: createHash('sha256').update('legacy-token').digest('hex'),
        replacementTokenDigest: createHash('sha256').update('replacement-token').digest('hex'),
      }),
    )
    await writeGitHubCredential('replacement-token', 'replacement.ghe.com')

    await runStartCommand(makeStartArgs({ 'ghe-domain': 'requested.ghe.com' }))

    expect(listenCalls).toEqual([4141])
    expect(mockPollAccessToken).toHaveBeenCalledTimes(1)
    expect(githubUserTokens).toEqual(['replacement-token', 'new-test-token'])
    expect(githubUserApiBaseUrls).toEqual([
      'https://api.replacement.ghe.com',
      'https://api.requested.ghe.com',
    ])
    expect(copilotTokenTokens).toEqual([
      'replacement-token',
      'new-test-token',
      'new-test-token',
    ])
    expect(await readGitHubCredential()).toMatchObject({
      githubToken: 'new-test-token',
      gheDomain: 'requested.ghe.com',
    })
    expect(JSON.parse(await fs.readFile(PATHS.CONFIG_PATH, 'utf8'))).toEqual({
      gheDomain: 'requested.ghe.com',
      smallModel: 'gpt-5-mini',
    })
    await expect(fs.access(PATHS.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
    await expect(fs.access(`${PATHS.CONFIG_MIGRATION_BACKUP_PATH}.replacement.json`)).rejects.toThrow()
  })

  test('auth keeps the recovered replacement when an explicit public switch fails', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({
      githubToken: 'legacy-token',
      gheDomain: 'old.ghe.com',
      smallModel: 'gpt-5-mini',
    }))
    await prepareGitHubCredential()
    await fs.writeFile(
      `${PATHS.CONFIG_MIGRATION_BACKUP_PATH}.replacement.json`,
      JSON.stringify({
        version: 1,
        legacyTokenDigest: createHash('sha256').update('legacy-token').digest('hex'),
        replacementTokenDigest: createHash('sha256').update('replacement-token').digest('hex'),
      }),
    )
    await writeGitHubCredential('replacement-token', 'replacement.ghe.com')
    copilotTokenFailuresByToken.set(
      'new-test-token',
      new Error('requested tenant Copilot validation failed'),
    )

    await expect(
      runAuthCommand(makeAuthArgs({ 'ghe-domain': '' })),
    ).rejects.toThrow('explicit GHE tenant switch failed')

    expect(mockPollAccessToken).toHaveBeenCalledTimes(1)
    expect(githubUserTokens).toEqual(['replacement-token', 'new-test-token'])
    expect(githubUserApiBaseUrls).toEqual([
      'https://api.replacement.ghe.com',
      'https://api.github.com',
    ])
    expect(copilotTokenTokens).toEqual(['replacement-token', 'new-test-token'])
    expect(await readGitHubCredential()).toMatchObject({
      githubToken: 'replacement-token',
      gheDomain: 'replacement.ghe.com',
    })
    expect(JSON.parse(await fs.readFile(PATHS.CONFIG_PATH, 'utf8'))).toEqual({
      gheDomain: 'replacement.ghe.com',
      smallModel: 'gpt-5-mini',
    })
    await expect(fs.access(PATHS.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
    await expect(fs.access(`${PATHS.CONFIG_MIGRATION_BACKUP_PATH}.replacement.json`)).rejects.toThrow()
  })

  test('forced replacement completes after config cleanup but before backup deletion', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({
      githubToken: 'legacy-token',
      gheDomain: 'corp.ghe.com',
      smallModel: 'gpt-5-mini',
    }))
    await prepareGitHubCredential()
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({
      gheDomain: 'corp.ghe.com',
      smallModel: 'gpt-5-mini',
    }))
    await readConfig()
    authStore.gheDomain = getCachedConfig().gheDomain
    githubUserFailuresByToken.set(
      'legacy-token',
      new HTTPError(401, {
        error: { message: 'expired legacy credential', type: 'authentication_error' },
      }),
    )

    const githubSetup = await setupGitHubToken({ force: true })

    expect(githubSetup.migrationPending).toBe(false)
    expect(githubUserTokens).toEqual(['legacy-token', 'new-test-token'])
    expect(copilotTokenTokens).toEqual(['new-test-token'])
    expect(await readGitHubCredential()).toMatchObject({
      githubToken: 'new-test-token',
      gheDomain: 'corp.ghe.com',
    })
    expect(JSON.parse(await fs.readFile(PATHS.CONFIG_PATH, 'utf8'))).toEqual({
      gheDomain: 'corp.ghe.com',
      smallModel: 'gpt-5-mini',
    })
    await expect(fs.access(PATHS.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
    await expect(fs.access(`${PATHS.CONFIG_MIGRATION_BACKUP_PATH}.replacement.json`)).rejects.toThrow()
  })

  test('runtime override migrates a valid legacy credential without persisting the override', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({
      githubToken: 'legacy-token',
      smallModel: 'gpt-5-mini',
    }))
    await readConfig()
    authStore.githubToken = 'runtime-override-token'

    const cleanup = await setupRuntimeOverrideTokens()
    cleanup()

    expect(githubUserTokens).toEqual(['legacy-token'])
    expect(copilotTokenTokens).toEqual(['legacy-token', 'runtime-override-token'])
    expect(authStore.githubToken).toBe('runtime-override-token')
    expect(await readGitHubCredential()).toMatchObject({
      githubToken: 'legacy-token',
    })
    expect(JSON.parse(await fs.readFile(PATHS.CONFIG_PATH, 'utf8'))).toEqual({
      smallModel: 'gpt-5-mini',
    })
    await expect(fs.access(PATHS.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
  })

  test('runtime override continues while preserving legacy recovery files when migration validation fails', async () => {
    const legacyConfig = JSON.stringify({
      githubToken: 'legacy-token',
      smallModel: 'gpt-5-mini',
    })
    await fs.writeFile(PATHS.CONFIG_PATH, legacyConfig)
    await readConfig()
    authStore.githubToken = 'runtime-override-token'
    copilotTokenFailuresByToken.set('legacy-token', new Error('temporary migration failure'))

    const cleanup = await setupRuntimeOverrideTokens()
    cleanup()

    expect(copilotTokenTokens).toEqual(['legacy-token', 'runtime-override-token'])
    expect(authStore.githubToken).toBe('runtime-override-token')
    expect(await fs.readFile(PATHS.CONFIG_PATH, 'utf8')).toBe(legacyConfig)
    expect(await fs.readFile(PATHS.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(legacyConfig)
    expect(await readGitHubCredential()).toMatchObject({ githubToken: 'legacy-token' })
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('migration backup'))
  })

  test('auth command completes the legacy migration before replacing the credential', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({
      githubToken: 'legacy-token',
      gheDomain: 'corp.ghe.com',
      smallModel: 'gpt-5-mini',
    }))

    await runAuthCommand(makeAuthArgs({ 'ghe-domain': 'corp.ghe.com' }))

    expect(mockPollAccessToken).toHaveBeenCalledTimes(1)
    expect(mockSuccess).toHaveBeenCalledWith('GitHub credential written to credentials.json')
    expect(authStore.githubToken).toBe('new-test-token')
    expect(githubUserTokens).toEqual(['legacy-token', 'new-test-token'])
    expect(copilotTokenTokens).toEqual(['legacy-token'])
    expect(await readGitHubCredential()).toMatchObject({
      githubToken: 'new-test-token',
      gheDomain: 'corp.ghe.com',
    })
    expect(JSON.parse(await fs.readFile(PATHS.CONFIG_PATH, 'utf8'))).toEqual({
      gheDomain: 'corp.ghe.com',
      smallModel: 'gpt-5-mini',
    })
    await expect(fs.access(PATHS.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
  })

  test('start command migrates legacy state without persisting its runtime override', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({
      githubToken: 'legacy-token',
      smallModel: 'gpt-5-mini',
    }))

    await runStartCommand(makeStartArgs({ 'github-token': 'runtime-override-token' }))

    expect(listenCalls).toEqual([4141])
    expect(mockPollAccessToken).not.toHaveBeenCalled()
    expect(authStore.githubToken).toBe('runtime-override-token')
    expect(githubUserTokens).toEqual(['legacy-token'])
    expect(copilotTokenTokens).toEqual(['legacy-token', 'runtime-override-token'])
    expect(await readGitHubCredential()).toMatchObject({ githubToken: 'legacy-token' })
    const configContent = await fs.readFile(PATHS.CONFIG_PATH, 'utf8')
    const credentialsContent = await fs.readFile(PATHS.CREDENTIALS_PATH, 'utf8')
    expect(configContent).not.toContain('runtime-override-token')
    expect(credentialsContent).not.toContain('runtime-override-token')
    expect(JSON.parse(configContent)).toEqual({ smallModel: 'gpt-5-mini' })
    await expect(fs.access(PATHS.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
  })

  test('start command warns and keeps recovery state when legacy validation fails', async () => {
    const legacyConfig = JSON.stringify({
      githubToken: 'legacy-token',
      smallModel: 'gpt-5-mini',
    })
    await fs.writeFile(PATHS.CONFIG_PATH, legacyConfig)
    githubUserFailuresByToken.set(
      'legacy-token',
      new HTTPError(401, {
        error: { message: 'bad credentials', type: 'authentication_error' },
      }),
    )

    await runStartCommand(makeStartArgs({ 'github-token': 'runtime-override-token' }))

    expect(mockWarn).toHaveBeenCalled()
    expect(authStore.githubToken).toBe('runtime-override-token')
    expect(githubUserTokens).toEqual(['legacy-token'])
    expect(copilotTokenTokens).toEqual(['runtime-override-token'])
    expect(await readGitHubCredential()).toMatchObject({ githubToken: 'legacy-token' })
    expect(await fs.readFile(PATHS.CONFIG_PATH, 'utf8')).toBe(legacyConfig)
    expect(await fs.readFile(PATHS.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(legacyConfig)
  })
})

describe('GHE domain-switch re-auth', () => {
  beforeEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
    await fs.mkdir(tempDir, { recursive: true })

    resetStores()
    githubUserFailure = undefined
    copilotTokenFailure = undefined
    githubUserFailuresByToken.clear()
    copilotTokenFailuresByToken.clear()
    mockPollAccessToken.mockClear()
    githubUserTokens.length = 0
    githubUserApiBaseUrls.length = 0
    copilotTokenTokens.length = 0
  })

  test('domain changed forces re-auth instead of reusing another tenant credential', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({ gheDomain: 'corp.ghe.com' }))
    await writeGitHubCredential('public-github-token', undefined)
    await readConfig()
    authStore.gheDomain = 'corp.ghe.com'

    await setupGitHubToken()

    expect(mockPollAccessToken).toHaveBeenCalledTimes(1)
    expect(authStore.githubToken).toBe('new-test-token')
    expect(await readGitHubCredential()).toMatchObject({
      githubToken: 'new-test-token',
      gheDomain: 'corp.ghe.com',
    })
  })

  test('domain change validates and finalizes a legacy credential against its original tenant before re-auth', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({
      githubToken: 'legacy-token',
      gheDomain: 'old.ghe.com',
    }))
    await readConfig()
    authStore.gheDomain = 'new.ghe.com'

    const githubSetup = await setupGitHubToken()

    expect(githubSetup.migrationPending).toBe(false)
    expect(githubUserTokens).toEqual(['legacy-token', 'new-test-token'])
    expect(githubUserApiBaseUrls).toEqual([
      'https://api.old.ghe.com',
      'https://api.new.ghe.com',
    ])
    expect(copilotTokenTokens).toEqual(['legacy-token'])
    expect(await readGitHubCredential()).toMatchObject({
      githubToken: 'new-test-token',
      gheDomain: 'new.ghe.com',
    })
    expect(JSON.parse(await fs.readFile(PATHS.CONFIG_PATH, 'utf8'))).toEqual({
      gheDomain: 'new.ghe.com',
    })
    await expect(fs.access(PATHS.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
  })

  test('matching GHE domain reuses the stored credential', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({ gheDomain: 'corp.ghe.com' }))
    await writeGitHubCredential('existing-ghe-token', 'corp.ghe.com')
    await readConfig()
    authStore.gheDomain = 'corp.ghe.com'

    await setupGitHubToken()

    expect(mockPollAccessToken).not.toHaveBeenCalled()
    expect(authStore.githubToken).toBe('existing-ghe-token')
  })

  test('public GitHub credential is reused when both domains are absent', async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({}))
    await writeGitHubCredential('public-github-token', undefined)
    await readConfig()

    await setupGitHubToken()

    expect(mockPollAccessToken).not.toHaveBeenCalled()
    expect(authStore.githubToken).toBe('public-github-token')
  })
})
