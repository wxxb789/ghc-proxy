import type { RecoveryEvent } from '~/lib/request-logger'
import type { CopilotUsageResponse, Model } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { UpstreamRequestQueue } from '~/clients/upstream-queue'
import { getCachedConfig } from '~/lib/config'
import {
  DashboardQuotaCache,
  getDashboardBehavior,
  getDashboardModels,
} from '~/routes/dashboard/handler'
import { modelCache, runtimeStore } from '~/state'

import {
  buildGptModel,
  buildModel,
  buildModelsResponse,
  clearConfig,
  restoreStateSnapshot,
  saveStateSnapshot,
} from './helpers'

let snapshot: ReturnType<typeof saveStateSnapshot>

beforeEach(() => {
  snapshot = saveStateSnapshot()
  clearConfig()
  runtimeStore.requests.reset()
})

afterEach(() => {
  runtimeStore.requests.reset()
  clearConfig()
  restoreStateSnapshot(snapshot)
})

describe('dashboard model introspection', () => {
  test('keeps upstream metadata separate from proxy-effective behavior', () => {
    const native = buildModel('claude-sonnet-4.5', {
      supported_endpoints: ['/v1/messages', '/chat/completions'],
      capabilities: {
        ...buildModel('native').capabilities,
        supports: {
          tool_calls: true,
          parallel_tool_calls: true,
          structured_outputs: true,
        },
      },
    })
    const responses = buildGptModel('gpt-5.6-sol', {
      supported_endpoints: ['/responses'],
      capabilities: {
        ...buildGptModel('responses').capabilities,
        supports: {
          tool_calls: true,
          reasoning_effort: ['low', 'medium', 'high'],
          structured_outputs: true,
        },
      },
    })
    modelCache.cacheModels(buildModelsResponse(native, responses))

    const models = getDashboardModels()

    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({
      id: 'claude-sonnet-4.5',
      upstream: {
        endpoints: ['/v1/messages', '/chat/completions'],
        capabilities: { supports: { structured_outputs: true } },
      },
      effective: {
        defaultMessagesStrategy: 'native-messages',
        outputConfig: false,
        nativeStructuredOutput: true,
      },
    })
    expect(models[1]).toMatchObject({
      id: 'gpt-5.6-sol',
      effective: {
        defaultMessagesStrategy: 'responses-api',
        responsesAvailable: true,
        responsesParameterFilters: ['temperature', 'top_p'],
      },
    })
  })

  test('projects only allowlisted upstream model metadata', () => {
    const model = buildGptModel('gpt-5.6-sol', {
      supported_endpoints: ['/responses'],
      policy: { state: 'enabled', terms: 'standard' },
    })
    Object.assign(model.capabilities as unknown as Record<string, unknown>, {
      signed_url: 'https://example.invalid/model?token=secret',
    })
    Object.assign(model.capabilities.limits as unknown as Record<string, unknown>, {
      secret_limit: 'must-not-leak',
    })
    Object.assign(model.policy as unknown as Record<string, unknown>, {
      internal_secret: 'must-not-leak',
    })
    modelCache.cacheModels(buildModelsResponse(model))

    const json = JSON.stringify(getDashboardModels())

    expect(json).not.toContain('signed_url')
    expect(json).not.toContain('secret_limit')
    expect(json).not.toContain('internal_secret')
    expect(json).not.toContain('token=secret')
    expect(json).toContain('max_context_window_tokens')
  })

  test('keeps sparse upstream model metadata readable', () => {
    const model = buildModel('text-embedding-3-small')
    delete (model.capabilities as Partial<Model['capabilities']>).limits
    delete (model.capabilities as Partial<Model['capabilities']>).supports
    modelCache.cacheModels(buildModelsResponse(model))

    const [projected] = getDashboardModels()
    expect(projected).toMatchObject({
      id: 'text-embedding-3-small',
      upstream: { endpoints: [] },
      effective: {
        toolCalls: false,
        vision: false,
        adaptiveThinking: false,
        reasoningEffort: [],
      },
    })
    expect(projected?.upstream.capabilities.limits).toBeDefined()
    expect(projected?.upstream.capabilities.supports).toBeDefined()
  })
})

