import type { ChatCompletionsPayload } from '~/types'

import { expect, mock, test } from 'bun:test'

import { CopilotClient } from '../src/clients/copilot-client'
import { state } from '../src/lib/state'

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
    {
      accountType: state.config.accountType,
      vsCodeVersion: state.cache.vsCodeVersion,
    },
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
    {
      accountType: state.config.accountType,
      vsCodeVersion: state.cache.vsCodeVersion,
    },
    { fetch: fetchMock as unknown as typeof fetch },
  )
  await client.createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[1][1] as { headers: Record<string, string> }
  ).headers
  expect(headers['X-Initiator']).toBe('user')
})
