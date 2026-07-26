import type { CapturedResponsesCall } from './helpers'
import type { Model, ResponsesPayload } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { getCachedConfig } from '~/lib/config'
import { modelCache } from '~/state'
import {
  applyChatCompletionsTokenParam,
  applyResponsesParameterFilters,
  clampResponsesOutputTokens,
  isReasoningModel,
  resolveStrippedResponsesParams,
} from '~/transform/parameter-filter'

import {
  buildGptModel,
  buildModel,
  buildModelsResponse,
  clearConfig,
  createApp,
  mockResponses,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

function reasoningModel(id: string, overrides?: Partial<Model>): Model {
  const model = buildGptModel(id, { supported_endpoints: ['/responses'], ...overrides })
  model.capabilities.supports.reasoning_effort = ['low', 'medium', 'high']
  return model
}

describe('parameter-filter unit', () => {
  beforeEach(() => clearConfig())
  afterEach(() => clearConfig())

  test('isReasoningModel is true only when reasoning_effort is advertised', () => {
    expect(isReasoningModel(reasoningModel('gpt-5.4-mini'))).toBe(true)
    expect(isReasoningModel(buildGptModel('gpt-4.1'))).toBe(false)
    expect(isReasoningModel(undefined)).toBe(false)
  })

  test('default rule strips sampling params for reasoning models', () => {
    const strip = resolveStrippedResponsesParams(reasoningModel('gpt-5.4-mini'))
    expect([...strip].toSorted()).toEqual(['temperature', 'top_p'])
  })

  test('default rule leaves non-reasoning models untouched', () => {
    expect(resolveStrippedResponsesParams(buildGptModel('gpt-4.1')).size).toBe(0)
  })

  test('user rules ADD params on top of the default (union)', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiParameterFilters = [
      { models: ['gpt-5*'], params: ['top_k'] },
    ]
    const strip = resolveStrippedResponsesParams(reasoningModel('gpt-5.4-mini'))
    expect([...strip].toSorted()).toEqual(['temperature', 'top_k', 'top_p'])
  })

  test('user rules apply to non-reasoning models via glob match', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiParameterFilters = [
      { models: ['gpt-4.1'], params: ['temperature'] },
    ]
    const strip = resolveStrippedResponsesParams(buildGptModel('gpt-4.1'))
    expect([...strip]).toEqual(['temperature'])
  })

  test('replaceDefault disables the built-in rule, leaving only user rules', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiParameterFiltersReplaceDefault = true
    config.responsesApiParameterFilters = [
      { models: ['gpt-5*'], params: ['top_p'] },
    ]
    const strip = resolveStrippedResponsesParams(reasoningModel('gpt-5.4-mini'))
    expect([...strip]).toEqual(['top_p'])
  })

  test('applyResponsesParameterFilters deletes keys entirely, never nulls them', () => {
    const payload: ResponsesPayload = {
      model: 'gpt-5.4-mini',
      temperature: 0.7,
      top_p: 0.9,
      max_output_tokens: 100,
    }
    applyResponsesParameterFilters(payload, reasoningModel('gpt-5.4-mini'))
    expect('temperature' in payload).toBe(false)
    expect('top_p' in payload).toBe(false)
    expect(payload.max_output_tokens).toBe(100)
  })

  test('applyResponsesParameterFilters is a no-op for non-reasoning models', () => {
    const payload: ResponsesPayload = { model: 'gpt-4.1', temperature: 0.7, top_p: 0.9 }
    applyResponsesParameterFilters(payload, buildGptModel('gpt-4.1'))
    expect(payload.temperature).toBe(0.7)
    expect(payload.top_p).toBe(0.9)
  })
})

describe('parameter-filter native /responses integration', () => {
  const originalCreateResponses = CopilotClient.prototype.createResponses
  const stateSnapshot = saveStateSnapshot()

  beforeEach(() => {
    setupDefaultTestState()
    clearConfig()
  })

  afterEach(() => {
    CopilotClient.prototype.createResponses = originalCreateResponses
    restoreStateSnapshot(stateSnapshot)
    clearConfig()
  })

  function mockUpstream(calls: Array<CapturedResponsesCall>): void {
    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-5.4-mini',
      output: [],
      output_text: 'ok',
      status: 'completed',
      usage: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
    }, calls)
  }

  test('strips temperature/top_p for a reasoning model before forwarding', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(reasoningModel('gpt-5.4-mini')))
    mockUpstream(calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        temperature: 0.7,
        top_p: 0.9,
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload).toBeDefined()
    expect('temperature' in (calls[0]!.payload as ResponsesPayload)).toBe(false)
    expect('top_p' in (calls[0]!.payload as ResponsesPayload)).toBe(false)
  })

  test('keeps sampling params for a non-reasoning model', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(
      buildGptModel('gpt-4.1', { supported_endpoints: ['/responses'] }),
    ))
    mockUpstream(calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        temperature: 0.7,
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.temperature).toBe(0.7)
  })

  test('runs after context_management injection so a user rule can strip it', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(
      buildGptModel('gpt-5.4-mini', { supported_endpoints: ['/responses'] }),
    ))
    mockUpstream(calls)

    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiAutoContextManagement = true
    config.responsesApiContextManagementModels = ['gpt-5.4-mini']
    config.responsesApiParameterFilters = [
      { models: ['gpt-5.4-mini'], params: ['context_management'] },
    ]

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect('context_management' in (calls[0]!.payload as ResponsesPayload)).toBe(false)
  })
})

