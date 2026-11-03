import type { ModelsResponse } from '~/types'

import { beforeEach, describe, expect, test } from 'bun:test'

import { createTargetRuntime, initializeM365Target } from '~/accounts/target-runtime'
import { M365_MODELS } from '~/clients/m365-upstream'
import {
  clearTargetAvailability,
  createAccountRuntime,
  getTargetAvailability,
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
  beforeEach(() => {
    clearTargetAvailability()
  })

  test('builds a GitHub target without the M365 credential identity', () => {
    const runtime = createTargetRuntime('default', 'github', {
      auth: { githubToken: 'github-token' },
    })

    expect(runtime.auth.upstream).toBe('github')
    expect(runtime.auth.githubToken).toBe('github-token')
    expect(runtime.models.getModels()).toBeUndefined()
    expect(getTargetAvailability('default')).toBeUndefined()
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
    expect(getTargetAvailability('m365')?.status).toBe('ready')
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
    expect(getTargetAvailability('m365')?.status).toBe('ready')
  })

  test('records a credential failure as unavailable without throwing', async () => {
    const runtime = createTargetRuntime('m365', 'm365')

    await initializeM365Target(runtime, {
      acquireToken: async () => {
        throw new Error('The broker has no matching account.')
      },
    })

    expect(getTargetAvailability('m365')).toMatchObject({
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
})
