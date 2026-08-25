#!/usr/bin/env node

import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { authStore, modelCache, runtimeStore } from '~/state'
import { initProxyFromEnv } from './cli/proxy'
import { generateEnvScript } from './cli/shell'
import { printStartupBanner } from './cli/startup-banner'
import { cacheModels, cacheVSCodeVersion, configureUpstreamRequestQueue, createCopilotClient } from './clients/factory'
import { applyGheDomain } from './clients/ghe-domain'
import {
  getCachedConfig,
  MAX_UPSTREAM_QUEUE_RETRIES,
  MAX_UPSTREAM_RECOVERY_BUDGET_SECONDS,
  MIN_UPSTREAM_RECOVERY_BUDGET_SECONDS,
  readConfig,
} from './lib/config'
import { ensurePaths } from './lib/paths'
import { setupCopilotToken, setupGitHubToken } from './lib/token'
import { createServer } from './server'

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

  authStore.accountType = accountType
  if (accountType !== 'individual') {
    consola.info(`Using ${accountType} plan GitHub account`)
  }

  if (options.githubToken) {
    authStore.githubToken = options.githubToken
    consola.info('Using provided GitHub token')
  }

  authStore.manualApprove = options.manual
  authStore.rateLimitSeconds = options.rateLimit
  authStore.rateLimitWait = options.rateLimitWait
  authStore.showToken = options.showToken
  authStore.upstreamTimeoutSeconds = options.upstreamTimeoutSeconds
  runtimeStore.dumpFailedPayloads = resolveDumpFailedPayloadsOption(options.dumpFailedPayloads)

  await ensurePaths()
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

  // Load persisted GHE domain from config, then override with CLI arg if provided.
  // Pass --ghe-domain "" (empty string) to explicitly clear a persisted domain.
  applyGheDomain(authStore, cachedConfig.gheDomain, options.gheDomain)

  await cacheVSCodeVersion()

  if (!options.githubToken) {
    await setupGitHubToken()
  }

  const tokenCleanup = await setupCopilotToken()

  const copilotClient = createCopilotClient()
  await cacheModels(copilotClient)

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    if (!modelCache.getModels()) {
      throw new Error('Models should be loaded by now')
    }
    await maybeCopyClaudeCodeCommand(serverUrl)
  }

  printStartupBanner(serverUrl)

  const app = createServer({ idleTimeout: options.idleTimeoutSeconds })
  app.listen(options.port)

  const shutdown = async () => {
    consola.info('Shutting down gracefully...')
    tokenCleanup()
    await app.stop()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
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
