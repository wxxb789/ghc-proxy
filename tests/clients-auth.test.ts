import type { ClientAuth, ClientConfig } from '../src/clients/types'
import type { ChatCompletionsPayload } from '~/types'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { authStore, modelCache } from '~/state'
import { CopilotClient } from '../src/clients/copilot-client'
import { getClientConfig } from '../src/clients/factory'

import { buildGitHubUrls, normalizeGheDomain } from '../src/clients/ghe-domain'

// Use import.meta.resolve to get the absolute file URL, bypassing Bun's mock.module registry.
// This ensures we always test the real GitHubClient even if another test file
// (e.g. token-file-removal.test.ts) has called mock.module('../src/clients/github-client').
const { GitHubClient } = await import(import.meta.resolve('../src/clients/github-client')) as typeof import('../src/clients/github-client')

// ── normalizeGheDomain / buildGitHubUrls — pure domain helpers ──

describe('normalizeGheDomain', () => {
  test('bare domain passes through unchanged', () => {
    expect(normalizeGheDomain('company.ghe.com')).toBe('company.ghe.com')
  })

  test('strips https:// prefix', () => {
    expect(normalizeGheDomain('https://company.ghe.com')).toBe('company.ghe.com')
  })

  test('strips https:// prefix, lowercases, and removes trailing slash', () => {
    expect(normalizeGheDomain('https://Company.GHE.com/')).toBe('company.ghe.com')
  })

  test('strips http:// prefix', () => {
    expect(normalizeGheDomain('http://company.ghe.com')).toBe('company.ghe.com')
  })

  test('strips trailing slashes and paths', () => {
    expect(normalizeGheDomain('https://company.ghe.com/some/path')).toBe('company.ghe.com')
  })

  test('handles deep subdomains', () => {
    expect(normalizeGheDomain('dev.internal.ghe.com')).toBe('dev.internal.ghe.com')
  })

  test('rejects non-.ghe.com domains', () => {
    expect(() => normalizeGheDomain('github.example.com')).toThrow('must end with .ghe.com')
  })

  test('rejects bare ghe.com without subdomain', () => {
    expect(() => normalizeGheDomain('ghe.com')).toThrow('must end with .ghe.com')
  })

  test('rejects empty string', () => {
    expect(() => normalizeGheDomain('')).toThrow('GHE domain must not be empty')
  })

  test('rejects whitespace-only string', () => {
    expect(() => normalizeGheDomain('   ')).toThrow('GHE domain must not be empty')
  })
})

describe('buildGitHubUrls', () => {
  test('no domain returns default GitHub URLs', () => {
    expect(buildGitHubUrls()).toEqual({
      baseUrl: 'https://github.com',
      apiBaseUrl: 'https://api.github.com',
    })
  })

  test('undefined domain returns default GitHub URLs', () => {
    expect(buildGitHubUrls(undefined)).toEqual({
      baseUrl: 'https://github.com',
      apiBaseUrl: 'https://api.github.com',
    })
  })

  test('GHE domain returns GHE URLs', () => {
    expect(buildGitHubUrls('company.ghe.com')).toEqual({
      baseUrl: 'https://company.ghe.com',
      apiBaseUrl: 'https://api.company.ghe.com',
    })
  })

  test('GHE domain with deep subdomain returns correct URLs', () => {
    expect(buildGitHubUrls('dev.internal.ghe.com')).toEqual({
      baseUrl: 'https://dev.internal.ghe.com',
      apiBaseUrl: 'https://api.dev.internal.ghe.com',
    })
  })

  test('GHE domain input is normalized before building URLs', () => {
    expect(buildGitHubUrls('https://Company.GHE.com/')).toEqual({
      baseUrl: 'https://company.ghe.com',
      apiBaseUrl: 'https://api.company.ghe.com',
    })
  })

  test('invalid domain propagates normalizeGheDomain error', () => {
    expect(() => buildGitHubUrls('github.example.com')).toThrow('must end with .ghe.com')
  })
})

// ── GitHubClient URL routing (real module via import.meta.resolve) ──

// Minimal mock response factory
function okJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const baseAuth: ClientAuth = {
  githubToken: 'test-github-token',
  copilotToken: 'test-copilot-token',
}

const defaultConfig: ClientConfig = {
  accountType: 'individual',
}

const gheConfig: ClientConfig = {
  accountType: 'individual',
  githubBaseUrl: 'https://company.ghe.com',
  githubApiBaseUrl: 'https://api.company.ghe.com',
}

/**
 * Creates a fetch spy that:
 *  - passes a plain function typed as `typeof fetch` to GitHubClient (no mock proxy cast)
 *  - records every call URL via a Bun mock so we can assert on it
 */
function createFetchSpy(response: unknown) {
  const recorder = mock((_url: string) => _url)
  const fetchImpl = (input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
    recorder(String(input))
    return Promise.resolve(okJson(response))
  }
  return { fetchImpl: fetchImpl as unknown as typeof fetch, recorder }
}