describe('dashboard behavior introspection', () => {
  test('reads current config and runtime effect counters through real resolvers', () => {
    Object.assign(getCachedConfig(), {
      compactUseSmallModel: true,
      smallModel: 'claude-haiku-4.5',
      modelRewrites: [{ from: 'claude-*', to: 'claude-sonnet-4.5' }],
      overloadFallbacks: { 'claude-sonnet-4.5': 'gpt-5.6-sol' },
      responsesApiAutoContextManagement: true,
      responsesApiContextManagementModels: ['gpt-5.6-sol'],
    })
    runtimeStore.requests.start({
      requestId: 'effect-request',
      method: 'POST',
      endpoint: '/v1/responses',
    })
    runtimeStore.requests.recordEffect('effect-request', 'responses.parameter_filter', 3)

    const behavior = getDashboardBehavior()

    expect(behavior.modelRouting).toMatchObject({
      rewrites: [{ from: 'claude-*', to: 'claude-sonnet-4.5' }],
      compact: { enabled: true, smallModel: 'claude-haiku-4.5' },
      overloadFallbacks: { 'claude-sonnet-4.5': 'gpt-5.6-sol' },
    })
    expect(behavior.contextManagement).toMatchObject({
      enabled: true,
      models: ['gpt-5.6-sol'],
    })
    expect(behavior.effects.find(effect => effect.id === 'responses.parameter_filter'))
      .toMatchObject({ count: 3 })
  })
})

describe('DashboardQuotaCache', () => {
  test('coalesces refreshes and exposes only quota/reset fields', async () => {
    let calls = 0
    let now = 1_000
    const usage: CopilotUsageResponse = {
      access_type_sku: 'sku',
      analytics_tracking_id: 'must-not-leak',
      assigned_date: '2026-08-01',
      can_signup_for_limited: false,
      chat_enabled: true,
      copilot_plan: 'individual',
      organization_login_list: [{ secret: true }],
      organization_list: [{ secret: true }],
      quota_reset_date: '2026-09-01',
      quota_snapshots: {
        chat: quota(100, 80),
        completions: quota(200, 150),
        premium_interactions: quota(300, 250),
      },
    }
    const cache = new DashboardQuotaCache(
      async () => {
        calls++
        await Promise.resolve()
        return usage
      },
      () => now,
      60_000,
    )

    const [first, second] = await Promise.all([cache.get(), cache.get()])

    expect(calls).toBe(1)
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      status: 'ok',
      resetDate: '2026-09-01',
      premiumInteractions: { entitlement: 300, remaining: 250 },
    })
    expect(JSON.stringify(first)).not.toContain('must-not-leak')
    expect(JSON.stringify(first)).not.toContain('organization')

    now += 30_000
    await cache.get()
    expect(calls).toBe(1)
  })

  test('caches an unavailable result instead of retrying on every poll', async () => {
    let calls = 0
    let now = 1_000
    const cache = new DashboardQuotaCache(
      () => {
        calls++
        return Promise.reject(new Error('raw secret failure'))
      },
      () => now,
      60_000,
    )

    expect(await cache.get()).toEqual({ status: 'unavailable' })
    now += 5_000
    expect(await cache.get()).toEqual({ status: 'unavailable' })
    expect(calls).toBe(1)
  })

  test('retains the last safe quota projection when a refresh fails', async () => {
    let calls = 0
    let now = 1_000
    const usage = quotaUsageFixture()
    const cache = new DashboardQuotaCache(
      () => {
        calls++
        return calls === 1
          ? Promise.resolve(usage)
          : Promise.reject(new Error('raw secret failure'))
      },
      () => now,
      60_000,
    )

    const current = await cache.get()
    now += 60_001
    const stale = await cache.get()

    expect(current.status).toBe('ok')
    expect(stale).toEqual({ ...current, status: 'stale' })
    expect(JSON.stringify(stale)).not.toContain('raw secret failure')
  })

  test('times out a hung refresh and allows a later poll to recover', async () => {
    let calls = 0
    let now = 1_000
    const cache = new DashboardQuotaCache(
      (signal) => {
        calls++
        if (calls > 1)
          return Promise.resolve(quotaUsageFixture())
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
      () => now,
      60_000,
      5,
    )

    expect(await cache.get()).toEqual({ status: 'unavailable' })
    now += 60_001
    expect(await cache.get()).toMatchObject({ status: 'ok', plan: 'individual' })
    expect(calls).toBe(2)
  })
})

