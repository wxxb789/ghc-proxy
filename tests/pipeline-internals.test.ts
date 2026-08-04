import type { StateSnapshot } from './helpers'
import type { StrategyEntry } from '~/dispatch'
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { IngestContext, PipelineConfig, TransformContext } from '~/pipeline/runner'

import type { Model } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { StrategyRegistry } from '~/dispatch'
import { getCachedConfig } from '~/lib/config'
import { runPipeline } from '~/pipeline/runner'
import { modelCache } from '~/state'

import {
  buildModel,
  buildModelsResponse,
  clearConfig,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

// ── StrategyRegistry — selection priority + messages registry wiring ──

describe('StrategyRegistry', () => {
  function makeEntry<TCtx = unknown>(
    name: string,
    canHandle: (model: Model | undefined) => boolean,
  ): StrategyEntry<TCtx> {
    return {
      name,
      canHandle,
      execute: () => Promise.resolve({ kind: 'json', data: {} } as ExecutionResult),
    }
  }

  test('throws on empty registry', () => {
    const registry = new StrategyRegistry()
    expect(() => registry.select(undefined)).toThrow('StrategyRegistry has no registered entries')
  })

  test('single entry with canHandle returning true', () => {
    const registry = new StrategyRegistry()
    const entry = makeEntry('only', () => true)
    registry.register(entry)
    expect(registry.select(undefined)).toBe(entry)
  })

  test('multi-entry priority — selects first matching', () => {
    const registry = new StrategyRegistry()
    const first = makeEntry('first', () => false)
    const second = makeEntry('second', () => true)
    const third = makeEntry('third', () => true)
    registry.register(first)
    registry.register(second)
    registry.register(third)

    expect(registry.select(undefined)).toBe(second)
  })

  test('falls back to last entry when none match', () => {
    const registry = new StrategyRegistry()
    const first = makeEntry('first', () => false)
    const second = makeEntry('second', () => false)
    registry.register(first)
    registry.register(second)

    expect(registry.select(undefined)).toBe(second)
  })

  test('canHandle receives model parameter correctly', () => {
    const registry = new StrategyRegistry()
    let receivedModel: Model | undefined

    const entry = makeEntry('spy', (model) => {
      receivedModel = model
      return true
    })
    registry.register(entry)

    const testModel = buildModel('test-model-123')
    registry.select(testModel)

    expect(receivedModel).toBe(testModel)
  })

  test('canHandle receives undefined when no model', () => {
    const registry = new StrategyRegistry()
    let receivedModel: Model | undefined = buildModel('placeholder')

    const entry = makeEntry('spy', (model) => {
      receivedModel = model
      return true
    })
    registry.register(entry)

    registry.select(undefined)
    expect(receivedModel).toBeUndefined()
  })
})

describe('messages defaultStrategyRegistry', () => {
  let snapshot: StateSnapshot

  beforeEach(() => {
    snapshot = saveStateSnapshot()
  })

  afterEach(() => {
    restoreStateSnapshot(snapshot)
  })

  test('selects native-messages for model with /v1/messages endpoint', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const nativeModel = buildModel('claude-sonnet-4', {
      supported_endpoints: ['/v1/messages'],
    })
    modelCache.cacheModels(buildModelsResponse(nativeModel))

    const selected = defaultStrategyRegistry.select(nativeModel)
    expect(selected.name).toBe('native-messages')
  })

  test('selects responses-api for model with /responses endpoint', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const responsesModel = buildModel('claude-sonnet-4.5', {
      supported_endpoints: ['/responses'],
    })
    modelCache.cacheModels(buildModelsResponse(responsesModel))

    const selected = defaultStrategyRegistry.select(responsesModel)
    expect(selected.name).toBe('responses-api')
  })

  test('selects chat-completions as fallback for model with no supported endpoints', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const basicModel = buildModel('gpt-5.4')
    modelCache.cacheModels(buildModelsResponse(basicModel))

    const selected = defaultStrategyRegistry.select(basicModel)
    expect(selected.name).toBe('chat-completions')
  })

  test('selects chat-completions when model is undefined', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const selected = defaultStrategyRegistry.select(undefined)
    expect(selected.name).toBe('chat-completions')
  })

  test('native-messages takes priority over responses-api when both endpoints supported', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const dualModel = buildModel('claude-sonnet-4', {
      supported_endpoints: ['/v1/messages', '/responses'],
    })
    modelCache.cacheModels(buildModelsResponse(dualModel))

    const selected = defaultStrategyRegistry.select(dualModel)
    expect(selected.name).toBe('native-messages')
  })
})

// ── runPipeline — ingest → transform → dispatch orchestration ──

