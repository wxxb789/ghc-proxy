#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import { readConfig } from "./lib/config"
import { ensurePaths } from "./lib/paths"
import { state } from "./lib/state"
import { setupGitHubToken } from "./lib/token"
import { cacheVSCodeVersion } from "./lib/utils"

interface RunAuthOptions {
  verbose: boolean
  showToken: boolean
}

export async function runAuth(options: RunAuthOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.config.showToken = options.showToken

  await ensurePaths()
  await readConfig()
  await cacheVSCodeVersion()
  await setupGitHubToken({ force: true })
  consola.success("GitHub token written to config.json")
}

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Run GitHub auth flow without running the server",
  },
  args: {
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub token on auth",
    },
  },
  run({ args }) {
    return runAuth({
      verbose: args.verbose,
      showToken: args["show-token"],
    })
  },
})
