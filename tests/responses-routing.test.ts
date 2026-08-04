import type { CapturedCreateResponseInputTokensCall, CapturedDeleteResponseCall, CapturedGetResponseCall, CapturedGetResponseInputItemsCall, CapturedResponsesCall } from './helpers'
import type { ResponsesPayload } from '~/types'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { TerminalUpstreamRecoveryError } from '~/clients/upstream-queue'
import { getCachedConfig } from '~/lib/config'
import { HTTPError } from '~/lib/error'
import { PATHS } from '~/lib/paths'
import { createResponsesPassthroughStrategy } from '~/routes/responses/strategy'
import { authStore, modelCache, runtimeStore } from '~/state'

import { buildModel, buildModelsResponse, buildResponsesResult, buildVisionModel, createApp, mockCreateResponseInputTokens, mockDeleteResponse, mockGetResponse, mockGetResponseInputItems, mockResponses, restoreStateSnapshot, saveStateSnapshot, setupDefaultTestState } from './helpers'

const originalCreateResponses = CopilotClient.prototype.createResponses
const originalCreateMessages = CopilotClient.prototype.createMessages
const originalCreateChatCompletions = CopilotClient.prototype.createChatCompletions
const originalGetResponse = CopilotClient.prototype.getResponse
const originalGetResponseInputItems = CopilotClient.prototype.getResponseInputItems
const originalCreateResponseInputTokens = CopilotClient.prototype.createResponseInputTokens
const originalDeleteResponse = CopilotClient.prototype.deleteResponse
const stateSnapshot = saveStateSnapshot()
const originalConfig = structuredClone(getCachedConfig())

beforeEach(() => {
  setupDefaultTestState()
  authStore.showToken = false
  authStore.upstreamTimeoutSeconds = undefined

  const config = getCachedConfig()
  for (const key of Object.keys(config)) {
    delete (config as Record<string, unknown>)[key]
  }
})

afterEach(() => {
  CopilotClient.prototype.createResponses = originalCreateResponses
  CopilotClient.prototype.createMessages = originalCreateMessages
  CopilotClient.prototype.createChatCompletions = originalCreateChatCompletions
  CopilotClient.prototype.getResponse = originalGetResponse
  CopilotClient.prototype.getResponseInputItems = originalGetResponseInputItems
  CopilotClient.prototype.createResponseInputTokens = originalCreateResponseInputTokens
  CopilotClient.prototype.deleteResponse = originalDeleteResponse
  restoreStateSnapshot(stateSnapshot)
  setSystemTime()

  const config = getCachedConfig()
  for (const key of Object.keys(config)) {
    delete (config as Record<string, unknown>)[key]
  }
  Object.assign(config, structuredClone(originalConfig))
})

