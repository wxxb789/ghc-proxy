import type { AccountRuntime } from '~/state'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GitHubClient } from '~/clients'
import {
  configureUpstreamRequestQueue,
  createCopilotClient,
  getUpstreamRequestQueueSnapshot,
} from '~/clients/factory'
import { runGuard } from '~/guard'
import { compileAccountRouting } from '~/lib/account-routing'
import { refreshCopilotToken } from '~/lib/token'
import { createRecoveryRecord } from '~/pipeline/runner'
import { dashboardQuotaCache } from '~/routes/dashboard/handler'
import { createServer } from '~/server'
import {
  authStore,
  configureAccountRuntimes,
  createAccountRuntime,
  getCurrentAccountName,
  modelCache,
  resetAccountRuntimes,
  responsesEmulatorState,
  runtimeStore,
  runWithAccountRuntime,
} from '~/state'

import { buildGptModel, buildModelsResponse, buildResponsesResult } from './helpers'

const originalFetch = globalThis.fetch

async function settleResponse(response: Response): Promise<void> {
  await response.text()
  await Bun.sleep(50)
}

function configureTwoAccounts(): {
  account1Runtime: AccountRuntime
  defaultRuntime: AccountRuntime
} {
  const defaultRuntime = createAccountRuntime('default')
  defaultRuntime.auth.githubToken = 'github-default'
  defaultRuntime.auth.copilotToken = 'copilot-default'
  defaultRuntime.models.cacheModels(buildModelsResponse(buildGptModel('default-model')))

  const account1Runtime = createAccountRuntime('account1')
  account1Runtime.auth.githubToken = 'github-account1'
  account1Runtime.auth.copilotToken = 'copilot-account1'
  account1Runtime.models.cacheModels(buildModelsResponse(buildGptModel('account1-model')))

  configureAccountRuntimes(
    compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      hostnames: {
        'default.localhost': 'default',
        'account1.localhost': 'account1',
      },
    }, ['default', 'account1']),
    [defaultRuntime, account1Runtime],
  )
  return { account1Runtime, defaultRuntime }
}

let account1Runtime: AccountRuntime
let defaultRuntime: AccountRuntime

