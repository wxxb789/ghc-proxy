#!/usr/bin/env node

import type { ServerHandler } from 'srvx'
import type { RuntimeConfig } from './lib/state'
import { defineCommand } from 'citty'
import clipboard from 'clipboardy'
import consola from 'consola'

import { serve } from 'srvx'
import invariant from 'tiny-invariant'

import { CopilotClient } from '~/clients'
import { readConfig } from './lib/config'
import { ensurePaths } from './lib/paths'
import { initProxyFromEnv } from './lib/proxy'
import { generateEnvScript } from './lib/shell'
import { cacheModels, cacheVSCodeVersion, getClientConfig, state } from './lib/state'
import { setupCopilotToken, setupGitHubToken } from './lib/token'
import { server } from './server'

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
}

async function maybeCopyClaudeCodeCommand(serverUrl: string): Promise<void> {
  if (!state.cache.models) {
    return
  }

  const selectableModels = state.cache.models.data.filter(
    model => model.model_picker_enabled,
  )
  const modelOptions
    = selectableModels.length > 0 ? selectableModels : state.cache.models.data

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
      ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    'claude',
  )

  try {
    clipboard.writeSync(command)
    consola.success('Copied Claude Code command to clipboard!')
  }
  catch {
    consola.warn(
      'Failed to copy to clipboard. Here is the Claude Code command:',
    )
    consola.log(command)
  }
}

export async function runServer(options: RunServerOptions): Promise<void> {
  const accountType: RuntimeConfig['accountType']
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

  state.config.accountType = accountType
  if (accountType !== 'individual') {
    consola.info(`Using ${accountType} plan GitHub account`)
  }

  if (options.githubToken) {
    state.auth.githubToken = options.githubToken
    consola.info('Using provided GitHub token')
  }

  state.config.manualApprove = options.manual
  state.config.rateLimitSeconds = options.rateLimit
  state.config.rateLimitWait = options.rateLimitWait
  state.config.showToken = options.showToken
  state.config.upstreamTimeoutSeconds = options.upstreamTimeoutSeconds

  await ensurePaths()
  await readConfig()
  await cacheVSCodeVersion()

  if (!options.githubToken) {
    await setupGitHubToken()
  }

  await setupCopilotToken()

  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  await cacheModels(copilotClient)

  consola.info(
    `Available models: \n${state.cache.models?.data.map(model => `- ${model.id}`).join('\n')}`,
  )

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    invariant(state.cache.models, 'Models should be loaded by now')
    await maybeCopyClaudeCodeCommand(serverUrl)
  }

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
    bun:
      options.idleTimeoutSeconds === undefined
        ? undefined
        : { idleTimeout: options.idleTimeoutSeconds },
  })
}

function parseIntArg(raw: string | undefined, name: string, fallbackMsg: string): number | undefined {
  if (raw === undefined)
    return undefined
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n) || n < 0) {
    consola.warn(`Invalid --${name} value "${raw}". ${fallbackMsg}`)
    return undefined
  }
  return n
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
      description: 'Upstream request timeout in seconds (0 to disable)',
    },
  },
  run({ args }) {
    const rateLimit = parseIntArg(args['rate-limit'], 'rate-limit', 'Rate limiting disabled.')
    const idleTimeoutSeconds = parseIntArg(args['idle-timeout'], 'idle-timeout', 'Falling back to Bun default.')
    const upstreamTimeoutSeconds = parseIntArg(args['upstream-timeout'], 'upstream-timeout', 'Falling back to default (300s).')

    return runServer({
      port: Number.parseInt(args.port, 10),
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
    })
  },
})
