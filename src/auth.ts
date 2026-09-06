#!/usr/bin/env node

import { defineCommand } from 'citty'
import consola from 'consola'

import { cacheVSCodeVersion } from '~/clients/factory'
import { applyGheDomain } from '~/clients/ghe-domain'
import { normalizeAccountName } from '~/lib/account-routing'
import { getCachedConfig, readConfig } from '~/lib/config'
import { readGitHubCredentials } from '~/lib/credentials'
import { ensurePaths } from '~/lib/paths'
import {
  finalizePendingGitHubCredentialMigration,
  setupGitHubToken,
} from '~/lib/token'
import { authStore } from '~/state'

interface RunAuthOptions {
  account?: string
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

  const accountName = options.account === undefined
    ? undefined
    : normalizeAccountName(options.account)
  const storedCredentials = await readGitHubCredentials()
  const storedAccount = accountName
    ? storedCredentials?.accounts[accountName]
    : storedCredentials?.accounts[storedCredentials.activeAccount]

  // Load persisted GHE domain from config, then override with CLI arg if provided.
  // Pass --ghe-domain "" (empty string) to explicitly clear a persisted domain.
  applyGheDomain(
    authStore,
    storedCredentials ? storedAccount?.gheDomain : getCachedConfig().gheDomain,
    options.gheDomain,
  )

  await cacheVSCodeVersion()
  const githubSetup = await setupGitHubToken({
    accountName,
    force: true,
    explicitGheDomain: options.gheDomain === undefined
      ? undefined
      : { value: authStore.gheDomain },
  })
  await finalizePendingGitHubCredentialMigration(githubSetup)
  consola.success(
    accountName
      ? `GitHub credential for account ${JSON.stringify(accountName)} written to credentials.json`
      : 'GitHub credential written to credentials.json',
  )
}

export const auth = defineCommand({
  meta: {
    name: 'auth',
    description: 'Run GitHub auth flow without running the server',
  },
  args: {
    'account': {
      type: 'string',
      description: 'Named account to create or replace',
    },
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
      account: args.account,
      verbose: args.verbose,
      showToken: args['show-token'],
      gheDomain: args['ghe-domain'],
    })
  },
})
