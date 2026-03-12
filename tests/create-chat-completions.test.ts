import type { ChatCompletionsPayload } from '~/types'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { CopilotClient } from '../src/clients/copilot-client'
import { getClientConfig, state } from '../src/lib/state'

// Mock state
state.auth.copilotToken = 'test-token'
state.cache.vsCodeVersion = '1.0.0'
state.config.accountType = 'individual'

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
    state.auth.copilotApiBase = undefined
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
      state.auth,
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
      state.auth,
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
    state.auth.copilotApiBase = 'https://api.enterprise.githubcopilot.com/'

    const payload: ChatCompletionsPayload = {
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gpt-test',
    }

    const client = new CopilotClient(
      state.auth,
      getClientConfig(),
      { fetch: fetchMock as unknown as typeof fetch },
    )
    await client.createChatCompletions(payload)

    expect(fetchMock).toHaveBeenCalled()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.enterprise.githubcopilot.com/chat/completions')
  })
})
