import type { ModelsResponse } from '~/types'

import { afterAll, describe, expect, test } from 'bun:test'

import { createTargetRuntime, initializeM365Target } from '~/accounts/target-runtime'
import { acquireM365Credential } from '~/clients/m365-credential'
import { M365_MODELS } from '~/clients/m365-upstream'
import { compileAccountRouting } from '~/lib/account-routing'
import { getCachedConfig } from '~/lib/config'
import { HTTPError } from '~/lib/error'
import { getM365DashboardState } from '~/routes/dashboard/m365'
import {
  configureAccountRuntimes,
  createAccountRuntime,
  getTargetAvailability,
  isM365OnlyRouting,
  resetAccountRuntimes,
} from '~/state/account-runtime'

function catalog(ids: Array<string>): ModelsResponse {
  return {
    data: ids.map(id => ({
      id,
      name: id,
      supported_endpoints: ['/v1/messages'],
      capabilities: { type: 'chat', supports: { tool_calls: true } },
    })),
  } as ModelsResponse
}

describe('target runtime factory', () => {
  test('builds a GitHub target without the M365 credential identity', () => {
    const runtime = createTargetRuntime('default', 'github', {
      auth: { githubToken: 'github-token' },
    })

    expect(runtime.auth.upstream).toBe('github')
    expect(runtime.auth.githubToken).toBe('github-token')
    expect(runtime.models.getModels()).toBeUndefined()
    expect(getTargetAvailability(runtime)).toBeUndefined()
  })

  test('builds an M365 target with its credential identity', () => {
    const runtime = createTargetRuntime('m365', 'm365', {
      mscAuthExe: 'C:/tools/msc-auth.exe',
      mscAuthAccount: 'home-account-id',
      mscAuthUpn: 'operator@example.com',
    })

    expect(runtime.auth.upstream).toBe('m365')
    expect(runtime.auth.mscAuthExe).toBe('C:/tools/msc-auth.exe')
    expect(runtime.auth.mscAuthAccount).toBe('home-account-id')
    expect(runtime.auth.mscAuthUpn).toBe('operator@example.com')
  })

  test('keeps the M365 identity supplied through auth defaults', () => {
    const runtime = createTargetRuntime('m365', 'm365', {
      auth: {
        mscAuthExe: 'X.exe',
        mscAuthAccount: 'cli-account',
        mscAuthUpn: 'auth@example.com',
        m365Endpoint: 'https://custom.example.com/api',
      },
    })

    expect(runtime.auth).toMatchObject({
      upstream: 'm365',
      mscAuthExe: 'X.exe',
      mscAuthAccount: 'cli-account',
      mscAuthUpn: 'auth@example.com',
      m365Endpoint: 'https://custom.example.com/api',
    })
  })

  test('defaults the broker email and endpoint from the saved M365 settings', () => {
    const config = getCachedConfig()
    const saved = config.m365
    config.m365 = { upn: 'saved@example.com', endpoint: 'https://saved.example.com/api' }
    try {
      const runtime = createTargetRuntime('m365', 'm365')

      expect(runtime.auth.mscAuthUpn).toBe('saved@example.com')
      expect(runtime.auth.m365Endpoint).toBe('https://saved.example.com/api')
    }
    finally {
      config.m365 = saved
    }
  })

  test('initializes the catalog and reports the target ready', async () => {
    const runtime = createTargetRuntime('m365', 'm365')
    const seen: Array<Record<string, unknown>> = []

    await initializeM365Target(runtime, {
      acquireToken: async (options) => {
        seen.push({ ...options })
        return { accessToken: 'gateway-token', expiresOn: new Date(), tenant: 'tenant' }
      },
      fetchCatalog: async () => catalog(['claude-opus-5.5']),
    })

    expect(seen).toEqual([{ exe: undefined, account: undefined, upn: undefined }])
    expect(runtime.models.getModelIds()).toEqual(['claude-opus-5.5'])
    expect(getTargetAvailability(runtime)?.status).toBe('ready')
  })

  test('falls back to the static catalog when discovery fails', async () => {
    const runtime = createTargetRuntime('m365', 'm365')

    await initializeM365Target(runtime, {
      acquireToken: async () => ({ accessToken: 'gateway-token', expiresOn: new Date(), tenant: '' }),
      fetchCatalog: async () => {
        throw new Error('catalog unavailable')
      },
    })

    expect(runtime.models.getModelIds()).toEqual(M365_MODELS.data.map(model => model.id))
    expect(getTargetAvailability(runtime)?.status).toBe('ready')
  })

  test.each([401, 403])('does not report ready after catalog access is denied (%s)', async (status) => {
    const runtime = createTargetRuntime('m365', 'm365')

    await initializeM365Target(runtime, {
      acquireToken: async () => ({ accessToken: 'gateway-token', expiresOn: new Date(), tenant: '' }),
      fetchCatalog: async () => {
        throw new HTTPError(status, {
          error: { message: 'Gateway catalog access denied', type: 'authentication_error' },
        })
      },
    })

    expect(getTargetAvailability(runtime)).toMatchObject({
      status: 'unavailable',
      cause: 'Gateway catalog access denied',
    })
    expect(runtime.models.getModels()).toBeUndefined()
  })

  test('records a credential failure as unavailable without throwing', async () => {
    const runtime = createTargetRuntime('m365', 'm365')

    await initializeM365Target(runtime, {
      acquireToken: async () => {
        throw new Error('The broker has no matching account.')
      },
    })

    expect(getTargetAvailability(runtime)).toMatchObject({
      status: 'unavailable',
      cause: 'The broker has no matching account.',
    })
    expect(runtime.models.getModels()).toBeUndefined()
  })

  test('keeps catalogs isolated between targets', async () => {
    const m365 = createTargetRuntime('m365', 'm365')
    const github = createAccountRuntime('default')

    await initializeM365Target(m365, {
      acquireToken: async () => ({ accessToken: 'gateway-token', expiresOn: new Date(), tenant: '' }),
      fetchCatalog: async () => catalog(['claude-opus-5.5']),
    })

    expect(m365.models.getModelIds()).toEqual(['claude-opus-5.5'])
    expect(github.models.getModelIds()).toEqual([])
  })

  test('detects when the M365 target is the only target', () => {
    const m365 = createTargetRuntime('m365', 'm365')
    configureAccountRuntimes(
      compileAccountRouting({
        baseHostname: 'localhost',
        defaultAccount: 'm365',
        hostnames: { 'm365.localhost': 'm365' },
      }, []),
      [m365],
    )
    expect(isM365OnlyRouting()).toBe(true)

    const github = createAccountRuntime('default')
    configureAccountRuntimes(
      compileAccountRouting({
        baseHostname: 'localhost',
        defaultAccount: 'default',
        hostnames: {
          'default.localhost': 'default',
          'm365.localhost': 'm365',
        },
      }, ['default']),
      [github, m365],
    )
    expect(isM365OnlyRouting()).toBe(false)
  })

  test('projects a running target without an account manager', async () => {
    const m365 = createTargetRuntime('m365', 'm365')
    configureAccountRuntimes(
      compileAccountRouting({
        baseHostname: 'localhost',
        defaultAccount: 'm365',
        hostnames: { 'm365.localhost': 'm365' },
      }, []),
      [m365],
    )
    await initializeM365Target(m365, {
      acquireToken: async () => ({ accessToken: 'token', expiresOn: new Date(Date.now() + 60_000), tenant: '' }),
      fetchCatalog: async () => catalog(['claude-opus-5.5']),
    })

    const state = getM365DashboardState({ serverPort: 4141 })
    expect(state.registered).toBe(true)
    expect(state.hostname).toBe('m365.localhost')
    expect(state.models).toEqual(['claude-opus-5.5'])
    expect(state.availability?.status).toBe('ready')
    expect(state.onboarding.status).toBe('unavailable')
  })
})

