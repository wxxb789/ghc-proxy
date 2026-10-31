import { afterEach, describe, expect, test } from 'bun:test'

import { copilotBaseUrl, copilotHeaders } from '~/clients/api-config'
import { fetchM365Models, M365_FALLBACKS, M365_MODELS, m365FallbackFor, m365Headers } from '~/clients/m365-upstream'
import { modelCache } from '~/state'

afterEach(() => {
  modelCache.clearModels()
})

describe('m365 upstream transport', () => {
  test('routes the base URL to the gateway only for the m365 upstream', () => {
    expect(copilotBaseUrl({ accountType: 'individual', upstream: 'm365' }))
      .toBe('https://msit.loki.delve.office.com/api/v1/llmapi')
    expect(copilotBaseUrl({ accountType: 'individual' })).toBe('https://api.githubcopilot.com')
    expect(
      copilotBaseUrl({ accountType: 'business', copilotApiBase: 'https://example.test/' }),
    ).toBe('https://example.test')
  })

  test('sends the gateway header contract instead of the GitHub one', () => {
    const headers = copilotHeaders(
      { copilotToken: 'token-value' },
      { accountType: 'individual', upstream: 'm365' },
    )

    expect(headers.Authorization).toBe('Bearer token-value')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['X-ClientType']).toBe('Copilot')
    expect(headers['X-ClientFeature']).toBe('LlmApiProxy')
    expect(headers['X-ClientScenario']).toBe('Code')
    expect(headers['X-HostPlatform']).toBe('Windows')
    expect(headers['X-Llm-Api-Version']).toBe('2026-10-16')
    expect(headers['X-Initiator']).toBe('user')
    expect(headers['X-ClientCallId']).toMatch(/^[\da-f-]{36}$/u)

    expect(headers['copilot-integration-id']).toBeUndefined()
    expect(headers['editor-version']).toBeUndefined()
    expect(headers['x-github-api-version']).toBeUndefined()
  })

  test('issues a fresh conversation and call id per request', () => {
    const first = m365Headers('token-value')
    const second = m365Headers('token-value')
    expect(first['X-ConversationId']).not.toBe(second['X-ConversationId'])
    expect(first['X-ClientCallId']).not.toBe(second['X-ClientCallId'])
  })
})

describe('m365 model catalog', () => {
  test('lists only the verified models and routes them to native messages', () => {
    const ids = M365_MODELS.data.map(model => model.id)
    expect(ids).toEqual([
      'claude-opus-5.5',
      'claude-opus-5',
      'claude-sonnet-5.5',
      'claude-sonnet-5',
      'claude-haiku-5.5',
    ])

    modelCache.cacheModels(M365_MODELS)
    for (const id of ids) {
      const model = modelCache.findById(id)
      expect(modelCache.supportsEndpoint(model, '/v1/messages')).toBe(true)
      expect(modelCache.supportsEndpoint(model, '/responses')).toBe(false)
    }
    expect(modelCache.findById('claude-sonnet-4-5-20250929')).toBeUndefined()
  })

  test('advertises the measured output ceiling for every model', () => {
    for (const model of M365_MODELS.data) {
      expect(model.capabilities.limits.max_output_tokens).toBe(128_000)
    }
  })

  test('advertises the assumed 1M context for the 5.5 series only', () => {
    for (const model of M365_MODELS.data) {
      const isSeries55 = model.version === '5.5'
      expect(model.capabilities.limits.max_context_window_tokens).toBe(
        isSeries55 ? 1_000_000 : undefined,
      )
      expect(model.capabilities.limits.max_prompt_tokens).toBe(
        isSeries55 ? 1_000_000 : undefined,
      )
    }
  })

  test('maps unadvertised families onto catalog targets', () => {
    const ids = M365_MODELS.data.map(model => model.id)

    expect(m365FallbackFor('claude-opus-4.6', ids)).toBe('claude-opus-5.5')
    expect(m365FallbackFor('claude-sonnet-4-5-20250929', ids)).toBe('claude-sonnet-5.5')
    expect(m365FallbackFor('claude-haiku-4.5', ids)).toBe('claude-haiku-5.5')
  })

  test('leaves advertised ids and other vendors untouched', () => {
    const ids = M365_MODELS.data.map(model => model.id)

    for (const id of ids) {
      expect(m365FallbackFor(id, ids)).toBeUndefined()
    }
    expect(m365FallbackFor('gpt-6-sol', ids)).toBeUndefined()
  })

  test('resolves every fallback to a catalog member', () => {
    const ids = new Set(M365_MODELS.data.map(model => model.id))

    expect(ids.has(M365_FALLBACKS.claudeOpus)).toBe(true)
    expect(ids.has(M365_FALLBACKS.claudeSonnet)).toBe(true)
    expect(ids.has(M365_FALLBACKS.claudeHaiku)).toBe(true)
    expect(M365_FALLBACKS.claudeSonnet).toBe('claude-sonnet-5.5')
  })

  test('maps the gateway catalog onto /v1/messages models only', async () => {
    const gateway = {
      data: [
        {
          id: 'claude-opus-5.5',
          name: 'Claude Opus 5.5',
          publisher: 'Anthropic',
          supported_endpoints: ['/v1/messages'],
          capabilities: { limits: { max_context_window_tokens: 1000000 } },
        },
        { id: 'gpt-6-sol', supported_endpoints: ['/responses'] },
      ],
    }
    const models = await fetchM365Models('token', async () => Response.json(gateway))

    expect(models.data.map(model => model.id)).toEqual(['claude-opus-5.5'])
    const [model] = models.data
    expect(model?.capabilities.limits.max_context_window_tokens).toBe(1_000_000)
    expect(model?.capabilities.limits.max_output_tokens).toBe(128_000)
    expect(model?.vendor).toBe('anthropic')
  })

  test('rejects a catalog without usable models', async () => {
    await expect(
      fetchM365Models('token', async () => Response.json({ data: [{ id: 'gpt-6-sol', supported_endpoints: ['/responses'] }] })),
    ).rejects.toThrow('no /v1/messages models')
  })
})
