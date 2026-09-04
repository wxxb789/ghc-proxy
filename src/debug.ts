#!/usr/bin/env node

import fs from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { getCachedConfig, readConfig } from '~/lib/config'
import { inspectGitHubCredential } from '~/lib/credentials'
import { PATHS } from '~/lib/paths'
import { VERSION } from '~/util/version'

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
    CONFIG_MIGRATION_BACKUP_PATH: string
    CREDENTIALS_PATH: string
  }
  configExists: boolean
  credentialError?: string
  credentialMigrationPending: boolean
  tokenExists: boolean
  gheDomain?: string
}

interface RunDebugOptions {
  json: boolean
}

function getRuntimeInfo(): DebugInfo['runtime'] {
  const bunVersion = process.versions.bun

  return {
    name: bunVersion ? 'bun' : 'node',
    version: bunVersion ?? process.versions.node,
    platform: os.platform(),
    arch: os.arch(),
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
  await readConfig()
  const [configExists, credentialStatus] = await Promise.all([
    checkConfigExists(),
    inspectGitHubCredential(),
  ])

  return {
    version: VERSION,
    runtime: getRuntimeInfo(),
    paths: {
      APP_DIR: PATHS.APP_DIR,
      CONFIG_PATH: PATHS.CONFIG_PATH,
      CONFIG_MIGRATION_BACKUP_PATH: PATHS.CONFIG_MIGRATION_BACKUP_PATH,
      CREDENTIALS_PATH: PATHS.CREDENTIALS_PATH,
    },
    configExists,
    credentialError: credentialStatus.error,
    credentialMigrationPending: credentialStatus.migrationPending,
    tokenExists: credentialStatus.tokenExists,
    gheDomain: getCachedConfig().gheDomain,
  }
}

function printDebugInfoPlain(info: DebugInfo): void {
  consola.info(`ghc-proxy debug

Version: ${info.version}
Runtime: ${info.runtime.name} ${info.runtime.version} (${info.runtime.platform} ${info.runtime.arch})

Paths:
- APP_DIR: ${info.paths.APP_DIR}
- CONFIG_PATH: ${info.paths.CONFIG_PATH}
- CREDENTIALS_PATH: ${info.paths.CREDENTIALS_PATH}
- CONFIG_MIGRATION_BACKUP_PATH: ${info.paths.CONFIG_MIGRATION_BACKUP_PATH}

Config exists: ${info.configExists ? 'Yes' : 'No'}
Token exists: ${info.tokenExists ? 'Yes' : 'No'}
Credential migration pending: ${info.credentialMigrationPending ? 'Yes' : 'No'}
Credential error: ${info.credentialError ?? 'none'}
GHE Domain: ${info.gheDomain ?? 'none'}`)
}

async function runDebug(options: RunDebugOptions): Promise<void> {
  const debugInfo = await getDebugInfo()

  if (options.json) {
    process.stdout.write(`${JSON.stringify(debugInfo, null, 2)}\n`)
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
