import type { DeviceCodeResponse } from '~/types'

import { describe, expect, mock, test } from 'bun:test'

import {
  beginAccountDeviceAuthentication,
} from '~/accounts/device-auth'

const deviceCode: DeviceCodeResponse = {
  device_code: 'private-device-code',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
}

describe('account device authentication', () => {
  test('returns only public device instructions and validates the account before completion', async () => {
    const stopRefresh = mock(() => {})
    const flow = await beginAccountDeviceAuthentication({
      accountName: 'work',
      gheDomain: 'company.ghe.com',
      authDefaults: { rateLimitWait: true },
    }, {
      now: () => 1_000,
      prepareRuntime: async runtime => runtime.models.setVSCodeVersion('1.99.0'),
      createClient: () => ({
        getDeviceCode: async () => deviceCode,
        pollAccessToken: async () => 'private-github-token',
        getGitHubUser: async () => ({ login: 'octocat-work' }),
      }),
      activateCopilot: async (runtime) => {
        runtime.auth.copilotToken = 'private-copilot-token'
        runtime.auth.copilotTokenExpiresAt = 120_000
        runtime.auth.copilotTokenLastRefreshAt = 2_000
        runtime.auth.copilotTokenLastRefreshSucceeded = true
        return stopRefresh
      },
      loadModels: async runtime => runtime.models.cacheModels({ object: 'list', data: [] }),
    })

    expect(flow.authorization).toEqual({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresAt: new Date(901_000).toISOString(),
      pollIntervalSeconds: 5,
    })
    expect(JSON.stringify(flow.authorization)).not.toContain('private-device-code')

    const result = await flow.completion
    expect(result.githubToken).toBe('private-github-token')
    expect(result.runtime).toMatchObject({
      name: 'work',
      auth: {
        githubLogin: 'octocat-work',
        gheDomain: 'company.ghe.com',
        rateLimitWait: true,
        copilotToken: 'private-copilot-token',
      },
    })
    expect(result.stopRefresh).toBe(stopRefresh)
  })

  test('passes cancellation to polling and leaves no persisted state', async () => {
    const controller = new AbortController()
    const pollAccessToken = mock((_device: DeviceCodeResponse, options?: { signal?: AbortSignal }) => {
      options?.signal?.throwIfAborted()
      return Promise.resolve('unexpected')
    })
    const flow = await beginAccountDeviceAuthentication({
      accountName: 'cancelled',
      signal: controller.signal,
    }, {
      prepareRuntime: async () => {},
      createClient: () => ({
        getDeviceCode: async () => deviceCode,
        pollAccessToken,
        getGitHubUser: async () => ({ login: 'unexpected' }),
      }),
      activateCopilot: async () => mock(() => {}),
      loadModels: async () => {},
    })
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(flow.completion).rejects.toThrow('cancelled')
    expect(pollAccessToken).toHaveBeenCalledTimes(1)
  })

  test('stops token refresh when model validation fails', async () => {
    const stopRefresh = mock(() => {})
    const flow = await beginAccountDeviceAuthentication({
      accountName: 'broken',
    }, {
      prepareRuntime: async () => {},
      createClient: () => ({
        getDeviceCode: async () => deviceCode,
        pollAccessToken: async () => 'private-github-token',
        getGitHubUser: async () => ({ login: 'broken-user' }),
      }),
      activateCopilot: async () => stopRefresh,
      loadModels: async () => {
        throw new Error('model validation failed')
      },
    })

    await expect(flow.completion).rejects.toThrow('model validation failed')
    expect(stopRefresh).toHaveBeenCalledTimes(1)
  })
})
