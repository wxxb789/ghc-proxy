#!/usr/bin/env node

import type { AuthStore } from '~/state/auth'
import process from 'node:process'

import { defineCommand } from 'citty'
import consola from 'consola'

import { AccountManager } from '~/accounts/manager'
import { initProxyFromEnv } from '~/cli/proxy'
import { generateEnvScript } from '~/cli/shell'
import { printStartupBanner } from '~/cli/startup-banner'
import { cacheModels, cacheVSCodeVersion, configureUpstreamRequestQueue, createCopilotClient } from '~/clients/factory'
import { applyGheDomain } from '~/clients/ghe-domain'
import { recoverAccountManagementTransaction } from '~/lib/account-management-transaction'
import { compileAccountRouting, normalizeAccountName } from '~/lib/account-routing'
import {
  getCachedConfig,
  MAX_UPSTREAM_QUEUE_RETRIES,
  MAX_UPSTREAM_RECOVERY_BUDGET_SECONDS,
  MIN_UPSTREAM_RECOVERY_BUDGET_SECONDS,
  readConfig,
} from '~/lib/config'
import { inspectGitHubCredential, readGitHubCredentials } from '~/lib/credentials'
import { ensurePaths } from '~/lib/paths'
import { setupAuthTokens, setupRuntimeOverrideTokens } from '~/lib/token'
import { createServer } from '~/server'
import {
  aliasLegacyAccountRuntime,
  authStore,
  configureAccountRuntimes,
  createAccountRuntime,
  modelCache,
  resetAccountRuntimes,
  runtimeStore,
  runWithAccountRuntime,
} from '~/state'

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  idleTimeoutSeconds?: number
  upstreamTimeoutSeconds?: number
  upstreamQueueConcurrency?: number
  upstreamQueueMaxRetries?: number
  upstreamRecoveryBudgetSeconds?: number
  upstreamQueueBaseDelaySeconds?: number
  upstreamQueueMaxDelaySeconds?: number
  gheDomain?: string
  dumpFailedPayloads: boolean
}

const UNSIGNED_INTEGER_RE = /^\d+$/
const LEGACY_BOOTSTRAP_HOSTNAME = 'defaultaccount.localhost'

async function maybeCopyClaudeCodeCommand(serverUrl: string): Promise<void> {
  const models = modelCache.getModels()
  if (!models) {
    return
  }

  const selectableModels = models.data.filter(
    model => model.model_picker_enabled,
  )
  const modelOptions
    = selectableModels.length > 0 ? selectableModels : models.data

  const selectedModel = await consola.prompt(
    'Select a model to use with Claude Code',
    {
      type: 'select',
      options: modelOptions.map(model => model.id),
    },
  )

  const selectedSmallModel = await consola.prompt(
    'Select a small model to use with Claude Code',
    {
      type: 'select',
      options: modelOptions.map(model => model.id),
    },
  )

  const command = generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: 'dummy',
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    'claude',
  )

  consola.info(`Claude Code command:\n${command}`)
}