// ── Evidence-backed exemptions (scripts/probes/sampling-params.ts, 2026-07-26) ──

describe('reasoning param exemptions', () => {
  beforeEach(() => clearConfig())
  afterEach(() => clearConfig())

  test('codex models keep top_p — probed as accepted where siblings reject it', () => {
    const strip = resolveStrippedResponsesParams(reasoningModel('gpt-5.3-codex'))
    expect([...strip].toSorted()).toEqual(['temperature'])
  })

  test('non-codex reasoning models still lose both params', () => {
    const strip = resolveStrippedResponsesParams(reasoningModel('gpt-5.4'))
    expect([...strip].toSorted()).toEqual(['temperature', 'top_p'])
  })

  test('a user rule can still strip an exempted param', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiParameterFilters = [
      { models: ['*-codex'], params: ['top_p'] },
    ]
    const strip = resolveStrippedResponsesParams(reasoningModel('gpt-5.3-codex'))
    expect([...strip].toSorted()).toEqual(['temperature', 'top_p'])
  })
})

// ── Output-token parameter naming ──
//
// Probed 2026-07-26 (scripts/probes/effort-and-tokens.ts):
//   /chat/completions  gpt-5.4 rejects max_tokens with
//                      "Unsupported parameter: 'max_tokens' is not supported
//                       with this model. Use 'max_completion_tokens' instead."
//                      Every other reachable model accepts both.
//   /v1/messages       requires max_tokens; max_completion_tokens yields
//                      "max_tokens: Field required".
//   /responses         max_output_tokens has a hard lower bound of 16.

describe('chat completions output-token parameter', () => {
  beforeEach(() => clearConfig())
  afterEach(() => clearConfig())

  test('renames max_tokens for a model that rejects it', () => {
    const payload = { model: 'gpt-5.4', messages: [], max_tokens: 256 }

    applyChatCompletionsTokenParam(payload, buildGptModel('gpt-5.4'))

    expect('max_tokens' in payload).toBe(false)
    expect((payload as Record<string, unknown>).max_completion_tokens).toBe(256)
  })

  test('leaves max_tokens alone for models that accept it', () => {
    const payload = { model: 'claude-opus-5', messages: [], max_tokens: 256 }

    applyChatCompletionsTokenParam(payload, buildModel('claude-opus-5'))

    expect(payload.max_tokens).toBe(256)
    expect('max_completion_tokens' in payload).toBe(false)
  })

  test('is a no-op when max_tokens is absent', () => {
    const payload: { max_tokens?: number | null } = {}

    applyChatCompletionsTokenParam(payload, buildGptModel('gpt-5.4'))

    expect('max_completion_tokens' in payload).toBe(false)
  })

  test('a user rule can extend the rename to other models', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.chatCompletionsUseMaxCompletionTokens = ['gemini-*']
    const payload = { model: 'gemini-3.5-flash', messages: [], max_tokens: 256 }

    applyChatCompletionsTokenParam(payload, buildGptModel('gemini-3.5-flash'))

    expect((payload as Record<string, unknown>).max_completion_tokens).toBe(256)
  })
})

// ── Responses output-token floor ──
//
// Probed 2026-07-26: every /responses model rejects max_output_tokens below 16
// with "Invalid 'max_output_tokens': integer below minimum value. Expected a
// value >= 16". The ceiling is NOT enforced — limits.max_output_tokens + 1 was
// accepted by all 9 — so only the floor is clamped here.
//
// The client-facing schema deliberately still accepts 0..15: that is valid
// OpenAI input, and the floor is a Copilot quirk the proxy absorbs rather than
// leaks.

describe('responses output-token floor', () => {
  test('raises a below-minimum value to the floor', () => {
    const payload: ResponsesPayload = { model: 'gpt-5.4', max_output_tokens: 1 }

    clampResponsesOutputTokens(payload)

    expect(payload.max_output_tokens).toBe(16)
  })

  test('leaves a value at the floor untouched', () => {
    const payload: ResponsesPayload = { model: 'gpt-5.4', max_output_tokens: 16 }

    clampResponsesOutputTokens(payload)

    expect(payload.max_output_tokens).toBe(16)
  })

  test('leaves a comfortable value untouched', () => {
    const payload: ResponsesPayload = { model: 'gpt-5.4', max_output_tokens: 4096 }

    clampResponsesOutputTokens(payload)

    expect(payload.max_output_tokens).toBe(4096)
  })

  test('ignores an absent value', () => {
    const payload: ResponsesPayload = { model: 'gpt-5.4' }

    clampResponsesOutputTokens(payload)

    expect(payload.max_output_tokens).toBeUndefined()
  })
})
