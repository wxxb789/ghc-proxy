import type { RoutedAccountDescriptor } from '~/accounts/descriptor'

import { describe, expect, test } from 'bun:test'

import { DashboardQuotaCache } from '~/routes/dashboard/handler'
import { DashboardMetadataRefresher } from '~/routes/dashboard/metadata-refresh'
import { authStore, createAccountRuntime, getCurrentAccountName, modelCache } from '~/state'

describe('DashboardMetadataRefresher', () => {
  test('refreshes each account in its own runtime and preserves a failed model catalog', async () => {
    const defaultRuntime = createAccountRuntime('default', { githubToken: 'github-default' })
    const workRuntime = createAccountRuntime('work', { githubToken: 'github-work' })
    defaultRuntime.models.cacheModels({ object: 'list', data: [] })
    workRuntime.models.cacheModels({
      object: 'list',
      data: [model('previous-work-model')],
    })
    const accounts: RoutedAccountDescriptor[] = [
      { name: 'default', hostname: 'default.localhost', isDefault: true, runtime: defaultRuntime },
      { name: 'work', hostname: 'work.localhost', isDefault: false, runtime: workRuntime },
    ]
    const identityAccounts: string[] = []
    const modelAccounts: string[] = []
    const refresher = new DashboardMetadataRefresher({
      refreshGitHubIdentity: async () => {
        identityAccounts.push(getCurrentAccountName())
        authStore.githubLogin = `${getCurrentAccountName()}-login`
        authStore.githubValidatedAt = Date.now()
      },
      refreshModels: async () => {
        const accountName = getCurrentAccountName()
        modelAccounts.push(accountName)
        if (accountName === 'work')
          throw new Error('upstream model failure')
        modelCache.cacheModels({ object: 'list', data: [] })
      },
    })
    const quotaCache = new DashboardQuotaCache(async () => usage())

    const result = await refresher.refresh(accounts, quotaCache)

    expect(identityAccounts).toEqual(['default', 'work'])
    expect(modelAccounts).toEqual(['default', 'work'])
    expect(result).toMatchObject({
      status: 'partial',
      accounts: [
        { name: 'default', github: { status: 'ok' }, models: { status: 'ok' }, quota: { status: 'ok' } },
        { name: 'work', github: { status: 'ok' }, models: { status: 'stale' }, quota: { status: 'ok' } },
      ],
    })
    expect(workRuntime.models.getModels()?.data.map(model => model.id)).toEqual(['previous-work-model'])
    expect(JSON.stringify(result)).not.toContain('upstream model failure')
    expect(JSON.stringify(result)).not.toContain('github-work')
  })

  test('times out a hung metadata source without blocking later refreshes', async () => {
    const runtime = createAccountRuntime('default', { githubToken: 'github-default' })
    runtime.models.cacheModels({ object: 'list', data: [model('previous-model')] })
    const account: RoutedAccountDescriptor = {
      name: 'default',
      hostname: 'default.localhost',
      isDefault: true,
      runtime,
    }
    let refreshModels = true
    const refresher = new DashboardMetadataRefresher({
      refreshGitHubIdentity: async () => {},
      refreshModels: async (signal) => {
        if (!refreshModels)
          return
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    }, 5)
    const quotaCache = new DashboardQuotaCache(async () => usage())

    const timedOut = await refresher.refresh([account], quotaCache)
    refreshModels = false
    const recovered = await refresher.refresh([account], quotaCache)

    expect(timedOut).toMatchObject({
      status: 'partial',
      accounts: [{ models: { status: 'stale' } }],
    })
    expect(recovered).toMatchObject({
      status: 'ok',
      accounts: [{ models: { status: 'ok' } }],
    })
  })

  test('runs the newest account snapshot after an active refresh completes', async () => {
    const defaultRuntime = createAccountRuntime('default', { githubToken: 'github-default' })
    const workRuntime = createAccountRuntime('work', { githubToken: 'github-work' })
    let releaseFirstRefresh: (() => void) | undefined
    const refreshedAccounts: string[] = []
    const refresher = new DashboardMetadataRefresher({
      refreshGitHubIdentity: async () => {},
      refreshModels: async () => {
        refreshedAccounts.push(getCurrentAccountName())
        if (getCurrentAccountName() === 'default' && !releaseFirstRefresh) {
          await new Promise<void>((resolve) => {
            releaseFirstRefresh = resolve
          })
        }
      },
    })
    const quotaCache = new DashboardQuotaCache(async () => usage())
    const defaultAccount: RoutedAccountDescriptor = {
      name: 'default',
      hostname: 'default.localhost',
      isDefault: true,
      runtime: defaultRuntime,
    }
    const workAccount: RoutedAccountDescriptor = {
      name: 'work',
      hostname: 'work.localhost',
      isDefault: false,
      runtime: workRuntime,
    }

    const first = refresher.refresh([defaultAccount], quotaCache)
    await Promise.resolve()
    const latest = refresher.refresh([defaultAccount, workAccount], quotaCache)
    releaseFirstRefresh!()

    await first
    const latestResult = await latest

    expect(refreshedAccounts).toEqual(['default', 'default', 'work'])
    expect(latestResult.accounts.map(account => account.name)).toEqual(['default', 'work'])
  })
})

function model(id: string) {
  return {
    capabilities: {
      family: 'test',
      limits: {},
      object: 'model_capabilities',
      supports: {},
      tokenizer: 'test',
      type: 'test',
    },
    id,
    model_picker_enabled: true,
    name: id,
    object: 'model',
    preview: false,
    vendor: 'GitHub',
    version: '1',
  }
}

function quota() {
  return {
    entitlement: 100,
    overage_count: 0,
    overage_permitted: false,
    percent_remaining: 100,
    quota_id: 'quota',
    quota_remaining: 100,
    remaining: 100,
    unlimited: false,
  }
}

function usage() {
  return {
    access_type_sku: 'sku',
    analytics_tracking_id: 'analytics',
    assigned_date: '2026-09-01',
    can_signup_for_limited: false,
    chat_enabled: true,
    copilot_plan: 'individual',
    organization_login_list: [],
    organization_list: [],
    quota_reset_date: '2026-10-01',
    quota_snapshots: {
      chat: quota(),
      completions: quota(),
      premium_interactions: quota(),
    },
  }
}