async function runServer(options: RunServerOptions): Promise<void> {
  const accountType: 'individual' | 'business' | 'enterprise'
    = (
      options.accountType === 'individual'
      || options.accountType === 'business'
      || options.accountType === 'enterprise'
    )
      ? options.accountType
      : 'individual'

  if (accountType !== options.accountType) {
    consola.warn(
      `Unknown account type "${options.accountType}". Falling back to "individual".`,
    )
  }

  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  if (options.verbose) {
    consola.level = 5
    consola.info('Verbose logging enabled')
  }

  if (accountType !== 'individual') {
    consola.info(`Using ${accountType} plan GitHub account`)
  }
  runtimeStore.dumpFailedPayloads = resolveDumpFailedPayloadsOption(options.dumpFailedPayloads)

  await ensurePaths()
  resetAccountRuntimes()
  await recoverAccountManagementTransaction()
  await readConfig()
  const cachedConfig = getCachedConfig()

  const upstreamQueueConcurrency = options.upstreamQueueConcurrency ?? cachedConfig.upstreamQueueConcurrency
  const upstreamQueueMaxRetries = options.upstreamQueueMaxRetries ?? cachedConfig.upstreamQueueMaxRetries
  const upstreamRecoveryBudgetSeconds = options.upstreamRecoveryBudgetSeconds ?? cachedConfig.upstreamRecoveryBudgetSeconds
  const upstreamQueueBaseDelaySeconds = options.upstreamQueueBaseDelaySeconds ?? cachedConfig.upstreamQueueBaseDelaySeconds
  const upstreamQueueMaxDelaySeconds = options.upstreamQueueMaxDelaySeconds ?? cachedConfig.upstreamQueueMaxDelaySeconds

  configureUpstreamRequestQueue({
    concurrency: upstreamQueueConcurrency,
    maxRetries: upstreamQueueMaxRetries,
    recoveryBudgetMs: secondsToMs(upstreamRecoveryBudgetSeconds),
    baseDelayMs: secondsToMs(upstreamQueueBaseDelaySeconds),
    maxDelayMs: secondsToMs(upstreamQueueMaxDelaySeconds),
  })

  let accountSetup: {
    accountManager?: AccountManager
    cleanup: () => void | Promise<void>
  }
  if (cachedConfig.accountRouting) {
    accountSetup = await setupRoutedAccounts(
      options,
      accountType,
      cachedConfig.accountRouting,
    )
  }
  else if (!options.githubToken && options.gheDomain === undefined) {
    accountSetup = await setupLegacyAccountManager(
      options,
      accountType,
      cachedConfig.gheDomain,
    )
  }
  else {
    consola.warn(
      'Dashboard named-account migration is unavailable while a process-wide GitHub token or GHE tenant override is active.',
    )
    accountSetup = {
      accountManager: undefined,
      cleanup: await setupLegacyAccount(options, accountType, cachedConfig.gheDomain),
    }
  }

  const serverHostname = accountSetup.accountManager?.getRoutingSummary().baseHostname
    ?? 'localhost'
  const serverUrl = `http://${serverHostname}:${options.port}`

  try {
    if (options.claudeCode) {
      if (!modelCache.getModels()) {
        throw new Error('Models should be loaded by now')
      }
      await maybeCopyClaudeCodeCommand(serverUrl)
    }

    printStartupBanner(serverUrl)

    const app = createServer({
      accountManager: accountSetup.accountManager,
      idleTimeout: options.idleTimeoutSeconds,
    })
    app.listen(options.port)

    const shutdown = async () => {
      consola.info('Shutting down gracefully...')
      await accountSetup.cleanup()
      await app.stop()
      process.exit(0)
    }

    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  }
  catch (error) {
    try {
      await accountSetup.cleanup()
    }
    catch {
      consola.error('Failed to clean up account resources after startup failure.')
    }
    resetAccountRuntimes()
    throw error
  }
}

function applyServerAuthOptions(
  target: AuthStore,
  options: RunServerOptions,
  accountType: AuthStore['accountType'],
): void {
  target.accountType = accountType
  target.manualApprove = options.manual
  target.rateLimitSeconds = options.rateLimit
  target.rateLimitWait = options.rateLimitWait
  target.showToken = options.showToken
  target.upstreamTimeoutSeconds = options.upstreamTimeoutSeconds
}

async function setupLegacyAccount(
  options: RunServerOptions,
  accountType: AuthStore['accountType'],
  persistedGheDomain?: string,
): Promise<() => void> {
  applyServerAuthOptions(authStore, options, accountType)

  if (options.githubToken) {
    authStore.githubToken = options.githubToken
    consola.info('Using provided GitHub token')
  }

  // Load persisted GHE domain from config, then override with CLI arg if provided.
  // Pass --ghe-domain "" (empty string) to explicitly clear a persisted domain.
  applyGheDomain(authStore, persistedGheDomain, options.gheDomain)
  await cacheVSCodeVersion()

  const cleanup = options.githubToken
    ? await setupRuntimeOverrideTokens()
    : await setupAuthTokens({
        explicitGheDomain: options.gheDomain === undefined
          ? undefined
          : { value: authStore.gheDomain },
      })

  try {
    await cacheModels(createCopilotClient())
    return cleanup
  }
  catch (error) {
    cleanup()
    throw error
  }
}

