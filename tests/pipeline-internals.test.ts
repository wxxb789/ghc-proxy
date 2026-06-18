import type { StateSnapshot } from './helpers'
import type { StrategyEntry } from '~/dispatch'
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { IngestContext, PipelineConfig, TransformContext } from '~/pipeline/runner'

import type { ModelTransformChain } from '~/transform'
import type { ModelTransformStep } from '~/transform/types'
import type { Model } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { StrategyRegistry } from '~/dispatch'
import { runPipeline } from '~/pipeline/runner'
import { modelCache } from '~/state'

import { composeModelTransforms } from '~/transform/chain'
import {
  buildModel,
  buildModelsResponse,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

// ── composeModelTransforms — model transform chain ──

describe('composeModelTransforms', () => {
  function makeStep(
    tag: string,
    applyFn: ModelTransformStep['apply'],
  ): ModelTransformStep {
    return { tag, apply: applyFn }
  }

  function noopStep(tag: string): ModelTransformStep {
    return makeStep(tag, () => null)
  }

  function rewriteStep(tag: string, toModel: string): ModelTransformStep {
    return makeStep(tag, () => ({ model: toModel, tag }))
  }

  let snapshot: StateSnapshot

  beforeEach(() => {
    snapshot = saveStateSnapshot()
    modelCache.cacheModels(buildModelsResponse(
      buildModel('model-a'),
      buildModel('model-b'),
      buildModel('model-c'),
      buildModel('model-final'),
    ))
  })

  afterEach(() => {
    restoreStateSnapshot(snapshot)
  })

  test('empty steps — returns original model with empty trace', () => {
    const chain = composeModelTransforms()
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.model).toBe('model-a')
    expect(result.trace).toEqual([])
  })

  test('single step that returns null (no-op) — model unchanged', () => {
    const chain = composeModelTransforms(noopStep('noop'))
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.model).toBe('model-a')
    expect(result.trace).toEqual([])
  })

  test('single step with transform — model changed, trace has one entry', () => {
    const chain = composeModelTransforms(rewriteStep('rewrite', 'model-b'))
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.model).toBe('model-b')
    expect(result.trace).toEqual([
      { tag: 'rewrite', from: 'model-a', to: 'model-b' },
    ])
  })

  test('multi-step chain — correct final model and trace order', () => {
    const chain = composeModelTransforms(
      rewriteStep('step-1', 'model-b'),
      rewriteStep('step-2', 'model-c'),
      rewriteStep('step-3', 'model-final'),
    )
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.model).toBe('model-final')
    expect(result.trace).toEqual([
      { tag: 'step-1', from: 'model-a', to: 'model-b' },
      { tag: 'step-2', from: 'model-b', to: 'model-c' },
      { tag: 'step-3', from: 'model-c', to: 'model-final' },
    ])
  })

  test('mutatePayload callback is invoked', () => {
    const step = makeStep('mutator', () => ({
      model: 'model-a',
      tag: 'mutator',
      mutatePayload: (payload: unknown) => {
        (payload as Record<string, unknown>).mutated = true
      },
    }))

    const payload: Record<string, unknown> = { mutated: false }
    const chain = composeModelTransforms(step)
    chain.apply({ model: 'model-a', payload })

    expect(payload.mutated).toBe(true)
  })

  test('resolvedModel is looked up from modelCache when not set by steps', () => {
    const chain = composeModelTransforms(noopStep('noop'))
    const result = chain.apply({ model: 'model-b', payload: {} })

    expect(result.resolvedModel).toBeDefined()
    expect(result.resolvedModel?.id).toBe('model-b')
  })

  test('resolvedModel from step overrides modelCache lookup', () => {
    const customModel = buildModel('custom-resolved')
    const step = makeStep('resolver', () => ({
      model: 'model-b',
      tag: 'resolver',
      resolvedModel: customModel,
    }))

    const chain = composeModelTransforms(step)
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.resolvedModel).toBe(customModel)
  })

  test('resolvedModel falls back to modelCache.findById for final model', () => {
    const chain = composeModelTransforms(rewriteStep('rewrite', 'model-c'))
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.resolvedModel).toBeDefined()
    expect(result.resolvedModel?.id).toBe('model-c')
  })

  test('resolvedModel is undefined when final model is not in cache', () => {
    const chain = composeModelTransforms(rewriteStep('rewrite', 'unknown-model'))
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.resolvedModel).toBeUndefined()
  })

  test('mixed no-op and transform steps — only transforms appear in trace', () => {
    const chain = composeModelTransforms(
      noopStep('skip-1'),
      rewriteStep('apply', 'model-b'),
      noopStep('skip-2'),
    )
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.model).toBe('model-b')
    expect(result.trace).toEqual([
      { tag: 'apply', from: 'model-a', to: 'model-b' },
    ])
  })

  test('step receives current model after previous transforms', () => {
    const receivedModels: string[] = []

    const spyStep = (tag: string, toModel: string): ModelTransformStep =>
      makeStep(tag, (input) => {
        receivedModels.push(input.model)
        return { model: toModel, tag }
      })

    const chain = composeModelTransforms(
      spyStep('s1', 'model-b'),
      spyStep('s2', 'model-c'),
    )
    chain.apply({ model: 'model-a', payload: {} })

    expect(receivedModels).toEqual(['model-a', 'model-b'])
  })
})

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
  })

  afterEach(() => {
    restoreStateSnapshot(originalState)
  })

  function noopTransformChain(): ModelTransformChain {
    return {
      apply: input => ({
        model: input.model,
        resolvedModel: undefined,
        trace: [],
      }),
    }
  }

  function rewriteTransformChain(fromModel: string, toModel: string): ModelTransformChain {
    return {
      apply: (input) => {
        if (input.model === fromModel) {
          return {
            model: toModel,
            resolvedModel: undefined,
            trace: [{ tag: 'CONFIG_REWRITE', from: fromModel, to: toModel }],
          }
        }
        return { model: input.model, resolvedModel: undefined, trace: [] }
      },
    }
  }

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

  function makeParams(body: SimplePayload): { body: SimplePayload, signal: AbortSignal, headers: Headers } {
    return {
      body,
      signal: new AbortController().signal,
      headers: new Headers({ 'content-type': 'application/json' }),
    }
  }

  function makeConfig(
    overrides: Partial<PipelineConfig<SimplePayload, { payload: SimplePayload }>> = {},
  ): PipelineConfig<SimplePayload, { payload: SimplePayload }> {
    return {
      protocol: 'openai-chat',
      transformChain: noopTransformChain(),
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

  test('transform chain rewrite is reflected in model mapping trace', async () => {
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
      transformChain: rewriteTransformChain('old-model', 'new-model'),
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

  test('afterTransform hook is called with transform result', async () => {
    const captured: TransformContext<SimplePayload>[] = []
    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'test' }] })

    const config = makeConfig({
      transformChain: rewriteTransformChain('claude-sonnet-4.5', 'claude-opus-4.6'),
      afterTransform: (ctx) => {
        captured.push(ctx)
      },
    })

    await runPipeline(params, config)

    expect(captured).toHaveLength(1)
    expect(captured[0]!.transformResult.model).toBe('claude-opus-4.6')
    expect(captured[0]!.transformResult.trace).toHaveLength(1)
    expect(captured[0]!.payload.model).toBe('claude-opus-4.6')
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
      transformChain: noopTransformChain(),
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
  })
})
