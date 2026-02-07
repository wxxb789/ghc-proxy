#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import { CopilotClient } from "~/clients"

import { getClientConfig } from "./lib/client-config"
import { readConfig } from "./lib/config"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { setupCopilotToken, setupGitHubToken } from "./lib/token"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"
import { server } from "./server"

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
}

async function maybeCopyClaudeCodeCommand(serverUrl: string): Promise<void> {
  if (!state.cache.models) {
    return
  }

  const selectableModels = state.cache.models.data.filter(
    (model) => model.model_picker_enabled,
  )
  const modelOptions =
    selectableModels.length > 0 ? selectableModels : state.cache.models.data

  const selectedModel = await consola.prompt(
    "Select a model to use with Claude Code",
    {
      type: "select",
      options: modelOptions.map((model) => model.id),
    },
  )

  const selectedSmallModel = await consola.prompt(
    "Select a small model to use with Claude Code",
    {
      type: "select",
      options: modelOptions.map((model) => model.id),
    },
  )

  const command = generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
      ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    "claude",
  )

  try {
    clipboard.writeSync(command)
    consola.success("Copied Claude Code command to clipboard!")
  } catch {
    consola.warn(
      "Failed to copy to clipboard. Here is the Claude Code command:",
    )
    consola.log(command)
  }
}

export async function runServer(options: RunServerOptions): Promise<void> {
  const accountType: ReturnType<typeof getClientConfig>["accountType"] =
    (
      options.accountType === "individual"
      || options.accountType === "business"
      || options.accountType === "enterprise"
    ) ?
      options.accountType
    : "individual"

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
    consola.info("Verbose logging enabled")
  }

  state.config.accountType = accountType
  if (accountType !== "individual") {
    consola.info(`Using ${accountType} plan GitHub account`)
  }

  if (options.githubToken) {
    state.auth.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
  }

  state.config.manualApprove = options.manual
  state.config.rateLimitSeconds = options.rateLimit
  state.config.rateLimitWait = options.rateLimitWait
  state.config.showToken = options.showToken

  await ensurePaths()
  await readConfig()
  await cacheVSCodeVersion()

  if (!options.githubToken) {
    await setupGitHubToken()
  }

  await setupCopilotToken()

  const clientConfig: ReturnType<typeof getClientConfig> = {
    ...getClientConfig(state),
    accountType,
  }
  const copilotClient = new CopilotClient(state.auth, clientConfig)
  await cacheModels(copilotClient)

  consola.info(
    `Available models: \n${state.cache.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    invariant(state.cache.models, "Models should be loaded by now")
    await maybeCopyClaudeCodeCommand(serverUrl)
  }

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
    bun:
      options.idleTimeoutSeconds === undefined ?
        undefined
      : { idleTimeout: options.idleTimeoutSeconds },
  })
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    "idle-timeout": {
      type: "string",
      default: "120",
      description: "Bun server idle timeout in seconds",
    },
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)
    const idleTimeoutRaw = args["idle-timeout"]
    let idleTimeoutSeconds =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      idleTimeoutRaw === undefined ? undefined : (
        Number.parseInt(idleTimeoutRaw, 10)
      )
    if (
      idleTimeoutSeconds !== undefined
      && (Number.isNaN(idleTimeoutSeconds) || idleTimeoutSeconds < 0)
    ) {
      consola.warn(
        `Invalid --idle-timeout value "${idleTimeoutRaw}". Falling back to Bun default.`,
      )
      idleTimeoutSeconds = undefined
    }

    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      idleTimeoutSeconds,
    })
  },
})