async function setupLegacyAccountManager(
  options: RunServerOptions,
  accountType: AuthStore['accountType'],
  persistedGheDomain?: string,
): Promise<{
  accountManager?: AccountManager
  cleanup: () => void | Promise<void>
}> {
  const storedCredentials = await readGitHubCredentials()
  let accountName: string
  try {
    accountName = normalizeAccountName(
      storedCredentials?.activeAccount ?? 'default',
    )
  }
  catch {
    consola.warn(
      'Dashboard named-account migration is unavailable because the active legacy account name is not routing-compatible.',
    )
    return {
      accountManager: undefined,
      cleanup: await setupLegacyAccount(options, accountType, persistedGheDomain),
    }
  }
  const runtime = aliasLegacyAccountRuntime(accountName)
  let cleanup: (() => void) | undefined
  try {
    cleanup = await runWithAccountRuntime(
      runtime,
      () => setupLegacyAccount(options, accountType, persistedGheDomain),
    )
    const credentials = await readGitHubCredentials()
    if (!credentials) {
      throw new Error('Legacy account migration requires a persisted GitHub credential.')
    }
    if (credentials.activeAccount !== accountName) {
      throw new Error('The active legacy account changed while Dashboard migration was being prepared.')
    }

    const routing = compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: accountName,
      hostnames: { [LEGACY_BOOTSTRAP_HOSTNAME]: accountName },
    }, Object.keys(credentials.accounts))
    const accountManager = new AccountManager({
      authDefaults: serverAuthDefaults(options, accountType),
      knownAccountNames: Object.keys(credentials.accounts),
      refreshCleanups: new Map([[accountName, cleanup]]),
      routing,
      routingEnabled: false,
      runtimes: [runtime],
    })
    consola.info(
      `The legacy account ${JSON.stringify(accountName)} remains the default. Enable named-account routing in the Dashboard; ${LEGACY_BOOTSTRAP_HOSTNAME} is the editable suggested hostname.`,
    )
    return {
      accountManager,
      cleanup: () => accountManager.stop(),
    }
  }
  catch (error) {
    cleanup?.()
    resetAccountRuntimes()
    throw error
  }
}

async function setupRoutedAccounts(
  options: RunServerOptions,
  accountType: AuthStore['accountType'],
  routingConfig: NonNullable<ReturnType<typeof getCachedConfig>['accountRouting']>,
): Promise<{ accountManager: AccountManager, cleanup: () => void }> {
  if (options.githubToken) {
    throw new Error('--github-token cannot be used with accountRouting because it is not bound to a named account.')
  }
  if (options.gheDomain !== undefined) {
    throw new Error('--ghe-domain cannot be used with accountRouting; configure the tenant on each named credential.')
  }

  const migrationStatus = await inspectGitHubCredential()
  if (migrationStatus.migrationPending) {
    applyServerAuthOptions(authStore, options, accountType)
    applyGheDomain(authStore, getCachedConfig().gheDomain)
    const cleanupMigration = await setupAuthTokens()
    cleanupMigration()
  }

  const credentials = await readGitHubCredentials()
  if (!credentials) {
    throw new Error('accountRouting requires credentials.json with every referenced named account.')
  }

  const compiled = compileAccountRouting(
    routingConfig,
    Object.keys(credentials.accounts),
  )
  const accountNames = new Set([
    compiled.defaultAccount,
    ...compiled.hostnames.values(),
  ])
  const runtimes = Array.from(accountNames, (accountName) => {
    const credential = credentials.accounts[accountName]!
    const runtime = createAccountRuntime(accountName)
    applyServerAuthOptions(runtime.auth, options, accountType)
    applyGheDomain(runtime.auth, credential.gheDomain)
    return runtime
  })

  configureAccountRuntimes(compiled, runtimes)
  const cleanups = new Map<string, () => void>()
  try {
    for (const runtime of runtimes) {
      consola.info(`Initializing GitHub account ${JSON.stringify(runtime.name)}`)
      const cleanup = await runWithAccountRuntime(runtime, async () => {
        await cacheVSCodeVersion()
        const stopRefresh = await setupAuthTokens({ accountName: runtime.name })
        try {
          await cacheModels(createCopilotClient())
          return stopRefresh
        }
        catch (error) {
          stopRefresh()
          throw error
        }
      })
      cleanups.set(runtime.name, cleanup)
    }
  }
  catch (error) {
    for (const cleanup of Array.from(cleanups.values()).reverse()) {
      cleanup()
    }
    resetAccountRuntimes()
    throw error
  }

  try {
    const accountManager = new AccountManager({
      authDefaults: serverAuthDefaults(options, accountType),
      knownAccountNames: Object.keys(credentials.accounts),
      refreshCleanups: cleanups,
      routing: compiled,
      runtimes,
    })
    return {
      accountManager,
      cleanup: () => accountManager.stop(),
    }
  }
  catch (error) {
    for (const cleanup of Array.from(cleanups.values()).reverse()) {
      cleanup()
    }
    resetAccountRuntimes()
    throw error
  }
}