describe('acquireM365Credential', () => {
  test('projects the broker token onto the target it is given', async () => {
    const runtime = createTargetRuntime('m365', 'm365', { mscAuthAccount: 'home-account-id' })
    const expiresOn = new Date(Date.now() + 60_000)

    const result = await acquireM365Credential(runtime, async () => ({
      accessToken: 'gateway-token',
      expiresOn,
      tenant: 'tenant-id',
      username: 'operator@example.com',
    }))

    expect(result).toEqual({ status: 'ready', accessToken: 'gateway-token' })
    expect(runtime.auth).toMatchObject({
      copilotToken: 'gateway-token',
      copilotTokenExpiresAt: expiresOn.getTime(),
      copilotTokenLastRefreshSucceeded: true,
      mscAuthUsername: 'operator@example.com',
      mscAuthTenant: 'tenant-id',
    })
    expect(runtime.auth.copilotTokenLastRefreshAt).toBeNumber()
  })

  test('records a bounded cause on failure and returns it', async () => {
    const runtime = createTargetRuntime('m365', 'm365')

    const result = await acquireM365Credential(runtime, async () => {
      throw new Error('x'.repeat(500))
    })

    expect(result).toEqual({ status: 'unavailable', cause: 'x'.repeat(400) })
    expect(runtime.auth.copilotTokenLastRefreshSucceeded).toBe(false)
    expect(getTargetAvailability(runtime)).toMatchObject({ status: 'unavailable', cause: 'x'.repeat(400) })
  })
})

afterAll(() => {
  resetAccountRuntimes()
})