describe('request account routing', () => {
  beforeEach(() => {
    runtimeStore.requests.reset()
    dashboardQuotaCache.reset()
    resetAccountRuntimes()
    ;({ account1Runtime, defaultRuntime } = configureTwoAccounts())
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    configureUpstreamRequestQueue({ maxRetries: 1 })
    dashboardQuotaCache.reset()
    runtimeStore.requests.reset()
    resetAccountRuntimes()
  })

  test('routes the base and named hostnames to isolated account state', async () => {
    const app = createServer().get('/__account-context', async ({ query }) => {
      await Bun.sleep(Number(query.delay ?? 0))
      return {
        accountName: getCurrentAccountName(),
        githubToken: authStore.githubToken,
        copilotToken: authStore.copilotToken,
        modelIds: modelCache.getModelIds(),
      }
    })

    const [defaultResponse, loopbackResponse, account1Response] = await Promise.all([
      app.handle(new Request('http://localhost/__account-context?delay=20')),
      app.handle(new Request('http://127.0.0.1/__account-context')),
      app.handle(new Request('http://account1.localhost/__account-context')),
    ])

    expect(await defaultResponse.json()).toEqual({
      accountName: 'default',
      githubToken: 'github-default',
      copilotToken: 'copilot-default',
      modelIds: ['default-model'],
    })
    expect(await loopbackResponse.json()).toEqual({
      accountName: 'default',
      githubToken: 'github-default',
      copilotToken: 'copilot-default',
      modelIds: ['default-model'],
    })
    expect(await account1Response.json()).toEqual({
      accountName: 'account1',
      githubToken: 'github-account1',
      copilotToken: 'copilot-account1',
      modelIds: ['account1-model'],
    })
  })

  test('preserves account context while async response streams are consumed', async () => {
    const app = createServer().get('/__account-stream', async function* ({ query }) {
      await Bun.sleep(Number(query.delay ?? 0))
      yield authStore.copilotToken
    })

    const [defaultResponse, account1Response] = await Promise.all([
      app.handle(new Request('http://localhost/__account-stream?delay=20')),
      app.handle(new Request('http://account1.localhost/__account-stream')),
    ])

    expect(await defaultResponse.text()).toContain('copilot-default')
    expect(await account1Response.text()).toContain('copilot-account1')
  })

  test('keeps the default account stable after a named-account request', async () => {
    const app = createServer()

    const namedResponse = await app.handle(new Request('http://account1.localhost/token'))
    const namedClone = namedResponse.clone()
    await settleResponse(namedResponse)
    expect(getCurrentAccountName()).toBe('default')
    const defaultResponse = await app.handle(new Request('http://localhost/token'))

    expect(await namedClone.json()).toEqual({ token: 'copilot-account1' })
    expect(await defaultResponse.json()).toEqual({ token: 'copilot-default' })
  })

  test('records the selected named account with the request', async () => {
    const response = await createServer().handle(
      new Request('http://account1.localhost/token'),
    )
    const clone = response.clone()
    await settleResponse(response)

    expect(clone.status).toBe(200)
    expect(runtimeStore.requests.snapshot().recent[0]).toMatchObject({
      accountName: 'account1',
      endpoint: '/token',
      status: 200,
    })
  })

  test('attributes pipeline recovery state to the selected account', () => {
    const recovery = runWithAccountRuntime(account1Runtime, () => createRecoveryRecord({
      requestId: 'request-id',
      signal: new AbortController().signal,
    }))

    expect(recovery).toMatchObject({
      accountName: 'account1',
      requestId: 'request-id',
    })
  })

  test('uses the selected account credential on concurrent upstream requests', async () => {
    const authorizationHeaders: string[] = []
    globalThis.fetch = (async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? ''
      await Bun.sleep(authorization.includes('github-default') ? 20 : 0)
      authorizationHeaders.push(authorization)
      const quota = {
        entitlement: 100,
        remaining: 50,
        percent_remaining: 50,
        unlimited: false,
        overage_permitted: false,
      }
      return Response.json({
        copilot_plan: authorization,
        quota_reset_date: '2099-01-01',
        quota_snapshots: {
          chat: quota,
          completions: quota,
          premium_interactions: quota,
        },
      })
    }) as typeof fetch

    const app = createServer()
    const [defaultResponse, account1Response] = await Promise.all([
      app.handle(new Request('http://localhost/usage')),
      app.handle(new Request('http://account1.localhost/usage')),
    ])

    const defaultBody = await defaultResponse.json() as { copilot_plan: string }
    const account1Body = await account1Response.json() as { copilot_plan: string }
    expect(defaultBody.copilot_plan).toBe('token github-default')
    expect(account1Body.copilot_plan).toBe('token github-account1')
    expect(authorizationHeaders.sort()).toEqual([
      'token github-account1',
      'token github-default',
    ])
  })

  test('keeps dashboard quota cache entries isolated per account', async () => {
    const authorizationHeaders: string[] = []
    globalThis.fetch = (async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? ''
      authorizationHeaders.push(authorization)
      const quota = {
        entitlement: 100,
        remaining: 50,
        percent_remaining: 50,
        unlimited: false,
        overage_permitted: false,
      }
      return Response.json({
        copilot_plan: authorization,
        quota_reset_date: '2099-01-01',
        quota_snapshots: {
          chat: quota,
          completions: quota,
          premium_interactions: quota,
        },
      })
    }) as typeof fetch

    const app = createServer()
    const account1Response = await app.handle(
      new Request('http://account1.localhost/dashboard/api/overview'),
    )
    const defaultResponse = await app.handle(
      new Request('http://localhost/dashboard/api/overview'),
    )

    const account1Body = await account1Response.json() as { quota: { plan: string } }
    const defaultBody = await defaultResponse.json() as { quota: { plan: string } }
    expect(account1Body.quota.plan).toBe('token github-account1')
    expect(defaultBody.quota.plan).toBe('token github-default')
    expect(authorizationHeaders).toEqual([
      'token github-account1',
      'token github-default',
    ])
  })

  test('does not fall back to the default account when a named account fails', async () => {
    const authorizationHeaders: string[] = []
    globalThis.fetch = (async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? ''
      authorizationHeaders.push(authorization)
      if (authorization === 'token github-account1') {
        return Response.json(
          { message: 'bad credentials' },
          { status: 401 },
        )
      }
      return Response.json({
        copilot_plan: 'default',
        quota_reset_date: '2099-01-01',
        quota_snapshots: {},
      })
    }) as typeof fetch

    const app = createServer()
    const failed = await app.handle(new Request('http://account1.localhost/usage'))

    expect(failed.status).toBe(401)
    expect(authorizationHeaders).toEqual(['token github-account1'])

    const defaultResponse = await app.handle(new Request('http://localhost/usage'))
    expect(defaultResponse.status).toBe(200)
    expect(authorizationHeaders).toEqual([
      'token github-account1',
      'token github-default',
    ])
  })

  test('keeps account cooldown state isolated from other accounts', async () => {
    configureUpstreamRequestQueue({ maxRetries: 0 })
    globalThis.fetch = (async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization === 'Bearer copilot-account1') {
        return Response.json(
          { error: { message: 'rate limited', type: 'rate_limit_error' } },
          { status: 429, headers: { 'retry-after': '60' } },
        )
      }
      return Response.json(buildModelsResponse(buildGptModel('default-model')))
    }) as typeof fetch

    await expect(runWithAccountRuntime(
      account1Runtime,
      () => createCopilotClient().getModels(),
    )).rejects.toMatchObject({ status: 429 })

    expect(runWithAccountRuntime(
      account1Runtime,
      () => getUpstreamRequestQueueSnapshot().accountCooldown,
    )).toBe(true)
    expect(runWithAccountRuntime(
      defaultRuntime,
      () => getUpstreamRequestQueueSnapshot().accountCooldown,
    )).toBe(false)
    await expect(runWithAccountRuntime(
      defaultRuntime,
      () => createCopilotClient().getModels(),
    )).resolves.toMatchObject({ data: [{ id: 'default-model' }] })
  })

  test('keeps local request throttling isolated per account', async () => {
    defaultRuntime.auth.rateLimitSeconds = 60
    account1Runtime.auth.rateLimitSeconds = 60

    await expect(runWithAccountRuntime(defaultRuntime, runGuard)).resolves.toBeUndefined()
    await expect(runWithAccountRuntime(account1Runtime, runGuard)).resolves.toBeUndefined()
    await expect(runWithAccountRuntime(defaultRuntime, runGuard)).rejects.toMatchObject({
      status: 429,
    })
  })

  test('refreshes concurrent account tokens without overwriting another account', async () => {
    const createClient = (runtime: AccountRuntime) => new GitHubClient(
      runtime.auth,
      { accountType: 'individual', vsCodeVersion: '1.0.0' },
      {
        fetch: (async (_input, init) => {
          const authorization = new Headers(init?.headers).get('authorization')
          await Bun.sleep(authorization?.includes('github-default') ? 20 : 0)
          return Response.json({
            token: authorization === 'token github-default'
              ? 'refreshed-default'
              : 'refreshed-account1',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            refresh_in: 1800,
          })
        }) as typeof fetch,
      },
    )

    await Promise.all([
      runWithAccountRuntime(
        defaultRuntime,
        () => refreshCopilotToken(createClient(defaultRuntime)),
      ),
      runWithAccountRuntime(
        account1Runtime,
        () => refreshCopilotToken(createClient(account1Runtime)),
      ),
    ])

    expect(defaultRuntime.auth.copilotToken).toBe('refreshed-default')
    expect(account1Runtime.auth.copilotToken).toBe('refreshed-account1')
  })

  test('keeps emulator resources isolated when response IDs collide', async () => {
    const app = createServer().post('/__emulator/:model', async ({ params, query }) => {
      await Bun.sleep(Number(query.delay ?? 0))
      responsesEmulatorState.setResponse(buildResponsesResult({
        id: 'resp_shared',
        model: params.model,
      }))
      return responsesEmulatorState.getResponse('resp_shared')
    })

    await Promise.all([
      app.handle(new Request('http://localhost/__emulator/default-model?delay=20', {
        method: 'POST',
      })),
      app.handle(new Request('http://account1.localhost/__emulator/account1-model', {
        method: 'POST',
      })),
    ])

    expect(runWithAccountRuntime(
      defaultRuntime,
      () => responsesEmulatorState.getResponse('resp_shared')?.model,
    )).toBe('default-model')
    expect(runWithAccountRuntime(
      account1Runtime,
      () => responsesEmulatorState.getResponse('resp_shared')?.model,
    )).toBe('account1-model')
  })

  test('rejects an unconfigured hostname before invoking a route handler', async () => {
    let handled = false
    const app = createServer().get('/__account-context', () => {
      handled = true
      return 'handled'
    })

    const response = await app.handle(new Request('http://unknown.localhost/__account-context'))

    expect(response.status).toBe(421)
    expect(await response.json()).toEqual({
      error: {
        message: 'No account is configured for hostname "unknown.localhost".',
        type: 'invalid_request_error',
      },
    })
    expect(handled).toBe(false)
  })

  test('rejects an unconfigured hostname before CORS preflight handling', async () => {
    const response = await createServer().handle(new Request(
      'http://unknown.localhost/v1/messages',
      {
        method: 'OPTIONS',
        headers: {
          'access-control-request-method': 'POST',
          'origin': 'http://unknown.localhost',
        },
      },
    ))

    expect(response.status).toBe(421)
  })

  test('keeps the Anthropic error envelope when hostname routing rejects Messages', async () => {
    for (const path of [
      '/v1/messages',
      '/v1/messages/',
      '/v1/messages/count_tokens',
      '/v1/messages/count_tokens/',
    ]) {
      const response = await createServer().handle(new Request(
        `http://unknown.localhost${path}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      ))

      expect(response.status).toBe(421)
      expect(await response.json()).toEqual({
        type: 'error',
        error: {
          message: 'No account is configured for hostname "unknown.localhost".',
          type: 'invalid_request_error',
        },
      })
    }
  })

  test('ignores untrusted forwarded host headers', async () => {
    const response = await createServer().handle(new Request('http://localhost/token', {
      headers: {
        'forwarded': 'host=account1.localhost',
        'x-forwarded-host': 'account1.localhost',
      },
    }))

    expect(await response.json()).toEqual({ token: 'copilot-default' })
  })

  test('preserves legacy single-account behavior when account routing is disabled', async () => {
    resetAccountRuntimes()
    authStore.copilotToken = 'legacy-token'

    const response = await createServer().handle(new Request('http://arbitrary.example/token'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ token: 'legacy-token' })
  })
})