describe('responses and routing', () => {
  test('/v1/responses uses one compatible overload target and discloses it', async () => {
    const calls: Array<CapturedResponsesCall> = []
    const target = buildModel('target', { supported_endpoints: ['/responses'] })
    target.capabilities.supports.structured_outputs = false
    modelCache.cacheModels(buildModelsResponse(
      buildModel('source', { supported_endpoints: ['/responses'] }),
      target,
    ))
    getCachedConfig().overloadFallbacks = { source: 'target' }
    CopilotClient.prototype.createResponses = (async (payload, options) => {
      calls.push({ payload, options })
      if (calls.length === 1) {
        throw new TerminalUpstreamRecoveryError(
          new HTTPError(529, {
            error: { message: 'source overloaded', type: 'overloaded_error' },
          }),
          { requestId: 'responses-fallback', retryCount: 1, sourceModel: 'source' },
        )
      }
      return buildResponsesResult({ model: 'source', status: 'completed' })
    }) as typeof CopilotClient.prototype.createResponses

    const response = await createApp().handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        text: { format: { type: 'text' } },
      }),
    }))
    const body = await response.json() as { model: string }

    expect(response.status).toBe(200)
    expect(calls.map(call => call.payload.model)).toEqual(['source', 'target'])
    expect(body.model).toBe('target')
  })

  test('/v1/responses preserves source 529 when target lacks a requested capability', async () => {
    const source = buildModel('source', { supported_endpoints: ['/responses'] })
    const target = buildModel('target', { supported_endpoints: ['/responses'] })
    target.capabilities.supports.tool_calls = false
    modelCache.cacheModels(buildModelsResponse(source, target))
    getCachedConfig().overloadFallbacks = { source: 'target' }
    let calls = 0
    CopilotClient.prototype.createResponses = (async () => {
      calls++
      throw new TerminalUpstreamRecoveryError(
        new HTTPError(529, {
          error: { message: 'source overloaded', type: 'overloaded_error' },
        }, { headers: { 'retry-after': '4' } }),
        { requestId: 'responses-rejected', retryCount: 1, sourceModel: 'source' },
      )
    }) as typeof CopilotClient.prototype.createResponses

    const response = await createApp().handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      }),
    }))

    expect(response.status).toBe(529)
    expect(response.headers.get('retry-after')).toBe('4')
    expect(calls).toBe(1)
  })

  test('/v1/responses transforms apply_patch before forwarding', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [
          { type: 'custom', name: 'apply_patch' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools).toHaveLength(1)
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
      type: 'function',
      name: 'apply_patch',
      strict: false,
    })
  })

  test('/v1/responses defaults function tool strict to true', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [
          {
            type: 'function',
            name: 'get_weather',
            parameters: { type: 'object' },
          },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
      type: 'function',
      name: 'get_weather',
      strict: true,
    })
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
      parameters: {
        type: 'object',
        required: [],
      },
    })
  })

  test('/v1/responses normalizes function parameter required arrays for Copilot', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [
          {
            type: 'function',
            name: 'Bash',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string' },
                timeout: { type: 'number' },
              },
              required: ['command'],
            },
          },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
      type: 'function',
      name: 'Bash',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          timeout: { type: 'number' },
        },
        required: ['command', 'timeout'],
      },
      strict: true,
    })
  })

  test('/v1/responses strips unsupported JSON Schema format annotations from function tools', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_1',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [{
          type: 'function',
          name: 'WebFetch',
          parameters: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                format: 'uri',
              },
            },
            required: ['url'],
          },
        }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
      type: 'function',
      name: 'WebFetch',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: {
            type: 'string',
          },
        },
        required: ['url'],
      },
    })
    expect(JSON.stringify(calls[0]?.payload.tools?.[0])).not.toContain('"format"')
  })

  test('/v1/responses strips upstream-incompatible schema metadata from function tools', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_1',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [{
          type: 'function',
          name: 'WebFetch',
          parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
              url: {
                type: 'string',
                title: 'URL',
                description: 'Fetch target',
                example: 'https://example.com',
                examples: ['https://example.com'],
                default: 'https://example.com',
                deprecated: false,
                readOnly: false,
                writeOnly: false,
                contentEncoding: 'utf-8',
                contentMediaType: 'text/plain',
              },
            },
          },
        }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
      type: 'function',
      name: 'WebFetch',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: {
            type: 'string',
            description: 'Fetch target',
          },
        },
        required: ['url'],
      },
    })

    const serialized = JSON.stringify(calls[0]?.payload.tools?.[0])
    expect(serialized).not.toContain('"$schema"')
    expect(serialized).not.toContain('"title"')
    expect(serialized).not.toContain('"example"')
    expect(serialized).not.toContain('"examples"')
    expect(serialized).not.toContain('"default"')
    expect(serialized).not.toContain('"deprecated"')
    expect(serialized).not.toContain('"readOnly"')
    expect(serialized).not.toContain('"writeOnly"')
    expect(serialized).not.toContain('"contentEncoding"')
    expect(serialized).not.toContain('"contentMediaType"')
  })

  test('/v1/responses adds additionalProperties false and derives required for nested object tool schemas', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_1',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [{
          type: 'function',
          name: 'plugin--nowledge-mem--nowledge_mem_search',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              options: {
                type: 'object',
                properties: {
                  limit: { type: 'integer' },
                },
              },
            },
          },
        }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.tools?.[0]).toMatchObject({
      type: 'function',
      name: 'plugin--nowledge-mem--nowledge_mem_search',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          options: {
            type: 'object',
            additionalProperties: false,
            properties: {
              limit: { type: 'integer' },
            },
            required: ['limit'],
          },
        },
        required: ['query', 'options'],
      },
    })
  })

  test('/v1/responses does not auto-inject context_management by default', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    const config = getCachedConfig()
    config.responsesApiContextManagementModels = ['gpt-4.1']
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.context_management).toBeUndefined()
  })

  test('/v1/responses auto-injects context_management only when explicitly enabled', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    const config = getCachedConfig()
    config.responsesApiAutoContextManagement = true
    config.responsesApiContextManagementModels = ['gpt-4.1']
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', {
      supported_endpoints: ['/responses'],
      capabilities: {
        family: 'gpt',
        limits: {
          max_context_window_tokens: 200000,
          max_output_tokens: 8192,
          max_prompt_tokens: 120000,
        },
        object: 'model_capabilities',
        supports: {
          tool_calls: true,
          parallel_tool_calls: true,
          adaptive_thinking: true,
        },
        tokenizer: 'o200k_base',
        type: 'chat',
      },
    })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.context_management).toEqual([{
      type: 'compaction',
      compact_threshold: 108000,
    }])
  })

  test('/v1/responses does not compact input by latest compaction by default', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: 'before' },
          { type: 'compaction', id: 'cmp_1', encrypted_content: 'enc_1' },
          { type: 'message', role: 'user', content: 'after' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'before' },
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'enc_1' },
      { type: 'message', role: 'user', content: 'after' },
    ])
  })

  test('/v1/responses compacts input by latest compaction only when explicitly enabled', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    const config = getCachedConfig()
    config.responsesApiAutoCompactInput = true
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: 'before' },
          { type: 'compaction', id: 'cmp_1', encrypted_content: 'enc_1' },
          { type: 'message', role: 'user', content: 'after' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.input).toEqual([
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'enc_1' },
      { type: 'message', role: 'user', content: 'after' },
    ])
  })

  test('/v1/responses rejects unsupported builtin tools explicitly', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_unused',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
      output: [],
      output_text: '',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [
          { type: 'web_search', name: 'web_search_preview' },
        ],
      }),
    }))

    const json = await response.json() as {
      error?: { code?: string, param?: string }
    }
    expect(response.status).toBe(400)
    expect(json.error?.code).toBe('unsupported_tool_web_search')
    expect(json.error?.param).toBe('tools')
    expect(calls).toHaveLength(0)
  })

  test('/v1/responses rejects unsupported web_search tool_choice explicitly', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_unused',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
      output: [],
      output_text: '',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tool_choice: { type: 'web_search_preview' },
      }),
    }))

    const json = await response.json() as {
      error?: { code?: string, param?: string }
    }
    expect(response.status).toBe(400)
    expect(json.error?.code).toBe('unsupported_tool_web_search')
    expect(json.error?.param).toBe('tool_choice')
    expect(calls).toHaveLength(0)
  })

  test('/v1/responses rejects external image URLs explicitly', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildVisionModel('gpt-5', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_unused',
      object: 'response',
      created_at: 1,
      model: 'gpt-5',
      output: [],
      output_text: '',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe this image' },
            { type: 'input_image', image_url: 'https://example.com/image.png', detail: 'low' },
          ],
        }],
      }),
    }))

    const json = await response.json() as {
      error?: { code?: string, param?: string }
    }
    expect(response.status).toBe(400)
    expect(json.error?.code).toBe('unsupported_input_image_remote_url')
    expect(json.error?.param).toBe('input')
    expect(calls).toHaveLength(0)
  })

  test('/v1/responses validates payload shape before mutation', async () => {
    const app = createApp()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: '',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(400)
  })

  test('/v1/responses forces store=false on all upstream requests', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_store',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    // Client sends store=true, but the proxy must override to false
    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        store: true,
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.store).toBe(false)
  })

  test('/v1/responses forces store=false even when client omits it', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_store_default',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.store).toBe(false)
  })

  test('/v1/responses strips item_reference items from input', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_strip_ref',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: 'hello' },
          { type: 'item_reference', id: 'msg_fake_ref_001' },
          { type: 'item_reference', id: 'msg_fake_ref_002' },
          { type: 'message', role: 'user', content: 'follow up' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'user', content: 'follow up' },
    ])
  })

  test('/v1/responses strips orphaned function_call_output items from input', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_strip_orphan',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: 'hello' },
          // This function_call has a matching output — both should survive
          { type: 'function_call', call_id: 'call_1', name: 'test', arguments: '{}', status: 'completed' },
          { type: 'function_call_output', call_id: 'call_1', output: 'result 1' },
          // This output has no matching function_call — should be stripped
          { type: 'function_call_output', call_id: 'call_orphan', output: 'orphan result' },
          { type: 'message', role: 'user', content: 'continue' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'function_call', call_id: 'call_1', name: 'test', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result 1' },
      { type: 'message', role: 'user', content: 'continue' },
    ])
  })

  test('/v1/responses strips both item_reference and orphaned function_call_output together', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_strip_combo',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: 'hello' },
          { type: 'item_reference', id: 'msg_ref_1' },
          { type: 'function_call_output', call_id: 'call_gone', output: 'stale' },
          { type: 'message', role: 'user', content: 'continue' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'user', content: 'continue' },
    ])
  })

  test('/v1/responses strips phase field from input message items', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_strip_phase',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: 'hello', phase: 'commentary' },
          { type: 'message', role: 'assistant', content: 'hi', phase: 'final_answer' },
          { type: 'message', role: 'user', content: 'follow up' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    const forwardedInput = calls[0]?.payload.input as Array<Record<string, unknown>>
    expect(forwardedInput).toHaveLength(3)
    // phase should be stripped from all items that had it
    for (const item of forwardedInput) {
      expect(item).not.toHaveProperty('phase')
    }
    // Other fields should be preserved
    expect(forwardedInput[0]).toMatchObject({ type: 'message', role: 'user', content: 'hello' })
    expect(forwardedInput[1]).toMatchObject({ type: 'message', role: 'assistant', content: 'hi' })
    expect(forwardedInput[2]).toMatchObject({ type: 'message', role: 'user', content: 'follow up' })
  })

  test('/v1/responses preserves input when no stripping is needed', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_no_strip',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: 'hello' },
          { type: 'function_call', call_id: 'call_1', name: 'test', arguments: '{}', status: 'completed' },
          { type: 'function_call_output', call_id: 'call_1', output: 'result' },
          { type: 'message', role: 'user', content: 'next' },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'function_call', call_id: 'call_1', name: 'test', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
      { type: 'message', role: 'user', content: 'next' },
    ])
  })

  test('/v1/responses accepts image content in function call output', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(buildResponsesResult({
      id: 'resp_function_output_image',
      model: 'gpt-4.1',
      status: 'completed',
      usage: null,
    }), calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'function_call', call_id: 'call_1', name: 'view_image', arguments: '{}', status: 'completed' },
          { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_image', detail: 'original' }] },
        ],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.input).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'view_image', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_image', detail: 'original' }] },
    ])
  })

  test('/v1/responses surfaces upstream 400 errors without requiring payload dumps', async () => {
    const app = createApp()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    // Mock createResponses to throw HTTPError(400) so the route still surfaces
    // the upstream error when failed payload dumps are disabled by default.
    CopilotClient.prototype.createResponses = (() => {
      throw new HTTPError(400, {
        error: { message: 'Invalid request', type: 'invalid_request_error' },
      })
    }) as typeof CopilotClient.prototype.createResponses

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(400)
    const json = await response.json() as { error?: { message?: string } }
    expect(json.error?.message).toBe('Invalid request')
  })

  test('/v1/responses consumes subagent markers and forwards root session context', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-4.1', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
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

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': 'root-session-1',
      },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{
          type: 'message',
          role: 'user',
          content: `<system-reminder>\nSubagentStart hook additional context: __SUBAGENT_MARKER__{"session_id":"subagent-session-1","agent_id":"subagent-session-1","agent_type":"opencode-subagent"}\n</system-reminder>\nhello`,
        }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options?.initiator).toBe('agent')
    expect(calls[0]?.options?.requestContext).toMatchObject({
      interactionType: 'conversation-subagent',
      agentTaskId: 'subagent-session-1',
      clientSessionId: 'root-session-1',
    })
    expect(calls[0]?.payload.input).toEqual([{
      type: 'message',
      role: 'user',
      content: 'hello',
    }])
  })

  test('/v1/responses supports retrieve/input_items/delete/input_tokens operations', async () => {
    const app = createApp()
    const inputItemsCalls: Array<CapturedGetResponseInputItemsCall> = []
    const inputTokensCalls: Array<CapturedCreateResponseInputTokensCall> = []
    const getCalls: Array<CapturedGetResponseCall> = []
    const deleteCalls: Array<CapturedDeleteResponseCall> = []

    CopilotClient.prototype.getResponseInputItems = mockGetResponseInputItems({
      object: 'list',
      data: [{ type: 'message', role: 'user', content: 'hello' }],
      has_more: false,
    }, inputItemsCalls)
    CopilotClient.prototype.createResponseInputTokens = mockCreateResponseInputTokens({
      object: 'response.input_tokens',
      input_tokens: 12,
    }, inputTokensCalls)
    CopilotClient.prototype.getResponse = mockGetResponse({
      id: 'resp_123',
      object: 'response',
      status: 'completed',
      model: 'gpt-5',
      created_at: 1,
      output: [],
      output_text: '',
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
    }, getCalls)
    CopilotClient.prototype.deleteResponse = mockDeleteResponse({
      id: 'resp_123',
      object: 'response.deleted',
      deleted: true,
    }, deleteCalls)

    const inputItemsResponse = await app.handle(new Request('http://localhost/v1/responses/resp_123/input_items?limit=2&order=desc&include=reasoning.encrypted_content,file_search_call.results', {
      method: 'GET',
    }))
    expect(inputItemsResponse.status).toBe(200)
    expect(inputItemsCalls[0]).toEqual({
      responseId: 'resp_123',
      params: {
        include: ['reasoning.encrypted_content', 'file_search_call.results'],
        limit: 2,
        order: 'desc',
        after: undefined,
      },
    })

    const getResponse = await app.handle(new Request('http://localhost/v1/responses/resp_123?include=reasoning.encrypted_content&include_obfuscation=true&starting_after=3&stream=false', {
      method: 'GET',
    }))
    expect(getResponse.status).toBe(200)
    expect(getCalls[0]).toEqual({
      responseId: 'resp_123',
      params: {
        include: ['reasoning.encrypted_content'],
        include_obfuscation: true,
        starting_after: 3,
        stream: false,
      },
    })

    const inputTokensResponse = await app.handle(new Request('http://localhost/v1/responses/input_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))
    expect(inputTokensResponse.status).toBe(200)
    expect(inputTokensCalls[0]?.payload).toMatchObject({
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    })

    const deleteResponse = await app.handle(new Request('http://localhost/v1/responses/resp_123', {
      method: 'DELETE',
    }))
    expect(deleteResponse.status).toBe(200)
    expect(deleteCalls[0]).toEqual({
      responseId: 'resp_123',
    })
  })

  test('/v1/responses resource validation rejects invalid query parameters', async () => {
    const app = createApp()

    const limitResponse = await app.handle(new Request('http://localhost/v1/responses/resp_123/input_items?limit=0', {
      method: 'GET',
    }))
    expect(limitResponse.status).toBe(400)

    const orderResponse = await app.handle(new Request('http://localhost/v1/responses/resp_123/input_items?order=sideways', {
      method: 'GET',
    }))
    expect(orderResponse.status).toBe(400)

    const startingAfterResponse = await app.handle(new Request('http://localhost/v1/responses/resp_123?starting_after=-1', {
      method: 'GET',
    }))
    expect(startingAfterResponse.status).toBe(400)

    const booleanResponse = await app.handle(new Request('http://localhost/v1/responses/resp_123?stream=maybe', {
      method: 'GET',
    }))
    expect(booleanResponse.status).toBe(400)
  })
})