describe('runPipeline', () => {
  const originalState = saveStateSnapshot()

  beforeEach(() => {
    setupDefaultTestState()
    clearConfig()
  })

  afterEach(() => {
    restoreStateSnapshot(originalState)
    clearConfig()
  })

  interface SimplePayload {
    model: string
    messages: Array<{ role: string, content: string }>
  }

  function makeStrategyRegistry(
    result: ExecutionResult = { kind: 'json', data: { ok: true } },
  ): StrategyRegistry<{ payload: SimplePayload }> {
    const registry = new StrategyRegistry<{ payload: SimplePayload }>()
    registry.register({
      name: 'test-strategy',
      canHandle: () => true,
      execute: async () => result,
    })
    return registry
  }

  function makeParams(body: SimplePayload): {
    body: SimplePayload
    signal: AbortSignal
    headers: Headers
    requestId: string
    callerRequestId?: string
  } {
    return {
      body,
      signal: new AbortController().signal,
      headers: new Headers({ 'content-type': 'application/json' }),
      requestId: 'internal-request-id',
    }
  }

  function makeConfig(
    overrides: Partial<PipelineConfig<SimplePayload, { payload: SimplePayload }>> = {},
  ): PipelineConfig<SimplePayload, { payload: SimplePayload }> {
    return {
      protocol: 'openai-chat',
      strategyRegistry: makeStrategyRegistry(),
      buildStrategyContext: ({ payload }) => ({ payload }),
      ...overrides,
    }
  }

  test('basic pipeline flow returns json result', async () => {
    const expectedData = { response: 'hello' }
    const strategyRegistry = new StrategyRegistry<{ payload: SimplePayload }>()
    strategyRegistry.register({
      name: 'json-strategy',
      canHandle: () => true,
      execute: async () => ({ kind: 'json' as const, data: expectedData }),
    })

    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] })
    const config = makeConfig({
      strategyRegistry,
    })

    const { result, modelMapping } = await runPipeline(params, config)

    expect(result.kind).toBe('json')
    expect((result as { kind: 'json', data: unknown }).data).toEqual(expectedData)
    expect(modelMapping.originalModel).toBe('claude-sonnet-4.5')
  })

  test('model rewrite is reflected in model mapping trace', async () => {
    // Drives the real rewrite via config rather than a stand-in chain, so the
    // trace assertion covers the production resolveRequestModel wiring.
    const config_ = getCachedConfig() as Record<string, unknown>
    config_.modelRewrites = [{ from: 'old-model', to: 'new-model' }]
    modelCache.cacheModels(buildModelsResponse(buildModel('new-model')))

    const params = makeParams({ model: 'old-model', messages: [{ role: 'user', content: 'hi' }] })

    const executedPayloads: SimplePayload[] = []
    const strategyRegistry = new StrategyRegistry<{ payload: SimplePayload }>()
    strategyRegistry.register({
      name: 'capture-strategy',
      canHandle: () => true,
      execute: async (ctx) => {
        executedPayloads.push(ctx.payload)
        return { kind: 'json', data: { ok: true } }
      },
    })

    const config = makeConfig({
      strategyRegistry,
    })

    const { modelMapping } = await runPipeline(params, config)

    expect(modelMapping.originalModel).toBe('old-model')
    expect(modelMapping.steps).toHaveLength(1)
    expect(modelMapping.steps[0]).toEqual({ tag: 'CONFIG_REWRITE', from: 'old-model', to: 'new-model' })
    // The strategy should receive the rewritten model in the payload
    expect(executedPayloads[0]?.model).toBe('new-model')
  })

  test('afterIngest hook is called with ingest result', async () => {
    const captured: IngestContext<SimplePayload>[] = []
    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'test' }] })

    const config = makeConfig({
      afterIngest: (ctx) => {
        captured.push(ctx)
        return ctx.payload
      },
    })

    await runPipeline(params, config)

    expect(captured).toHaveLength(1)
    expect(captured[0]!.payload.model).toBe('claude-sonnet-4.5')
    expect(captured[0]!.payload.messages[0]?.content).toBe('test')
    expect(captured[0]!.headers).toBeInstanceOf(Headers)
  })

  test('afterIngest returned payload replaces the payload for transform + dispatch', async () => {
    const executedPayloads: SimplePayload[] = []
    const strategyRegistry = new StrategyRegistry<{ payload: SimplePayload }>()
    strategyRegistry.register({
      name: 'capture-strategy',
      canHandle: () => true,
      execute: async (ctx) => {
        executedPayloads.push(ctx.payload)
        return { kind: 'json', data: { ok: true } }
      },
    })

    const replacement: SimplePayload = {
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'REPLACED' }],
    }
    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'original' }] })
    const config = makeConfig({
      strategyRegistry,
      // Mirrors /responses returning the emulator's upstream payload.
      afterIngest: () => replacement,
    })

    await runPipeline(params, config)

    // The replacement payload — not the ingested one — reaches the strategy.
    expect(executedPayloads[0]?.messages[0]?.content).toBe('REPLACED')
  })

  test('afterIngest returning ctx.payload keeps the ingested payload (no-substitution case)', async () => {
    const executedPayloads: SimplePayload[] = []
    const strategyRegistry = new StrategyRegistry<{ payload: SimplePayload }>()
    strategyRegistry.register({
      name: 'capture-strategy',
      canHandle: () => true,
      execute: async (ctx) => {
        executedPayloads.push(ctx.payload)
        return { kind: 'json', data: { ok: true } }
      },
    })

    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'original' }] })
    const config = makeConfig({
      strategyRegistry,
      // Side-effect-only callers (messages, chat-completions) end with this.
      afterIngest: ({ payload }) => payload,
    })

    await runPipeline(params, config)

    expect(executedPayloads[0]?.messages[0]?.content).toBe('original')
  })

  test('afterTransform hook observes the resolved model', async () => {
    const captured: TransformContext<SimplePayload>[] = []
    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'test' }] })

    const config_ = getCachedConfig() as Record<string, unknown>
    config_.modelRewrites = [{ from: 'claude-sonnet-4.5', to: 'claude-opus-4.6' }]
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-opus-4.6')))

    const config = makeConfig({
      afterTransform: (ctx) => {
        captured.push(ctx)
      },
    })

    await runPipeline(params, config)

    expect(captured).toHaveLength(1)
    // The hook runs after model resolution, so it sees the rewritten model
    // on both the payload and the resolved model record.
    expect(captured[0]!.payload.model).toBe('claude-opus-4.6')
    expect(captured[0]!.selectedModel?.id).toBe('claude-opus-4.6')
  })

  test('afterTransform hook can mutate payload', async () => {
    const executedPayloads: SimplePayload[] = []
    const strategyRegistry = new StrategyRegistry<{ payload: SimplePayload }>()
    strategyRegistry.register({
      name: 'capture-strategy',
      canHandle: () => true,
      execute: async (ctx) => {
        executedPayloads.push(ctx.payload)
        return { kind: 'json', data: { ok: true } }
      },
    })

    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'original' }] })
    const config = makeConfig({
      strategyRegistry,
      afterTransform: (ctx) => {
        ctx.payload.messages = [{ role: 'user', content: 'mutated' }]
      },
    })

    await runPipeline(params, config)

    expect(executedPayloads[0]!.messages[0]?.content).toBe('mutated')
  })

  test('model mapping shows original model when no transforms apply', async () => {
    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] })
    const config = makeConfig()

    const { modelMapping } = await runPipeline(params, config)

    expect(modelMapping.originalModel).toBe('claude-sonnet-4.5')
    expect(modelMapping.steps).toHaveLength(0)
  })

  test('stream result kind is propagated', async () => {
    async function* fakeSSE() {
      yield { data: '{"event":"done"}' }
    }

    const strategyRegistry = new StrategyRegistry<{ payload: SimplePayload }>()
    strategyRegistry.register({
      name: 'stream-strategy',
      canHandle: () => true,
      execute: async (): Promise<ExecutionResult> => ({
        kind: 'stream',
        generator: fakeSSE(),
      }),
    })

    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] })
    const config = makeConfig({ strategyRegistry })

    const { result } = await runPipeline(params, config)

    expect(result.kind).toBe('stream')
  })

  test('buildStrategyContext receives all expected fields', async () => {
    let capturedCtx: Record<string, unknown> | undefined
    const strategyRegistry = new StrategyRegistry<Record<string, unknown>>()
    strategyRegistry.register({
      name: 'spy-strategy',
      canHandle: () => true,
      execute: async () => ({ kind: 'json' as const, data: {} }),
    })

    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] })
    const config: PipelineConfig<SimplePayload, Record<string, unknown>> = {
      protocol: 'openai-chat',
      strategyRegistry,
      buildStrategyContext: (ctx) => {
        capturedCtx = ctx as Record<string, unknown>
        return ctx
      },
    }

    await runPipeline(params, config)

    expect(capturedCtx).toBeDefined()
    expect(capturedCtx!.payload).toBeDefined()
    expect(capturedCtx!.meta).toBeDefined()
    expect(capturedCtx!.headers).toBeInstanceOf(Headers)
    expect(capturedCtx!.copilotClient).toBeDefined()
    expect(capturedCtx!.upstreamSignal).toBeDefined()
    expect(capturedCtx!.modelMapping).toBeDefined()
    expect(capturedCtx!.recovery).toEqual({
      requestId: 'internal-request-id',
      retryCount: 0,
    })
    expect(capturedCtx!.recovery).not.toHaveProperty('deadlineMonotonicMs')
  })

  test('keeps caller correlation separate from the internal recovery id', async () => {
    let capturedCtx: Record<string, unknown> | undefined
    const params = {
      ...makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] }),
      requestId: 'internal-unique-id',
      callerRequestId: 'caller-reused-id',
    }
    const config = makeConfig({
      buildStrategyContext: (ctx) => {
        capturedCtx = ctx as Record<string, unknown>
        return { payload: ctx.payload }
      },
    })

    await runPipeline(params, config)

    expect(capturedCtx!.recovery).toEqual({
      requestId: 'internal-unique-id',
      callerRequestId: 'caller-reused-id',
      retryCount: 0,
    })
  })
})