function serverAuthDefaults(
  options: RunServerOptions,
  accountType: AuthStore['accountType'],
): Partial<AuthStore> {
  return {
    accountType,
    manualApprove: options.manual,
    rateLimitSeconds: options.rateLimit,
    rateLimitWait: options.rateLimitWait,
    showToken: false,
    upstreamTimeoutSeconds: options.upstreamTimeoutSeconds,
  }
}

export function parseIntArg(
  raw: string | undefined,
  name: string,
  fallbackMsg: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (raw === undefined)
    return undefined
  const normalized = raw.trim()
  const n = Number(normalized)
  if (!UNSIGNED_INTEGER_RE.test(normalized) || !Number.isSafeInteger(n) || n < min || n > max) {
    consola.warn(`Invalid --${name} value "${raw}". ${fallbackMsg}`)
    return undefined
  }
  return n
}

function secondsToMs(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : seconds * 1000
}

export function resolveDumpFailedPayloadsOption(
  cliEnabled: boolean,
  envValue = process.env.DUMP_FAILED_PAYLOADS,
): boolean {
  if (cliEnabled) {
    return true
  }

  return envValue === '1' || envValue?.toLowerCase() === 'true'
}

export const start = defineCommand({
  meta: {
    name: 'start',
    description: 'Start the Copilot API server',
  },
  args: {
    'port': {
      alias: 'p',
      type: 'string',
      default: '4141',
      description: 'Port to listen on',
    },
    'verbose': {
      alias: 'v',
      type: 'boolean',
      default: false,
      description: 'Enable verbose logging',
    },
    'account-type': {
      alias: 'a',
      type: 'string',
      default: 'individual',
      description: 'Account type to use (individual, business, enterprise)',
    },
    'manual': {
      type: 'boolean',
      default: false,
      description: 'Enable manual request approval',
    },
    'rate-limit': {
      alias: 'r',
      type: 'string',
      description: 'Rate limit in seconds between requests',
    },
    'wait': {
      alias: 'w',
      type: 'boolean',
      default: false,
      description:
        'Wait instead of error when rate limit is hit. Has no effect if rate limit is not set',
    },
    'github-token': {
      alias: 'g',
      type: 'string',
      description:
        'Provide GitHub token directly (must be generated using the `auth` subcommand)',
    },
    'claude-code': {
      alias: 'c',
      type: 'boolean',
      default: false,
      description:
        'Generate a command to launch Claude Code with Copilot API config',
    },
    'show-token': {
      type: 'boolean',
      default: false,
      description: 'Show GitHub and Copilot tokens on fetch and refresh',
    },
    'proxy-env': {
      type: 'boolean',
      default: false,
      description: 'Initialize proxy from environment variables',
    },
    'idle-timeout': {
      type: 'string',
      default: '120',
      description: 'Bun server idle timeout in seconds',
    },
    'upstream-timeout': {
      type: 'string',
      default: '1800',
      description: 'Upstream request timeout in seconds (0 to disable). Enforced as a total-duration limit; both runtimes additionally apply their own ~300s idle timeout to fetch, which a steadily streaming response does not trip.',
    },
    'upstream-queue-concurrency': {
      type: 'string',
      description: 'Maximum concurrent Copilot upstream requests (default: 10)',
    },
    'upstream-queue-retries': {
      type: 'string',
      description: 'Maximum retries for transient upstream responses (0-2, default: 1)',
    },
    'upstream-recovery-budget': {
      type: 'string',
      description: 'Recovery budget in seconds after the first retryable outcome (1-120, default: 60)',
    },
    'upstream-queue-base-delay': {
      type: 'string',
      description: 'Base delay in seconds for upstream retry backoff when Retry-After is absent (default: 2)',
    },
    'upstream-queue-max-delay': {
      type: 'string',
      description: 'Maximum delay in seconds for upstream retry backoff (default: 60)',
    },
    'ghe-domain': {
      alias: 'ghe',
      type: 'string',
      description: 'Company GHE domain for GitHub Enterprise Cloud (e.g. company.ghe.com)',
    },
    'dump-failed-payloads': {
      alias: 'D',
      type: 'boolean',
      default: false,
      description: 'Dump failed /responses payloads on upstream 400 errors',
    },
  },
  run({ args }) {
    const port = parseIntArg(args.port, 'port', 'Server not started.', 1, 65_535)
    if (port === undefined)
      throw new Error(`Invalid --port value "${args.port}".`)
    const rateLimit = parseIntArg(args['rate-limit'], 'rate-limit', 'Rate limiting disabled.')
    const idleTimeoutSeconds = parseIntArg(args['idle-timeout'], 'idle-timeout', 'Falling back to Bun default.')
    const upstreamTimeoutSeconds = parseIntArg(args['upstream-timeout'], 'upstream-timeout', 'Falling back to default (1800s).')
    const upstreamQueueConcurrency = parseIntArg(args['upstream-queue-concurrency'], 'upstream-queue-concurrency', 'Using default upstream queue concurrency.', 1)
    const upstreamQueueMaxRetries = parseIntArg(args['upstream-queue-retries'], 'upstream-queue-retries', 'Using default upstream queue retry count.', 0, MAX_UPSTREAM_QUEUE_RETRIES)
    const upstreamRecoveryBudgetSeconds = parseIntArg(args['upstream-recovery-budget'], 'upstream-recovery-budget', 'Using default upstream recovery budget.', MIN_UPSTREAM_RECOVERY_BUDGET_SECONDS, MAX_UPSTREAM_RECOVERY_BUDGET_SECONDS)
    const upstreamQueueBaseDelaySeconds = parseIntArg(args['upstream-queue-base-delay'], 'upstream-queue-base-delay', 'Using default upstream queue base delay.')
    const upstreamQueueMaxDelaySeconds = parseIntArg(args['upstream-queue-max-delay'], 'upstream-queue-max-delay', 'Using default upstream queue max delay.')

    return runServer({
      port,
      verbose: args.verbose,
      accountType: args['account-type'],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args['github-token'],
      claudeCode: args['claude-code'],
      showToken: args['show-token'],
      proxyEnv: args['proxy-env'],
      idleTimeoutSeconds,
      upstreamTimeoutSeconds,
      upstreamQueueConcurrency,
      upstreamQueueMaxRetries,
      upstreamRecoveryBudgetSeconds,
      upstreamQueueBaseDelaySeconds,
      upstreamQueueMaxDelaySeconds,
      gheDomain: args['ghe-domain'],
      dumpFailedPayloads: args['dump-failed-payloads'],
    })
  },
})