const payload: ResponsesPayload = {
  model: 'gpt-4.1',
  input: [{ type: 'message', role: 'user', content: 'secret prompt' }],
}

function createRejectingClient(error: HTTPError): CopilotClient {
  return {
    createResponses() {
      throw error
    },
  } as unknown as CopilotClient
}

function createStrategy(error: HTTPError) {
  return createResponsesPassthroughStrategy(createRejectingClient(error), payload, {
    vision: false,
    initiator: 'user',
    requestContext: {},
    signal: new AbortController().signal,
  })
}

async function withDumpEnvironment<T>(
  dumpFailedPayloads: boolean,
  run: (dumpDir: string) => Promise<T>,
): Promise<T> {
  const previousAppDir = PATHS.APP_DIR
  const previousDumpFailedPayloads = runtimeStore.dumpFailedPayloads
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghc-proxy-responses-dump-'))
  const dumpDir = path.join(tempDir, 'dumps')

  PATHS.APP_DIR = tempDir
  runtimeStore.dumpFailedPayloads = dumpFailedPayloads

  try {
    return await run(dumpDir)
  }
  finally {
    PATHS.APP_DIR = previousAppDir
    runtimeStore.dumpFailedPayloads = previousDumpFailedPayloads
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

async function listDumps(dumpDir: string): Promise<Array<string>> {
  try {
    return await fs.readdir(dumpDir)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

async function waitForDumps(dumpDir: string, expectedCount: number): Promise<Array<string>> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const dumps = await listDumps(dumpDir)
    if (dumps.length === expectedCount) {
      return dumps
    }
    await Bun.sleep(25)
  }
  return listDumps(dumpDir)
}

describe('responses failed payload dumps', () => {
  test('does not dump upstream 400 payloads by default', async () => {
    await withDumpEnvironment(false, async (dumpDir) => {
      const error = new HTTPError(400, {
        error: { message: 'Invalid request', type: 'invalid_request_error' },
      })
      const strategy = createStrategy(error)

      await expect(strategy.execute()).rejects.toBe(error)
      expect(await waitForDumps(dumpDir, 0)).toEqual([])
    })
  })

  test('dumps upstream 400 payloads when explicitly enabled', async () => {
    await withDumpEnvironment(true, async (dumpDir) => {
      const error = new HTTPError(400, {
        error: { message: 'Invalid request', type: 'invalid_request_error' },
      })
      const strategy = createStrategy(error)

      await expect(strategy.execute()).rejects.toBe(error)

      const dumps = await waitForDumps(dumpDir, 1)
      expect(dumps).toHaveLength(1)
      expect(dumps[0]?.startsWith('400-')).toBe(true)

      const dump = JSON.parse(await fs.readFile(path.join(dumpDir, dumps[0]!), 'utf8')) as {
        error: { status: number, message: string }
        payload: ResponsesPayload
      }
      expect(dump.error).toEqual({ status: 400, message: 'Invalid request' })
      expect(dump.payload).toEqual(payload)
    })
  })

  test('does not dump non-400 upstream errors even when enabled', async () => {
    await withDumpEnvironment(true, async (dumpDir) => {
      const error = new HTTPError(429, {
        error: { message: 'Rate limited', type: 'rate_limit_error' },
      })
      const strategy = createStrategy(error)

      await expect(strategy.execute()).rejects.toBe(error)
      expect(await waitForDumps(dumpDir, 0)).toEqual([])
    })
  })
})

// This route forwards the caller's own vocabulary, so leaving effort alone
// looks defensible in isolation — but afterTransform already strips
// temperature/top_p and raises a below-minimum max_output_tokens, so effort was
// the one parameter where the proxy knew a request would 400 and sent it anyway.
describe('POST /v1/responses clamps reasoning.effort to the advertised set', () => {
  function cacheModelWithEfforts(efforts: Array<string>) {
    const model = buildModel('gpt-5.5', { supported_endpoints: ['/responses'] })
    model.capabilities.supports.reasoning_effort = efforts
    modelCache.cacheModels(buildModelsResponse(model))
  }

  async function sendEffort(effort: string, calls: Array<CapturedResponsesCall>) {
    CopilotClient.prototype.createResponses = mockResponses(
      buildResponsesResult({ id: 'resp_1', status: 'completed', output: [], output_text: '' }),
      calls,
    )

    return createApp().handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: [{ type: 'message', role: 'user', content: 'hi' }],
        reasoning: { effort },
      }),
    }))
  }

  test('lowers an unadvertised effort to the highest advertised level', async () => {
    // gpt-5.5 shape: advertises up to xhigh, rejects max (probed 2026-07-26).
    cacheModelWithEfforts(['none', 'low', 'medium', 'high', 'xhigh'])
    const calls: Array<CapturedResponsesCall> = []

    const response = await sendEffort('max', calls)

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.reasoning?.effort).toBe('xhigh')
  })

  test('leaves an advertised effort untouched', async () => {
    cacheModelWithEfforts(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    const calls: Array<CapturedResponsesCall> = []

    await sendEffort('max', calls)

    expect(calls[0]?.payload.reasoning?.effort).toBe('max')
  })

  test('passes none through rather than ranking it', async () => {
    // Clamping `none` upward would invert the caller's intent — they asked for
    // no reasoning and would get the model's maximum.
    cacheModelWithEfforts(['low', 'medium', 'high', 'max'])
    const calls: Array<CapturedResponsesCall> = []

    await sendEffort('none', calls)

    expect(calls[0]?.payload.reasoning?.effort).toBe('none')
  })
})
