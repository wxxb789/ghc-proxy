#!/usr/bin/env node

import { defineCommand } from 'citty'
import consola from 'consola'

import { authStore } from '~/state'
import { cacheVSCodeVersion } from './clients/factory'
import { applyGheDomain } from './clients/ghe-domain'
import { getCachedConfig, readConfig } from './lib/config'
import { ensurePaths } from './lib/paths'
import { setupGitHubToken } from './lib/token'

interface RunAuthOptions {
  verbose: boolean
  showToken: boolean
  gheDomain?: string
}

async function runAuth(options: RunAuthOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info('Verbose logging enabled')
  }

  authStore.showToken = options.showToken

  await ensurePaths()
  await readConfig()

  // Load persisted GHE domain from config, then override with CLI arg if provided.
  // Pass --ghe-domain "" (empty string) to explicitly clear a persisted domain.
  applyGheDomain(authStore, getCachedConfig().gheDomain, options.gheDomain)

  await cacheVSCodeVersion()
  await setupGitHubToken({ force: true })
  consola.success('GitHub token written to config.json')
}

export const auth = defineCommand({
  meta: {
    name: 'auth',
    description: 'Run GitHub auth flow without running the server',
  },
  args: {
    'verbose': {
      alias: 'v',
      type: 'boolean',
      default: false,
      description: 'Enable verbose logging',
    },
    'show-token': {
      type: 'boolean',
      default: false,
      description: 'Show GitHub token on auth',
    },
    'ghe-domain': {
      alias: 'ghe',
      type: 'string',
      description: 'Company GHE domain for GitHub Enterprise Cloud (e.g. company.ghe.com)',
    },
  },
  run({ args }) {
    return runAuth({
      verbose: args.verbose,
      showToken: args['show-token'],
      gheDomain: args['ghe-domain'],
    })
  },
})
