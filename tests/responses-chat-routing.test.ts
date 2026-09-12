import type { CapturedChatCall, CapturedResponsesCall } from './helpers'
import type { CapiChatCompletionResponse } from '~/core/capi'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { CopilotClient } from '~/clients'
import { getCachedConfig } from '~/lib/config'
import { modelCache, runtimeStore } from '~/state'
import { buildModel, buildModelsResponse, buildResponsesResult, clearConfig, createApp, mockNonStreamingResponse, mockResponses, restoreStateSnapshot, saveStateSnapshot, setupDefaultTestState } from './helpers'

const snapshot = saveStateSnapshot()
const originalConfig = structuredClone(getCachedConfig())
const originalChat = CopilotClient.prototype.createChatCompletions
const originalResponses = CopilotClient.prototype.createResponses
const chatResult: CapiChatCompletionResponse = {
  id: 'chatcmpl_test',
  object: 'chat.completion',
  created: 1,
  model: 'gemini-test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop', logprobs: null }],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
}

beforeEach(() => {
  setupDefaultTestState()
  clearConfig()
  runtimeStore.requests.reset()
  modelCache.cacheModels(buildModelsResponse(buildModel('gemini-test', { supported_endpoints: ['/chat/completions'] })))
})

afterEach(() => {
  CopilotClient.prototype.createChatCompletions = originalChat
  CopilotClient.prototype.createResponses = originalResponses
  restoreStateSnapshot(snapshot)
  clearConfig()
  Object.assign(getCachedConfig(), originalConfig)
  runtimeStore.requests.reset()
})

function post(body: Record<string, unknown>) {
  return createApp('responses').handle(new Request('http://localhost/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-test', input: 'hello', store: false, ...body }),
  }))
}

describe('Responses via Chat Completions', () => {
  test('opt-in translates the request and returns a Responses object', async () => {
    getCachedConfig().responsesChatCompletionsFallback = true
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(chatResult, calls)
    const response = await post({ temperature: 0.5, top_p: 0.8, parallel_tool_calls: false })
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.object).toBe('response')
    expect(body.status).toBe('completed')
    expect(body.output_text).toBe('hello')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.payload).toMatchObject({ model: 'gemini-test', temperature: 0.5, top_p: 0.8, parallel_tool_calls: false })
  })

  test('disabled by default, without a Chat dispatch', async () => {
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(chatResult, calls)
    expect((await post({})).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('requires explicit store=false when the local emulator is disabled', async () => {
    getCachedConfig().responsesChatCompletionsFallback = true
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(chatResult, calls)

    const response = await createApp('responses').handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-test', input: 'hello' }),
    }))

    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('preserves caller CAPI context on the translated path', async () => {
    getCachedConfig().responsesChatCompletionsFallback = true
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(chatResult, calls)
    const response = await createApp('responses').handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-interaction-type': 'conversation-subagent',
        'x-agent-task-id': 'child-task',
        'x-parent-agent-id': 'parent-task',
        'x-client-session-id': 'client-session',
        'x-interaction-id': 'client-interaction',
        'x-client-machine-id': 'client-machine',
      },
      body: JSON.stringify({ model: 'gemini-test', input: 'hello', store: false }),
    }))
    expect(response.status).toBe(200)
    expect(calls[0]?.options).toMatchObject({
      initiator: 'agent',
      requestContext: {
        interactionType: 'conversation-subagent',
        agentTaskId: 'child-task',
        parentAgentTaskId: 'parent-task',
        clientSessionId: 'client-session',
        interactionId: 'client-interaction',
        clientMachineId: 'client-machine',
      },
    })
  })

  test('native Responses wins for a dual-endpoint model', async () => {
    getCachedConfig().responsesChatCompletionsFallback = true
    modelCache.cacheModels(buildModelsResponse(buildModel('gemini-test', { supported_endpoints: ['/responses', '/chat/completions'] })))
    const chatCalls: Array<CapturedChatCall> = []
    const nativeCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse(chatResult, chatCalls)
    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({ status: 'completed' }), nativeCalls)
    expect((await post({ tools: [{ type: 'web_search' }] })).status).toBe(200)
    expect(nativeCalls).toHaveLength(1)
    expect(chatCalls).toHaveLength(0)
  })

  test('closes the upstream iterator after a terminal translation failure', async () => {
    getCachedConfig().responsesChatCompletionsFallback = true
    let advancedAfterFailure = 0
    let cleanupCalls = 0
    CopilotClient.prototype.createChatCompletions = async () => (async function* () {
      try {
        yield { data: JSON.stringify({ choices: [{ index: 0, delta: { content: 17 }, finish_reason: null }] }) }
        advancedAfterFailure++
        yield { data: '[DONE]' }
      }
      finally {
        cleanupCalls++
      }
    })()
    const response = await post({ stream: true })
    const body = await response.text()
    expect(body).toContain('response.failed')
    expect(advancedAfterFailure).toBe(0)
    expect(cleanupCalls).toBe(1)
  })

  test('rejects newly returned tools that only exist in history', async () => {
    getCachedConfig().responsesChatCompletionsFallback = true
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse({
      ...chatResult,
      choices: [{ index: 0, finish_reason: 'tool_calls', logprobs: null, message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'new-call', type: 'function', function: { name: 'retired', arguments: '{}' } }],
      } }],
    }, calls)
    const response = await post({ input: [
      { type: 'function_call', call_id: 'old-call', name: 'retired', arguments: '{}' },
      { type: 'function_call_output', call_id: 'old-call', output: 'done' },
      { role: 'user', content: 'Answer without using tools.' },
    ] })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.tools ?? []).toHaveLength(0)
    expect(response.status).toBe(502)
  })

  test('round-trips a forced custom text tool through public ingress', async () => {
    getCachedConfig().responsesChatCompletionsFallback = true
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse({
      ...chatResult,
      choices: [{ index: 0, finish_reason: 'tool_calls', logprobs: null, message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'write-call', type: 'function', function: { name: 'write_note', arguments: '{"input":"note"}' } }],
      } }],
    }, calls)
    const response = await post({
      tools: [{ type: 'custom', name: 'write_note', format: { type: 'text' } }],
      tool_choice: { type: 'custom', name: 'write_note' },
    })
    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tool_choice).toEqual({ type: 'function', function: { name: 'write_note' } })
    expect(await response.json()).toMatchObject({ output: [{ type: 'custom_tool_call', name: 'write_note', input: 'note' }] })
  })

  test('accepts the enabled function-shaped apply_patch shim through public ingress', async () => {
    getCachedConfig().responsesChatCompletionsFallback = true
    getCachedConfig().useFunctionApplyPatch = true
    const calls: Array<CapturedChatCall> = []
    CopilotClient.prototype.createChatCompletions = mockNonStreamingResponse({
      ...chatResult,
      choices: [{ index: 0, finish_reason: 'tool_calls', logprobs: null, message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'patch-call',
          type: 'function',
          function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' },
        }],
      } }],
    }, calls)

    const response = await post({
      tools: [{ type: 'custom', name: 'apply_patch' }],
      tool_choice: { type: 'function', name: 'apply_patch' },
    })

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tool_choice).toEqual({ type: 'function', function: { name: 'apply_patch' } })
    expect(await response.json()).toMatchObject({
      output: [{ type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' }],
    })
  })
})
