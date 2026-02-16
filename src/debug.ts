#!/usr/bin/env node

import fs from 'node:fs/promises'
import os from 'node:os'
import { defineCommand } from 'citty'
import consola from 'consola'

import { getCachedConfig } from './lib/config'
import { PATHS } from './lib/paths'

interface DebugInfo {
  version: string
  runtime: {
    name: string
    version: string
    platform: string
    arch: string
  }
  paths: {
    APP_DIR: string
    CONFIG_PATH: string
  }
  configExists: boolean
  tokenExists: boolean
}

interface RunDebugOptions {
  json: boolean
}

async function getPackageVersion(): Promise<string> {
  try {
    const packageJsonPath = new URL('../package.json', import.meta.url).pathname
    // @ts-expect-error https://github.com/sindresorhus/eslint-plugin-unicorn/blob/v59.0.1/docs/rules/prefer-json-parse-buffer.md
    // JSON.parse() can actually parse buffers
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath)) as {
      version: string
    }
    return packageJson.version
  }
  catch {
    return 'unknown'
  }
}

function getRuntimeInfo() {
  return {
    name: 'bun',
    version: Bun.version,
    platform: os.platform(),
    arch: os.arch(),
  }
}

function hasToken(): boolean {
  try {
    const config = getCachedConfig()
    return Boolean(config.githubToken?.trim())
  }
  catch {
    return false
  }
}

async function checkConfigExists(): Promise<boolean> {
  try {
    const stats = await fs.stat(PATHS.CONFIG_PATH)
    if (!stats.isFile())
      return false

    const content = await fs.readFile(PATHS.CONFIG_PATH, 'utf8')
    return content.trim().length > 0
  }
  catch {
    return false
  }
}

async function getDebugInfo(): Promise<DebugInfo> {
  const [version, configExists] = await Promise.all([
    getPackageVersion(),
    checkConfigExists(),
  ])

  return {
    version,
    runtime: getRuntimeInfo(),
    paths: {
      APP_DIR: PATHS.APP_DIR,
      CONFIG_PATH: PATHS.CONFIG_PATH,
    },
    configExists,
    tokenExists: hasToken(),
  }
}

function printDebugInfoPlain(info: DebugInfo): void {
  consola.info(`ghc-proxy debug

Version: ${info.version}
Runtime: ${info.runtime.name} ${info.runtime.version} (${info.runtime.platform} ${info.runtime.arch})

Paths:
- APP_DIR: ${info.paths.APP_DIR}
- CONFIG_PATH: ${info.paths.CONFIG_PATH}

Config exists: ${info.configExists ? 'Yes' : 'No'}
Token exists: ${info.tokenExists ? 'Yes' : 'No'}`)
}

export async function runDebug(options: RunDebugOptions): Promise<void> {
  const debugInfo = await getDebugInfo()

  if (options.json) {
    await Bun.write(Bun.stdout, `${JSON.stringify(debugInfo, null, 2)}\n`)
  }
  else {
    printDebugInfoPlain(debugInfo)
  }
}

export const debug = defineCommand({
  meta: {
    name: 'debug',
    description: 'Print debug information about the application',
  },
  args: {
    json: {
      type: 'boolean',
      default: false,
      description: 'Output debug information as JSON',
    },
  },
  run({ args }) {
    return runDebug({
      json: args.json,
    })
  },
})