test('upstream queue exposes a bounded read-only activity snapshot', () => {
  const queue = new UpstreamRequestQueue({ concurrency: 3, maxQueueDepth: 7 })

  expect(queue.snapshot()).toEqual({
    active: 0,
    concurrency: 3,
    pending: 0,
    maxPending: 7,
    accountCooldown: false,
    modelCooldowns: 0,
  })
})

test('upstream queue records recovery effects without relying on its logger', async () => {
  runtimeStore.requests.start({
    requestId: 'queue-observed',
    method: 'POST',
    endpoint: '/v1/responses',
  })
  const queue = new UpstreamRequestQueue({
    concurrency: 1,
    maxRetries: 1,
    baseDelayMs: 0,
    maxDelayMs: 1,
    maxQueueDepth: 1,
    recoveryBudgetMs: 1_000,
  }, {
    logger: { warn() {} },
    random: () => 0,
    sleep: async () => {},
  })
  let attempts = 0
  const result = await queue.dispatch(
    async () => {
      attempts++
      return attempts === 1
        ? new Response('', { status: 529, headers: { 'retry-after': '0' } })
        : new Response('', { status: 200 })
    },
    {
      url: 'https://example.invalid/responses',
      retryable: 'capacity',
      effectiveModel: 'gpt-5.6-sol',
      recovery: {
        requestId: 'queue-observed',
        retryCount: 0,
      },
    },
  )
  result.release()

  expect(runtimeStore.requests.summary().effectCounts).toMatchObject({
    'recovery.cooldown': 1,
    'recovery.retry': 1,
  })
})

test('retry exhaustion is not projected as recovery budget exhaustion', async () => {
  runtimeStore.requests.start({
    requestId: 'retry-limit-observed',
    method: 'POST',
    endpoint: '/v1/responses',
  })
  const events: Array<RecoveryEvent> = []
  const queue = new UpstreamRequestQueue({
    concurrency: 1,
    maxRetries: 0,
    baseDelayMs: 0,
    maxDelayMs: 1,
    maxQueueDepth: 1,
    recoveryBudgetMs: 1_000,
  }, {
    logger: {
      info(_message, fields) {
        events.push(fields)
      },
      warn() {},
    },
  })

  const result = await queue.dispatch(
    async () => new Response('', { status: 500 }),
    {
      url: 'https://example.invalid/responses',
      retryable: true,
      recovery: {
        requestId: 'retry-limit-observed',
        retryCount: 0,
      },
    },
  )
  result.release()

  expect(events).toContainEqual(expect.objectContaining({
    event: 'budget',
    decision: 'retry-limit',
  }))
  expect(runtimeStore.requests.summary().effectCounts['recovery.budget_exhausted'])
    .toBeUndefined()
})

test('a server delay beyond the recovery budget remains budget exhaustion', async () => {
  runtimeStore.requests.start({
    requestId: 'budget-exhausted-observed',
    method: 'POST',
    endpoint: '/v1/responses',
  })
  const queue = new UpstreamRequestQueue({
    concurrency: 1,
    maxRetries: 1,
    baseDelayMs: 0,
    maxDelayMs: 1,
    maxQueueDepth: 1,
    recoveryBudgetMs: 1_000,
  }, {
    logger: { warn() {} },
  })

  const result = await queue.dispatch(
    async () => new Response('', {
      status: 500,
      headers: { 'retry-after': '1' },
    }),
    {
      url: 'https://example.invalid/responses',
      retryable: true,
      recovery: {
        requestId: 'budget-exhausted-observed',
        retryCount: 0,
      },
    },
  )
  result.release()

  expect(runtimeStore.requests.summary().effectCounts['recovery.budget_exhausted'])
    .toBe(1)
})

function quota(entitlement: number, remaining: number) {
  return {
    entitlement,
    overage_count: 0,
    overage_permitted: false,
    percent_remaining: remaining / entitlement * 100,
    quota_id: 'quota-id',
    quota_remaining: remaining,
    remaining,
    unlimited: false,
  }
}

function quotaUsageFixture(): CopilotUsageResponse {
  return {
    access_type_sku: 'sku',
    analytics_tracking_id: 'must-not-leak',
    assigned_date: '2026-08-01',
    can_signup_for_limited: false,
    chat_enabled: true,
    copilot_plan: 'individual',
    organization_login_list: [],
    organization_list: [],
    quota_reset_date: '2026-09-01',
    quota_snapshots: {
      chat: quota(100, 80),
      completions: quota(200, 150),
      premium_interactions: quota(300, 250),
    },
  }
}