describe('GitHubClient URL routing', () => {
  describe('getDeviceCode()', () => {
    test('default config uses https://github.com', async () => {
      const { fetchImpl, recorder } = createFetchSpy({
        device_code: 'dc',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: fetchImpl })
      await client.getDeviceCode()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://github.com/login/device/code')
    })

    test('GHE config routes to GHE base URL', async () => {
      const { fetchImpl, recorder } = createFetchSpy({
        device_code: 'dc',
        user_code: 'ABCD-1234',
        verification_uri: 'https://company.ghe.com/login/device',
        expires_in: 900,
        interval: 5,
      })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: fetchImpl })
      await client.getDeviceCode()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://company.ghe.com/login/device/code')
    })
  })

  describe('pollAccessToken()', () => {
    const deviceCode = {
      device_code: 'dc',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 0, // 0 so test doesn't sleep long
    }

    test('default config polls https://github.com', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ access_token: 'test-token', token_type: 'bearer', scope: '' })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: fetchImpl })
      const token = await client.pollAccessToken(deviceCode)

      expect(recorder.mock.calls[0]?.[0]).toBe('https://github.com/login/oauth/access_token')
      expect(token).toBe('test-token')
    })

    test('GHE config polls GHE base URL', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ access_token: 'ghe-token', token_type: 'bearer', scope: '' })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: fetchImpl })
      const token = await client.pollAccessToken(deviceCode)

      expect(recorder.mock.calls[0]?.[0]).toBe('https://company.ghe.com/login/oauth/access_token')
      expect(token).toBe('ghe-token')
    })
  })

  describe('getGitHubUser()', () => {
    test('default config uses https://api.github.com', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ login: 'testuser', id: 1 })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: fetchImpl })
      await client.getGitHubUser()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://api.github.com/user')
    })

    test('GHE config routes to GHE API base URL', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ login: 'gheuser', id: 2 })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: fetchImpl })
      await client.getGitHubUser()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://api.company.ghe.com/user')
    })
  })

  describe('getCopilotToken()', () => {
    test('default config uses https://api.github.com', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ token: 'copilot-tok', refresh_in: 1800 })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: fetchImpl })
      await client.getCopilotToken()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://api.github.com/copilot_internal/v2/token')
    })

    test('GHE config routes to GHE API base URL', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ token: 'ghe-copilot-tok', refresh_in: 1800 })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: fetchImpl })
      await client.getCopilotToken()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://api.company.ghe.com/copilot_internal/v2/token')
    })
  })

  describe('getCopilotUsage()', () => {
    test('default config uses https://api.github.com', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ seat_breakdown: {}, total_suggestions_count: 0 })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: fetchImpl })
      await client.getCopilotUsage()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://api.github.com/copilot_internal/user')
    })

    test('GHE config routes to GHE API base URL', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ seat_breakdown: {}, total_suggestions_count: 5 })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: fetchImpl })
      await client.getCopilotUsage()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://api.company.ghe.com/copilot_internal/user')
    })
  })
})

// ── createChatCompletions — header injection + api base resolution ──

// Mock state
authStore.copilotToken = 'test-token'
modelCache.setVSCodeVersion('1.0.0')
authStore.accountType = 'individual'

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    return {
      ok: true,
      json: () => ({ id: '123', object: 'chat.completion', choices: [] }),
      headers: opts.headers,
    }
  },
)
describe('createChatCompletions', () => {
  beforeEach(() => {
    fetchMock.mockClear()
  })

  afterEach(() => {
    authStore.copilotApiBase = undefined
  })

  test('sets X-Initiator to agent if tool/assistant present', async () => {
    const payload: ChatCompletionsPayload = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'tool call' },
      ],
      model: 'gpt-test',
    }
    const client = new CopilotClient(
      authStore,
      getClientConfig(),
      { fetch: fetchMock as unknown as typeof fetch },
    )
    await client.createChatCompletions(payload)
    expect(fetchMock).toHaveBeenCalled()
    const headers = (
      fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(headers['X-Initiator']).toBe('agent')
  })

  test('sets X-Initiator to user if only user present', async () => {
    const payload: ChatCompletionsPayload = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'user', content: 'hello again' },
      ],
      model: 'gpt-test',
    }
    const client = new CopilotClient(
      authStore,
      getClientConfig(),
      { fetch: fetchMock as unknown as typeof fetch },
    )
    await client.createChatCompletions(payload)
    expect(fetchMock).toHaveBeenCalled()
    const headers = (
      fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(headers['X-Initiator']).toBe('user')
  })

  test('prefers dynamic copilot api base from token state', async () => {
    authStore.copilotApiBase = 'https://api.enterprise.githubcopilot.com/'

    const payload: ChatCompletionsPayload = {
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gpt-test',
    }

    const client = new CopilotClient(
      authStore,
      getClientConfig(),
      { fetch: fetchMock as unknown as typeof fetch },
    )
    await client.createChatCompletions(payload)

    expect(fetchMock).toHaveBeenCalled()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.enterprise.githubcopilot.com/chat/completions')
  })
})
