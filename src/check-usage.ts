import type { QuotaDetail } from '~/types'
import process from 'node:process'
import { defineCommand } from 'citty'

import consola from 'consola'

import { GitHubClient } from '~/clients'

import { authStore } from '~/state'
import { cacheVSCodeVersion, getClientConfig } from './clients/factory'
import { applyGheDomain } from './clients/ghe-domain'
import { getCachedConfig, readConfig } from './lib/config'
import { ensurePaths } from './lib/paths'
import { setupGitHubToken } from './lib/token'

export const checkUsage = defineCommand({
  meta: {
    name: 'check-usage',
    description: 'Show current GitHub Copilot usage/quota information',
  },
  async run() {
    await ensurePaths()
    await readConfig()
    applyGheDomain(authStore, getCachedConfig().gheDomain)
    await cacheVSCodeVersion()
    await setupGitHubToken()
    try {
      const githubClient = new GitHubClient(authStore, getClientConfig())
      const usage = await githubClient.getCopilotUsage()

      // Helper to summarize a quota snapshot
      function summarizeQuota(name: string, snap: QuotaDetail | undefined) {
        if (!snap)
          return `${name}: N/A`
        const total = snap.entitlement
        const used = total - snap.remaining
        const percentUsed = total > 0 ? (used / total) * 100 : 0
        const percentRemaining = snap.percent_remaining
        return `${name}: ${used}/${total} used (${percentUsed.toFixed(1)}% used, ${percentRemaining.toFixed(1)}% remaining)`
      }

      const premiumLine = summarizeQuota('Premium', usage.quota_snapshots.premium_interactions)
      const chatLine = summarizeQuota('Chat', usage.quota_snapshots.chat)
      const completionsLine = summarizeQuota(
        'Completions',
        usage.quota_snapshots.completions,
      )

      consola.box(
        `Copilot Usage (plan: ${usage.copilot_plan})\n`
        + `Quota resets: ${usage.quota_reset_date}\n`
        + `\nQuotas:\n`
        + `  ${premiumLine}\n`
        + `  ${chatLine}\n`
        + `  ${completionsLine}`,
      )
    }
    catch (err) {
      consola.error('Failed to fetch Copilot usage:', err)
      process.exit(1)
    }
  },
})
